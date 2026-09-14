import type { FlatQuestion, Questionnaire } from "./schema.js";
import { flattenQuestions } from "./schema.js";
import { evaluateEligibility, isApplicable, type EligibilityResult } from "./eligibility.js";
import { validateAnswer, type AnswerValue } from "./validate.js";

export type Stage = "opening" | "identity" | "consent" | "screening" | "closing" | "ended";
export type IdentityResult = "unknown" | "confirmed" | "wrong_person" | "unavailable";

export interface RecordedAnswer {
  value: AnswerValue;
  verbatim?: string;
  recordedAt: string;
}

export interface NextQuestion {
  id: string;
  guidance: string;
  position: number;
  total: number;
}

export interface StepResult {
  ok: boolean;
  message: string;
  next_question: NextQuestion | null;
  remaining: number;
  screening_complete: boolean;
  outcome?: EligibilityResult["status"];
}

/**
 * Server-side truth for one screening conversation: what has been established,
 * what to ask next, and whether the person is eligible. The model only ever
 * sees the guidance strings produced here.
 */
export class ScreeningState {
  readonly questions: FlatQuestion[];
  readonly answers = new Map<string, RecordedAnswer>();
  readonly skipped = new Map<string, string>();
  stage: Stage = "opening";
  identity: IdentityResult = "unknown";
  consentToProceed: boolean | undefined;
  recordingConsent: boolean | undefined;
  callbackRequested: string | undefined;
  readonly flags: string[] = [];
  endReason: string | undefined;
  endNote: string | undefined;

  constructor(readonly questionnaire: Questionnaire) {
    this.questions = flattenQuestions(questionnaire);
  }

  private answerValues(): Map<string, AnswerValue> {
    return new Map([...this.answers].map(([id, a]) => [id, a.value]));
  }

  applicableQuestions(): FlatQuestion[] {
    const values = this.answerValues();
    return this.questions.filter((q) => isApplicable(q, values));
  }

  eligibility(): EligibilityResult {
    return evaluateEligibility(this.questionnaire, this.answerValues(), new Set(this.skipped.keys()));
  }

  /** True once every applicable required question is answered or explicitly skipped. */
  isScreeningComplete(): boolean {
    if (this.questionnaire.settings.stop_on_disqualify && this.eligibility().status === "ineligible") return true;
    return this.applicableQuestions().every((q) => !q.required || this.answers.has(q.id) || this.skipped.has(q.id));
  }

  remaining(): number {
    return this.applicableQuestions().filter((q) => !this.answers.has(q.id) && !this.skipped.has(q.id)).length;
  }

  nextQuestion(): NextQuestion | null {
    if (this.questionnaire.settings.stop_on_disqualify && this.eligibility().status === "ineligible") return null;
    const applicable = this.applicableQuestions();
    const idx = applicable.findIndex((q) => !this.answers.has(q.id) && !this.skipped.has(q.id));
    if (idx === -1) return null;
    const q = applicable[idx]!;
    return { id: q.id, guidance: guidanceFor(q), position: idx + 1, total: applicable.length };
  }

  findQuestion(id: string): FlatQuestion | undefined {
    return this.questions.find((q) => q.id === id);
  }

  recordAnswer(id: string, raw: unknown, verbatim?: string): StepResult {
    const q = this.findQuestion(id);
    if (!q) return this.result(false, `Unknown question id "${id}". Use one of: ${this.questions.map((x) => x.id).join(", ")}.`);
    if (!isApplicable(q, this.answerValues())) {
      return this.result(false, `"${id}" does not apply to this person; do not ask it.`);
    }
    const v = validateAnswer(q, raw);
    if (!v.ok) return this.result(false, v.error);
    this.answers.set(id, { value: v.value, verbatim: verbatim?.trim() || undefined, recordedAt: new Date().toISOString() });
    this.skipped.delete(id);
    return this.result(true, `Recorded ${id}.`);
  }

  skipQuestion(id: string, reason: string): StepResult {
    const q = this.findQuestion(id);
    if (!q) return this.result(false, `Unknown question id "${id}".`);
    if (this.answers.has(id)) return this.result(false, `"${id}" already has an answer; nothing to skip.`);
    this.skipped.set(id, reason.trim() || "declined");
    return this.result(true, `Skipped ${id}.`);
  }

  private result(ok: boolean, message: string): StepResult {
    const next = this.nextQuestion();
    const complete = this.isScreeningComplete();
    const res: StepResult = { ok, message, next_question: next, remaining: this.remaining(), screening_complete: complete };
    if (complete) res.outcome = this.eligibility().status;
    return res;
  }
}

/** One or two sentences telling the model what to find out and what shape the answer must take. */
export function guidanceFor(q: FlatQuestion): string {
  const parts = [q.ask.trim().replace(/\.?$/, ".")];
  switch (q.type) {
    case "yes_no":
      parts.push("Record true or false.");
      break;
    case "integer":
    case "number":
      parts.push(`Record a number${q.unit ? ` in ${q.unit}` : ""}.`);
      break;
    case "single_choice":
      parts.push(`Record exactly one of: ${(q.options ?? []).join(", ")}.`);
      break;
    case "multi_choice":
      parts.push(`Record one or more of: ${(q.options ?? []).join(", ")}.`);
      break;
    case "date":
      parts.push("Record the date as YYYY-MM-DD.");
      break;
    case "free_text":
      parts.push("Record a short summary in their words.");
      break;
  }
  if (!q.required) parts.push("Optional: if they would rather not say, skip it and move on.");
  if (q.sensitive) parts.push("Sensitive topic: ask matter-of-factly, without commentary, and accept a decline gracefully.");
  return parts.join(" ");
}
