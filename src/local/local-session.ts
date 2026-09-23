import type { LlmAdapter } from "../conversation/llm.js";
import { CallSession } from "../conversation/session.js";
import type { Transport } from "../conversation/transport.js";
import type { Logger } from "../logger.js";
import type { Questionnaire } from "../screening/schema.js";
import type { CallRecord } from "../storage/csv.js";
import { connectFlux, type FluxEvents, type FluxOptions, type FluxTurnEvent, type SttStream } from "./deepgram-flux.js";
import { ElevenLabsTurn, type ElevenLabsTurnEvents, type ElevenLabsTurnOptions } from "./elevenlabs-tts.js";
import { SentenceChunker } from "./sentences.js";
import type { ElevenLabsVoiceSpec } from "./voice-spec.js";
import type { CallStore } from "../storage/store.js";

/** The browser side of the local test, abstracted so tests can observe it. */
export interface BrowserLink {
  sendJson(msg: Record<string, unknown>): void;
  sendAudio(turnId: number, pcm: Buffer): void;
  close(): void;
}

/** The subset of ElevenLabsTurn the session relies on (tests provide fakes). */
export interface TtsTurn {
  sendText(text: string): void;
  end(): void;
  abort(): void;
  heardText(playedMs: number): string;
  readonly deliveredMs: number;
}

export interface LocalVoiceDeps {
  questionnaire: Questionnaire;
  llm: LlmAdapter;
  log: Logger;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  voice: ElevenLabsVoiceSpec;
  sampleRate: number;
  eotThreshold: number;
  eagerEotThreshold?: number;
  store?: CallStore;
  firstName?: string;
  recordingEnabled?: boolean;
  /** Test seams. */
  sttFactory?: (opts: FluxOptions, events: FluxEvents) => Promise<SttStream>;
  ttsFactory?: (opts: ElevenLabsTurnOptions, events: ElevenLabsTurnEvents) => TtsTurn;
  onFinished?(record: CallRecord): void;
}

interface AssistantTurn {
  id: number;
  tts: TtsTurn;
  chunker: SentenceChunker;
  text: string;
  textDone: boolean;
  audioDone: boolean;
  playbackDone: boolean;
  aborted: boolean;
  playedMs: number;
  firstTokenAt?: number;
  firstAudioAt?: number;
}

const BACKCHANNEL_PHRASES = new Set(["got it", "i see", "all right", "oh okay", "oh ok", "okay yeah", "yeah okay", "mm hmm", "uh huh"]);
const BACKCHANNEL_WORD = /^(yeah|yep|yes|ok|okay|mm+|mhm+|mm-?hmm?|uh-?huh|right|sure|oh|hmm+|alright|uh|um|yup|totally|exactly)$/i;

/** Short acknowledgments people make while listening; they should not stop the assistant. */
export function isBackchannel(transcript: string): boolean {
  const norm = transcript.toLowerCase().replace(/[^a-z' -]/g, " ").replace(/\s+/g, " ").trim();
  if (!norm) return true;
  const words = norm.split(" ");
  if (words.length > 2) return false;
  if (BACKCHANNEL_PHRASES.has(norm)) return true;
  return words.every((w) => BACKCHANNEL_WORD.test(w));
}

/** Proportional fallback when no alignment data is available. */
export function proportionalHeard(text: string, playedMs: number, totalMs: number): string {
  if (totalMs <= 0 || playedMs <= 0) return "";
  if (playedMs >= totalMs) return text.trim();
  const cut = Math.floor((text.length * playedMs) / totalMs);
  const head = text.slice(0, cut);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/**
 * One laptop conversation: microphone audio → Flux turn events → the same
 * CallSession the phone path uses → ElevenLabs speech → browser playback.
 * Owns barge-in: a real interruption clears playback and tells the model
 * what was heard; a short "uh-huh" while Sam is talking is ignored.
 */
export class LocalVoiceSession {
  readonly session: CallSession;
  private stt: SttStream | undefined;
  private turnSeq = 0;
  private current: AssistantTurn | undefined;
  private prepared: { tts: TtsTurn; turnId: number } | undefined;
  private eotAt = 0;
  private lastTurnAt = 0;
  private lastEotDelayMs: number | undefined;
  private bargeTimer: NodeJS.Timeout | undefined;
  private bargeArmed = false;
  private closed = false;
  private endingReason: string | undefined;

  constructor(
    private readonly deps: LocalVoiceDeps,
    private readonly link: BrowserLink,
  ) {
    const transport: Transport = {
      sendText: (token, last) => this.onModelText(token, last),
      end: (handoff) => this.onSessionEnd(String(handoff?.reason ?? "ended")),
    };
    this.session = new CallSession({
      callSid: `LOCAL-${Date.now()}`,
      contact: { contactId: "local", phone: "+10000000000", firstName: deps.firstName?.trim() || "Jordan" },
      questionnaire: deps.questionnaire,
      llm: deps.llm,
      transport,
      log: deps.log,
      recordingEnabled: deps.recordingEnabled ?? false,
      store: deps.store,
      onFinished: (record) => {
        deps.onFinished?.(record);
        this.link.sendJson({ type: "result", outcome: record.outcome, eligible: record.eligible, answers: record.answers });
      },
    });
  }

  async start(): Promise<void> {
    const sttOpts: FluxOptions = {
      apiKey: this.deps.deepgramApiKey,
      sampleRate: this.deps.sampleRate,
      eotThreshold: this.deps.eotThreshold,
      eagerEotThreshold: this.deps.eagerEotThreshold,
      log: this.deps.log,
    };
    const events: FluxEvents = { onTurn: (e) => this.onFluxTurn(e), onError: (err) => this.onSttError(err) };
    try {
      this.stt = await (this.deps.sttFactory ?? connectFlux)(sttOpts, events);
    } catch (err) {
      this.deps.log.error({ err }, "could not connect to Deepgram");
      this.link.sendJson({ type: "error", message: `Speech recognition unavailable: ${(err as Error).message}` });
      this.link.close();
      return;
    }
    this.link.sendJson({ type: "state", state: "listening" });
    this.session.start();
  }

  onMicAudio(pcm16: Buffer): void {
    this.stt?.sendAudio(pcm16);
  }

  onClientMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "played": {
        const turn = Number(msg.turn);
        const ms = Number(msg.ms);
        if (this.current && this.current.id === turn && Number.isFinite(ms)) this.current.playedMs = Math.max(this.current.playedMs, ms);
        break;
      }
      case "playback_done": {
        const turn = Number(msg.turn);
        if (this.current && this.current.id === turn) {
          this.current.playbackDone = true;
          this.session.notifyPlaybackDone();
          if (!this.session.engine.isBusy) this.link.sendJson({ type: "state", state: "listening" });
          if (this.endingReason !== undefined) this.finishEnd();
        }
        break;
      }
      case "hangup":
        this.close();
        break;
      default:
        break;
    }
  }

  /** Browser went away or hung up. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.current?.tts.abort();
    this.prepared?.tts.abort();
    this.stt?.close();
    this.session.onClose();
  }

  // ---- speech in -------------------------------------------------------

  private get assistantSpeaking(): boolean {
    return !!this.current && !this.current.aborted && !this.current.playbackDone;
  }

  private onFluxTurn(e: FluxTurnEvent): void {
    if (this.closed) return;
    switch (e.event) {
      case "StartOfTurn":
        if (this.assistantSpeaking) {
          this.bargeArmed = true;
          if (this.bargeTimer) clearTimeout(this.bargeTimer);
          // A real interruption keeps going; a lone "uh-huh" ends before this fires.
          this.bargeTimer = setTimeout(() => {
            if (this.bargeArmed && this.assistantSpeaking && !isBackchannel(e.transcript)) this.bargeIn();
          }, 500);
        }
        if (e.transcript) this.link.sendJson({ type: "transcript", role: "you", text: e.transcript, final: false });
        break;
      case "Update":
        if (this.bargeArmed && this.assistantSpeaking && e.words.length >= 2) this.bargeIn();
        if (e.transcript) this.link.sendJson({ type: "transcript", role: "you", text: e.transcript, final: false });
        break;
      case "EndOfTurn":
        this.bargeArmed = false;
        if (this.bargeTimer) clearTimeout(this.bargeTimer);
        if (!e.transcript) return;
        if (this.assistantSpeaking && isBackchannel(e.transcript)) {
          this.deps.log.debug({ transcript: e.transcript }, "backchannel ignored");
          return;
        }
        if (this.assistantSpeaking) this.bargeIn();
        this.deliverUtterance(e.transcript, e.eotDelayMs);
        break;
      case "EagerEndOfTurn":
      case "TurnResumed":
        // Speculative generation is a later refinement; for now only confirmed turns count.
        break;
    }
  }

  private deliverUtterance(transcript: string, eotDelayMs?: number): void {
    this.eotAt = Date.now();
    this.lastEotDelayMs = eotDelayMs;
    this.link.sendJson({ type: "transcript", role: "you", text: transcript, final: true });
    this.link.sendJson({ type: "state", state: "thinking" });
    this.prepareNextTurn();
    this.session.onPrompt(transcript, true);
  }

  private onSttError(err: Error): void {
    this.deps.log.warn({ err }, "speech recognition error");
    this.link.sendJson({ type: "error", message: err.message });
  }

  /** Open the synthesis socket while the model is still thinking. */
  private prepareNextTurn(): void {
    if (this.prepared) return;
    const turnId = ++this.turnSeq;
    this.prepared = { turnId, tts: this.createTts(turnId) };
  }

  private createTts(turnId: number): TtsTurn {
    const opts: ElevenLabsTurnOptions = { apiKey: this.deps.elevenLabsApiKey, voice: this.deps.voice, sampleRate: this.deps.sampleRate as ElevenLabsTurnOptions["sampleRate"], log: this.deps.log };
    const events: ElevenLabsTurnEvents = {
      onAudio: (chunk) => {
        const turn = this.current;
        if (!turn || turn.id !== turnId || turn.aborted) return;
        if (turn.firstAudioAt === undefined) {
          turn.firstAudioAt = Date.now();
          this.link.sendJson({ type: "state", state: "speaking" });
          const firstTokenMs = turn.firstTokenAt ? turn.firstTokenAt - this.eotAt : null;
          const firstAudioMs = turn.firstAudioAt - this.eotAt;
          const eotDelayMs = this.lastEotDelayMs ?? null;
          this.lastEotDelayMs = undefined;
          this.link.sendJson({ type: "latency", firstTokenMs, firstAudioMs, eotDelayMs });
          this.session.transcript.relayEvents.push({ at: new Date().toISOString(), type: "local-latency", data: { eotDelayMs, firstTokenMs, firstAudioMs } });
        }
        this.link.sendAudio(turnId, chunk.pcm);
      },
      onFinal: () => {
        const turn = this.current;
        if (turn && turn.id === turnId) turn.audioDone = true;
      },
      onError: (err) => {
        this.deps.log.warn({ err }, "text-to-speech error");
        this.link.sendJson({ type: "error", message: `Voice error: ${err.message}` });
        const turn = this.current;
        if (turn && turn.id === turnId) {
          // Nothing will play; let the session move on as if playback finished.
          turn.audioDone = true;
          turn.playbackDone = true;
          this.session.notifyPlaybackDone();
        }
      },
    };
    return (this.deps.ttsFactory ?? ((o, ev) => new ElevenLabsTurn(o, ev)))(opts, events);
  }

  // ---- speech out ------------------------------------------------------

  private onModelText(token: string, last: boolean): void {
    if (this.closed) return;
    if (!this.current || this.current.textDone) {
      const prepared = this.prepared ?? { turnId: ++this.turnSeq, tts: this.createTts(this.turnSeq) };
      this.prepared = undefined;
      this.current = { id: prepared.turnId, tts: prepared.tts, chunker: new SentenceChunker(), text: "", textDone: false, audioDone: false, playbackDone: false, aborted: false, playedMs: 0 };
      this.link.sendJson({ type: "turn", id: prepared.turnId });
      // Turns not triggered by the person (opener, silence nudges) are measured from now.
      if (this.eotAt < Date.now() - 60_000 || this.eotAt <= this.lastTurnAt) this.eotAt = Date.now();
      this.lastTurnAt = Date.now();
    }
    const turn = this.current;
    if (token) {
      if (turn.firstTokenAt === undefined) turn.firstTokenAt = Date.now();
      turn.text += token;
      for (const piece of turn.chunker.push(token)) turn.tts.sendText(piece);
      this.link.sendJson({ type: "transcript", role: this.deps.questionnaire.caller.persona_name, text: turn.text, final: false });
    }
    if (last) {
      const rest = turn.chunker.flush();
      if (rest) turn.tts.sendText(rest);
      turn.tts.end();
      turn.textDone = true;
      this.link.sendJson({ type: "transcript", role: this.deps.questionnaire.caller.persona_name, text: turn.text, final: true });
    }
  }

  private bargeIn(): void {
    const turn = this.current;
    this.bargeArmed = false;
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    let heard = turn.tts.heardText(turn.playedMs);
    if (!heard) heard = proportionalHeard(turn.text, turn.playedMs, turn.tts.deliveredMs);
    turn.tts.abort();
    this.link.sendJson({ type: "clear", turn: turn.id });
    this.link.sendJson({ type: "transcript", role: this.deps.questionnaire.caller.persona_name, text: heard || turn.text, final: true, interrupted: true });
    this.link.sendJson({ type: "state", state: "listening" });
    this.deps.log.info({ heard, playedMs: turn.playedMs }, "barge-in");
    this.session.onInterrupt(heard);
  }

  private onSessionEnd(reason: string): void {
    this.endingReason = reason;
    if (!this.assistantSpeaking) this.finishEnd();
  }

  private finishEnd(): void {
    if (this.closed) return;
    this.link.sendJson({ type: "end", reason: this.endingReason ?? "ended" });
    this.link.sendJson({ type: "state", state: "ended" });
    setTimeout(() => this.link.close(), 300);
  }
}
