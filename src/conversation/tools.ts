import type { Questionnaire } from "../screening/schema.js";
import type { ScreeningState, StepResult } from "../screening/state.js";
import type { EligibilityStatus } from "../screening/eligibility.js";

/** Tool declaration in the Gemini Interactions API shape. */
export interface FunctionToolDecl {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type EndReason = "completed" | "declined" | "wrong_person" | "not_now" | "no_response" | "voicemail" | "other";

export interface ToolOutcome {
  /** JSON payload returned to the model as the function result. */
  payload: Record<string, unknown>;
  isError?: boolean;
  /** Set when the tool asks the session to end the call after the model's closing words. */
  end?: { reason: EndReason; note?: string };
}

export const TOOL_DECLARATIONS: FunctionToolDecl[] = [
  {
    type: "function",
    name: "confirm_identity",
    description:
      "Record whether you reached the intended person. Call it as soon as you know: 'confirmed' when they confirm their name, 'wrong_person' when it is someone else and the person is not available, 'unavailable' when the person exists but cannot come to the phone now.",
    parameters: {
      type: "object",
      properties: { result: { type: "string", enum: ["confirmed", "wrong_person", "unavailable"] } },
      required: ["result"],
    },
  },
  {
    type: "function",
    name: "record_consent",
    description:
      "Record whether the person agreed to go through the screening questions now (and, when recording is on, whether they are okay with the call being recorded). Call this right after they answer; screening questions unlock only after consent.",
    parameters: {
      type: "object",
      properties: {
        proceed: { type: "boolean", description: "true if they agreed to do the questions now" },
        recording_ok: { type: "boolean", description: "true if they accepted recording; omit when recording is off" },
      },
      required: ["proceed"],
    },
  },
  {
    type: "function",
    name: "record_answer",
    description:
      "Save the person's answer to one screening question the moment it is clear. Pass the normalized value (true/false for yes-no, a number for numeric, an option string for choices, short text otherwise) and their own words in verbatim. The result tells you exactly what to ask next; if it reports an error, clarify with the person instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        question_id: { type: "string" },
        value: { description: "Normalized answer: boolean, number, string, or array of strings for multi-choice" },
        verbatim: { type: "string", description: "What the person actually said, briefly" },
      },
      required: ["question_id", "value"],
    },
  },
  {
    type: "function",
    name: "skip_question",
    description: "Mark a question as skipped when the person declines to answer it or it cannot be answered. Prefer one gentle retry first for required questions.",
    parameters: {
      type: "object",
      properties: { question_id: { type: "string" }, reason: { type: "string" } },
      required: ["question_id", "reason"],
    },
  },
  {
    type: "function",
    name: "request_callback",
    description: "The person asked to be called at another time. Record when, in their words, then wrap up warmly and call end_call with reason 'not_now'.",
    parameters: { type: "object", properties: { when: { type: "string" } }, required: ["when"] },
  },
  {
    type: "function",
    name: "flag_for_human",
    description: "Leave a note for the study team when something needs a person: a question you cannot answer, a complaint, a request to be removed from the list, distress, or anything unusual.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  {
    type: "function",
    name: "end_call",
    description:
      "Finish the call. Say your closing words in the same reply, then call this. Reasons: 'completed' after the screening is done, 'declined' if they do not want to take part, 'wrong_person', 'not_now' after a callback request, 'no_response' after repeated silence, 'voicemail' if you are clearly talking to an answering machine, otherwise 'other'.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["completed", "declined", "wrong_person", "not_now", "no_response", "voicemail", "other"] },
        note: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

export interface ToolContext {
  recordingEnabled: boolean;
}

/** What was true when the person's current utterance arrived; used to tell real answers from invented ones. */
export interface TurnSnapshot {
  stage: ScreeningState["stage"];
  identity: ScreeningState["identity"];
  pendingQuestionId: string | null;
  /** Assistant replies spoken before this utterance. */
  assistantReplies: number;
  kind: "speech" | "system";
}

export interface HandleContext {
  /** The model asked a question in the same reply as this tool call. */
  roundEndsWithQuestion: boolean;
}

const PREMATURE =
  "You asked a question in this same reply, and the answer you tried to record is not something the person has said yet. Only record answers to the question that was already asked before their latest reply. Say nothing more now; wait for their reply.";

function closingGuidance(q: Questionnaire, status: EligibilityStatus, failed: string[]): string {
  switch (status) {
    case "eligible":
      return `They appear to qualify. Tell them warmly that ${q.study.next_steps_if_eligible}. If you have not already, ask when is a good time to reach them, then say goodbye and call end_call('completed').`;
    case "ineligible": {
      const why = q.settings.reveal_reason_when_ineligible && failed.length ? ` You may say it comes down to the question about ${failed.join(" and ").replace(/_/g, " ")}.` : " Do not say which answer ruled them out.";
      return `They do not match the current criteria. Thank them sincerely, say this study is not the right fit right now, and that the team may reach out if a suitable study opens.${why} Then say goodbye and call end_call('completed').`;
    }
    case "undetermined":
      return `Some answers are missing, so eligibility is undetermined. Thank them, say the study team will review and follow up, say goodbye, and call end_call('completed').`;
  }
}

/**
 * Executes tool calls against the screening state. Every result carries the
 * next question and progress so the model always knows what to do next.
 */
export class ToolHandlers {
  private snapshot: TurnSnapshot | undefined;
  private assistantReplies = 0;

  constructor(
    private readonly state: ScreeningState,
    private readonly q: Questionnaire,
    private readonly ctx: ToolContext,
  ) {}

  /** Called by the engine when a new user utterance (or system note) starts a model turn. */
  beginUserTurn(kind: "speech" | "system"): void {
    this.snapshot = {
      stage: this.state.stage,
      identity: this.state.identity,
      pendingQuestionId: this.state.nextQuestion()?.id ?? null,
      assistantReplies: this.assistantReplies,
      kind,
    };
  }

  /** Called by the engine after the assistant spoke in a turn. */
  noteAssistantReply(): void {
    this.assistantReplies++;
  }

  /**
   * A recording tool called in a reply that also asks a question is fine only
   * when it records the answer to the question that was pending before the
   * person spoke. Anything else means the model is answering for the person.
   */
  private isPrematureRecording(name: string, args: Record<string, unknown>): boolean {
    const snap = this.snapshot;
    if (!snap || snap.kind !== "speech") return true;
    switch (name) {
      case "confirm_identity":
        return snap.assistantReplies === 0 || snap.identity !== "unknown";
      case "record_consent":
        return snap.stage !== "consent";
      case "record_answer":
        return snap.stage !== "screening" || String(args.question_id ?? "") !== snap.pendingQuestionId;
      default:
        return false;
    }
  }

  handle(name: string, args: Record<string, unknown>, hctx: HandleContext = { roundEndsWithQuestion: false }): ToolOutcome & { premature?: boolean } {
    if (hctx.roundEndsWithQuestion && (name === "confirm_identity" || name === "record_consent" || name === "record_answer") && this.isPrematureRecording(name, args)) {
      return { payload: { ok: false, error: PREMATURE }, isError: true, premature: true };
    }
    switch (name) {
      case "confirm_identity":
        return this.confirmIdentity(String(args.result ?? ""));
      case "record_consent":
        return this.recordConsent(args.proceed === true, typeof args.recording_ok === "boolean" ? args.recording_ok : undefined);
      case "record_answer":
        return this.recordAnswer(String(args.question_id ?? ""), args.value, typeof args.verbatim === "string" ? args.verbatim : undefined);
      case "skip_question":
        return this.skipQuestion(String(args.question_id ?? ""), String(args.reason ?? ""));
      case "request_callback":
        return this.requestCallback(String(args.when ?? ""));
      case "flag_for_human":
        return this.flag(String(args.note ?? ""));
      case "end_call":
        return this.endCall(String(args.reason ?? "other") as EndReason, typeof args.note === "string" ? args.note : undefined);
      default:
        return { payload: { ok: false, error: `Unknown tool ${name}` }, isError: true };
    }
  }

  private withProgress(step: StepResult): Record<string, unknown> {
    const out: Record<string, unknown> = { ok: step.ok, message: step.message, remaining: step.remaining };
    if (step.next_question) out.next_question = step.next_question;
    if (step.screening_complete) {
      const elig = this.state.eligibility();
      out.screening_complete = true;
      out.outcome = elig.status;
      out.closing_guidance = closingGuidance(this.q, elig.status, elig.failed);
      if (step.next_question) out.note = "One optional question remains; ask it before closing if the person is not in a hurry.";
    }
    return out;
  }

  private confirmIdentity(result: string): ToolOutcome {
    if (result !== "confirmed" && result !== "wrong_person" && result !== "unavailable") {
      return { payload: { ok: false, error: "result must be confirmed, wrong_person, or unavailable" }, isError: true };
    }
    this.state.identity = result;
    if (result === "confirmed") {
      this.state.stage = "consent";
      const rec = this.ctx.recordingEnabled ? " Recording is on: mention the call is recorded for quality before asking if now is a good time." : "";
      return { payload: { ok: true, message: `Identity confirmed. Now briefly say why you are calling and ask if they have a few minutes for the screening questions.${rec}` } };
    }
    this.state.stage = "closing";
    const msg =
      result === "wrong_person"
        ? "Apologize briefly for the mix-up, do not share any study details, say goodbye, then call end_call('wrong_person')."
        : `Ask when would be a better time to reach them, note it with request_callback, then call end_call('not_now').`;
    return { payload: { ok: true, message: msg } };
  }

  private recordConsent(proceed: boolean, recordingOk: boolean | undefined): ToolOutcome {
    if (this.state.identity !== "confirmed") {
      return { payload: { ok: false, error: "Confirm you are speaking with the right person first (confirm_identity)." }, isError: true };
    }
    this.state.consentToProceed = proceed;
    if (recordingOk !== undefined) this.state.recordingConsent = recordingOk;
    if (this.ctx.recordingEnabled && recordingOk === false) {
      this.state.stage = "closing";
      return { payload: { ok: true, message: "They declined recording. Thank them, explain the team can call back without recording, then call end_call('declined')." } };
    }
    if (!proceed) {
      this.state.stage = "closing";
      return { payload: { ok: true, message: "They do not want to proceed now. Offer a callback at a better time (request_callback), or thank them and call end_call('declined') if they are not interested at all." } };
    }
    this.state.stage = "screening";
    const next = this.state.nextQuestion();
    return {
      payload: {
        ok: true,
        message: `Consent recorded. Start the screening questions now. There are ${this.state.remaining()} questions; ask them one at a time.`,
        next_question: next,
        remaining: this.state.remaining(),
      },
    };
  }

  private recordAnswer(questionId: string, value: unknown, verbatim: string | undefined): ToolOutcome {
    if (this.state.stage !== "screening") {
      return { payload: { ok: false, error: "Screening has not started. Confirm identity and consent first." }, isError: true };
    }
    const step = this.state.recordAnswer(questionId, value, verbatim);
    if (!step.ok) return { payload: { ok: false, error: step.message, next_question: step.next_question }, isError: true };
    if (step.screening_complete) this.state.stage = "closing";
    return { payload: this.withProgress(step) };
  }

  private skipQuestion(questionId: string, reason: string): ToolOutcome {
    if (this.state.stage !== "screening") {
      return { payload: { ok: false, error: "Screening has not started." }, isError: true };
    }
    const step = this.state.skipQuestion(questionId, reason);
    if (!step.ok) return { payload: { ok: false, error: step.message }, isError: true };
    if (step.screening_complete) this.state.stage = "closing";
    return { payload: this.withProgress(step) };
  }

  private requestCallback(when: string): ToolOutcome {
    this.state.callbackRequested = when.trim() || "unspecified";
    this.state.stage = "closing";
    return { payload: { ok: true, message: "Callback noted. Thank them, confirm the team will call back then, say goodbye, and call end_call('not_now')." } };
  }

  private flag(note: string): ToolOutcome {
    this.state.flags.push(note.trim());
    return { payload: { ok: true, message: "Noted for the study team." } };
  }

  private endCall(reason: EndReason, note: string | undefined): ToolOutcome {
    this.state.endReason = reason;
    this.state.endNote = note;
    this.state.stage = "ended";
    return { payload: { ok: true, message: "The call will end after your current words. Do not ask anything else." }, end: { reason, note } };
  }
}
