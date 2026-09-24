import type { Logger } from "../logger.js";
import type { Questionnaire } from "../screening/schema.js";
import { ScreeningState } from "../screening/state.js";
import { formatAnswerForCsv } from "../screening/validate.js";
import type { CallOutcome, CallRecord, EligibleFlag } from "../storage/csv.js";
import type { CallStore } from "../storage/store.js";
import { newTranscript, type Transcript } from "../storage/transcripts.js";
import { ConversationEngine } from "./engine.js";
import type { LlmAdapter } from "./llm.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DECLARATIONS, ToolHandlers, type EndReason } from "./tools.js";
import type { InboundEvents, Transport } from "./transport.js";

export interface SessionContact {
  contactId: string;
  phone: string;
  firstName: string;
  attempt?: number;
}

export interface SessionTimers {
  /** How long to wait for the person's first words before the assistant opens. */
  firstUtteranceMs: number;
  /** Silence after the assistant finishes speaking before a nudge. */
  silenceMs: number;
  /** Ceiling on how long to wait for playback before hanging up after end_call. */
  maxEndGraceMs: number;
}

export interface SessionDeps {
  callSid: string;
  contact: SessionContact;
  questionnaire: Questionnaire;
  llm: LlmAdapter;
  transport: Transport;
  log: Logger;
  recordingEnabled: boolean;
  /** Where the transcript and result row go; undefined disables persistence (text harness). */
  store?: CallStore;
  timers?: Partial<SessionTimers>;
  onFinished?(record: CallRecord, transcript: Transcript): void;
}

export const DEFAULT_TIMERS: SessionTimers = { firstUtteranceMs: 2500, silenceMs: 7000, maxEndGraceMs: 12000 };

const VOICEMAIL_RE = /(leave (a|your) (message|name)|after the (tone|beep)|not available (right now|at the moment)|can'?t (come|get) to the phone|cannot take your call|you('ve| have) reached|voice ?mail|mailbox)/i;

/** Rough speech duration for text at conversational pace, used to time silence and hang-ups. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.6) * 1000) + 600;
}

/**
 * One phone call: wires the transport events to the engine, owns the timers
 * that make the pacing feel human (waiting for "hello", nudging on silence,
 * letting the goodbye finish before hanging up) and persists the result.
 */
export class CallSession implements InboundEvents {
  readonly state: ScreeningState;
  readonly engine: ConversationEngine;
  readonly transcript: Transcript;
  private readonly timers: SessionTimers;
  private readonly startedAtMs = Date.now();
  private firstUtteranceTimer: NodeJS.Timeout | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;
  private maxDurationTimer: NodeJS.Timeout | undefined;
  private endTimer: NodeJS.Timeout | undefined;
  private silenceStrikes = 0;
  private awaitingFirstUtterance = true;
  private ending = false;
  private finalized: Promise<void> | undefined;
  private lastAssistantText = "";
  private endReasonOverride: CallOutcome | undefined;
  recordingSid = "";

  constructor(private readonly deps: SessionDeps) {
    this.timers = { ...DEFAULT_TIMERS, ...deps.timers };
    this.state = new ScreeningState(deps.questionnaire);
    this.transcript = newTranscript({ callSid: deps.callSid, contactId: deps.contact.contactId, phone: deps.contact.phone });
    const toolHandlers = new ToolHandlers(this.state, deps.questionnaire, { recordingEnabled: deps.recordingEnabled });
    this.engine = new ConversationEngine({
      system: buildSystemPrompt(deps.questionnaire, { firstName: deps.contact.firstName, recordingEnabled: deps.recordingEnabled }),
      tools: TOOL_DECLARATIONS,
      toolHandlers,
      llm: deps.llm,
      transport: deps.transport,
      transcript: this.transcript,
      log: deps.log,
      onEndRequested: (end) => this.scheduleEnd(end.reason),
    });
  }

  /** Call once the media session is up (ConversationRelay `setup`). */
  start(): void {
    this.state.stage = "opening";
    this.firstUtteranceTimer = setTimeout(() => {
      if (!this.awaitingFirstUtterance) return;
      this.awaitingFirstUtterance = false;
      void this.runTurn("[call connected; the person has not said anything yet; open the call]", "system");
    }, this.timers.firstUtteranceMs);
    const maxMs = this.deps.questionnaire.settings.max_call_minutes * 60_000;
    this.maxDurationTimer = setTimeout(() => {
      void this.runTurn("[time limit reached; apologize briefly, say the team will follow up, say goodbye, and call end_call with reason other]", "system");
      this.endTimer = setTimeout(() => this.forceEnd("failed"), 60_000);
    }, maxMs);
  }

  onPrompt(text: string, last: boolean): void {
    if (!last) return;
    const spoken = text.trim();
    if (!spoken) return;
    this.resetSilence();
    if (this.awaitingFirstUtterance) {
      this.awaitingFirstUtterance = false;
      if (this.firstUtteranceTimer) clearTimeout(this.firstUtteranceTimer);
      if (VOICEMAIL_RE.test(spoken)) {
        this.deps.log.info({ spoken }, "first utterance looks like voicemail; staying quiet");
        this.transcript.turns.push({ role: "person", text: spoken, at: new Date().toISOString() });
        this.transcript.notes.push("voicemail greeting detected from first utterance");
        this.endReasonOverride = "voicemail";
        this.scheduleEnd("voicemail", 0);
        return;
      }
    }
    void this.runTurn(spoken, "speech");
  }

  onInterrupt(utteranceUntilInterrupt: string, durationMs?: number): void {
    this.resetSilence();
    this.transcript.relayEvents.push({ at: new Date().toISOString(), type: "interrupt", data: { utteranceUntilInterrupt, durationMs } });
    this.engine.interrupt(utteranceUntilInterrupt);
  }

  onDtmf(digit: string): void {
    this.transcript.relayEvents.push({ at: new Date().toISOString(), type: "dtmf", data: { digit } });
    void this.runTurn(`[the person pressed the ${digit} key on their phone]`, "system");
  }

  onTokensPlayed(data: unknown): void {
    this.transcript.relayEvents.push({ at: new Date().toISOString(), type: "tokens-played", data });
    const d = data as { last?: boolean } | undefined;
    if (this.ending && d?.last === true && this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.forceEnd(), 300);
    }
  }

  /** A transport that knows when playback truly ended (browser) re-arms the silence timer precisely. */
  notifyPlaybackDone(): void {
    if (this.ending || this.engine.hasEnded || this.engine.isBusy) return;
    this.clearSilenceTimer();
    this.armSilenceTimer(0);
  }

  onError(description: string): void {
    this.deps.log.warn({ description }, "relay error");
    this.transcript.relayEvents.push({ at: new Date().toISOString(), type: "error", data: description });
  }

  /** The media session went away (hang-up, network, or our own end). */
  onClose(): void {
    this.ending = true;
    this.clearAllTimers();
    void this.finalize();
  }

  private async runTurn(text: string, kind: "speech" | "system"): Promise<void> {
    if (this.engine.hasEnded || this.ending) return;
    const promptAt = new Date().toISOString();
    const stats = await this.engine.handleUserInput(text, kind);
    this.transcript.metrics.push({ promptAt, firstTokenMs: stats.firstTokenMs, lastTokenMs: stats.lastTokenMs, toolCalls: stats.toolCalls });
    if (stats.text) this.lastAssistantText = stats.text;
    if (!this.engine.hasEnded && !stats.aborted && !this.ending) this.armSilenceTimer();
  }

  private armSilenceTimer(playbackRemainingMs?: number): void {
    if (this.ending || this.finalized) return;
    this.clearSilenceTimer();
    const wait = (playbackRemainingMs ?? estimateSpeechMs(this.lastAssistantText)) + this.timers.silenceMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceStrikes++;
      const note =
        this.silenceStrikes === 1
          ? "[silence: no reply for 7 seconds; give them a moment with a gentle prompt or a simpler rephrase]"
          : this.silenceStrikes === 2
            ? "[still no reply; ask whether they are still there]"
            : "[no reply after three attempts; say goodbye and call end_call with reason no_response]";
      void this.runTurn(note, "system").then(() => {
        if (this.silenceStrikes >= 3 && !this.engine.hasEnded) this.scheduleEnd("no_response");
      });
    }, wait);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  /** The person spoke: silence escalation starts over. */
  private resetSilence(): void {
    this.clearSilenceTimer();
    this.silenceStrikes = 0;
  }

  private clearAllTimers(): void {
    for (const t of [this.firstUtteranceTimer, this.silenceTimer, this.maxDurationTimer, this.endTimer]) if (t) clearTimeout(t);
  }

  /** Let the goodbye finish playing, then end the media session. */
  private scheduleEnd(reason: EndReason, graceOverrideMs?: number): void {
    if (this.ending) return;
    this.ending = true;
    this.clearSilenceTimer();
    const grace = graceOverrideMs ?? Math.min(this.timers.maxEndGraceMs, Math.max(1500, estimateSpeechMs(this.lastAssistantText) + 800));
    this.deps.log.info({ reason, graceMs: grace }, "ending call after playback");
    this.endTimer = setTimeout(() => this.forceEnd(), grace);
  }

  private forceEnd(outcome?: CallOutcome): void {
    if (outcome) this.endReasonOverride = outcome;
    this.ending = true;
    this.clearAllTimers();
    try {
      this.deps.transport.end({ reason: this.state.endReason ?? this.endReasonOverride ?? "ended" });
    } catch (err) {
      this.deps.log.warn({ err }, "transport.end failed");
    }
    void this.finalize();
  }

  /** Answering-machine detection fired mid-call: Twilio is redirecting the call to the voicemail message. */
  markVoicemail(): void {
    this.endReasonOverride = "voicemail";
    this.transcript.notes.push("answering machine detected (AMD)");
    this.ending = true;
    this.clearAllTimers();
  }

  outcome(): CallOutcome {
    if (this.endReasonOverride) return this.endReasonOverride;
    const answered = this.state.answers.size > 0;
    const complete = this.state.stage !== "opening" && this.state.isScreeningComplete();
    switch (this.state.endReason) {
      case "completed":
        return complete ? "completed" : "partial";
      case "declined":
        return "declined";
      case "wrong_person":
        return "wrong_person";
      case "not_now":
        return "callback_requested";
      case "voicemail":
        return "voicemail";
      case "no_response":
        return answered ? "partial" : "no_response";
      case "other":
        return answered ? "partial" : "failed";
      default:
        // The line dropped before the assistant ended the call.
        if (complete) return "completed";
        return answered ? "partial" : "hung_up";
    }
  }

  eligibleFlag(): EligibleFlag {
    const s = this.state.eligibility().status;
    return s === "eligible" ? "yes" : s === "ineligible" ? "no" : "undetermined";
  }

  buildRecord(transcriptPath: string): CallRecord {
    const endedAt = new Date().toISOString();
    const answers: Record<string, string> = {};
    const verbatim: Record<string, string> = {};
    for (const [id, a] of this.state.answers) {
      answers[id] = formatAnswerForCsv(a.value);
      if (a.verbatim) verbatim[id] = a.verbatim;
    }
    for (const [id, reason] of this.state.skipped) answers[id] = `(skipped: ${reason})`;
    const bmi = this.state.bmi();
    if (bmi !== undefined) answers.bmi = String(bmi);
    const notes = [...this.state.flags.map((f) => `flag: ${f}`), ...this.transcript.notes];
    if (this.state.endNote) notes.push(`end note: ${this.state.endNote}`);
    return {
      contact_id: this.deps.contact.contactId,
      phone: this.deps.contact.phone,
      call_sid: this.deps.callSid,
      attempt: this.deps.contact.attempt ?? 1,
      started_at: this.transcript.startedAt,
      ended_at: endedAt,
      duration_s: Math.round((Date.now() - this.startedAtMs) / 1000),
      outcome: this.outcome(),
      eligible: this.eligibleFlag(),
      answers,
      verbatim,
      callback_when: this.state.callbackRequested ?? "",
      notes: notes.join(" | "),
      transcript_path: transcriptPath,
      recording_sid: this.recordingSid,
    };
  }

  /** Persist once, no matter how many close/end signals arrive. */
  finalize(): Promise<void> {
    if (!this.finalized) this.finalized = this.doFinalize();
    return this.finalized;
  }

  private async doFinalize(): Promise<void> {
    this.clearAllTimers();
    this.transcript.endedAt = new Date().toISOString();
    this.transcript.outcome = this.outcome();
    this.transcript.eligible = this.eligibleFlag();
    let transcriptPath = "";
    try {
      if (this.deps.store) transcriptPath = await this.deps.store.saveTranscript(this.transcript);
    } catch (err) {
      this.deps.log.error({ err }, "failed to save transcript");
    }
    const record = this.buildRecord(transcriptPath);
    try {
      if (this.deps.store) await this.deps.store.appendResult(this.deps.questionnaire, record);
    } catch (err) {
      this.deps.log.error({ err }, "failed to save the result row");
    }
    this.deps.log.info({ outcome: record.outcome, eligible: record.eligible, answers: record.answers }, "call finalized");
    this.deps.onFinished?.(record, this.transcript);
  }
}
