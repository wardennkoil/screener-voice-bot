import type { Logger } from "../logger.js";
import type { Transcript } from "../storage/transcripts.js";
import { functionResultStep, userStep, type HistoryStep, type LlmAdapter, type LlmToolCall } from "./llm.js";
import type { EndReason, FunctionToolDecl, ToolHandlers, ToolOutcome } from "./tools.js";
import type { Transport } from "./transport.js";

export interface EngineOptions {
  system: string;
  tools: FunctionToolDecl[];
  toolHandlers: ToolHandlers;
  llm: LlmAdapter;
  transport: Transport;
  transcript: Transcript;
  log: Logger;
  /** Called once the model has asked to end the call (after its closing words were streamed). */
  onEndRequested(end: { reason: EndReason; note?: string }): void;
  /** Upper bound on tool rounds within a single user turn. */
  maxToolRounds?: number;
}

export interface TurnStats {
  firstTokenMs?: number;
  lastTokenMs?: number;
  toolCalls: number;
  text: string;
  aborted: boolean;
}

interface ActiveTurn {
  abort: AbortController;
  spoken: string;
  sentAny: boolean;
  /** Text generated in the current model round (reset after each tool round). */
  roundText: string;
  /** Set when the person interrupted this turn: the words they heard before speaking. */
  heard?: string;
}

/**
 * Some models answer a recording with a bare tool call and only speak on the next
 * round. Rather than leave the line silent for that round trip, the engine says a
 * short acknowledgment itself and tells the model not to repeat it.
 */
const BRIDGE_ACKS: Record<string, string[]> = {
  record_answer: ["Got it.", "Okay.", "Thanks.", "Alright."],
  confirm_identity: ["Great."],
  record_consent: ["Great, thank you."],
};

function pickAck(toolName: string, seed: number): string | undefined {
  const options = BRIDGE_ACKS[toolName];
  if (!options || options.length === 0) return undefined;
  return options[seed % options.length];
}

function endsWithQuestion(text: string): boolean {
  return /\?["')\]]?\s*$/.test(text.trim());
}

/**
 * Drives one conversation: keeps the stateless history, streams model text to
 * the transport as it arrives, executes tool calls inline, and folds
 * interruptions back into the history as bracketed notes.
 */
export class ConversationEngine {
  readonly history: HistoryStep[] = [];
  private active: ActiveTurn | undefined;
  private pendingNotes: string[] = [];
  private endRequested = false;
  private ackSeed = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: EngineOptions) {}

  get isBusy(): boolean {
    return this.active !== undefined;
  }

  get hasEnded(): boolean {
    return this.endRequested;
  }

  /**
   * The person said something (or the system injected a bracketed note).
   * A new input while the model is still generating cancels that generation.
   */
  handleUserInput(text: string, kind: "speech" | "system" = "speech"): Promise<TurnStats> {
    if (this.active) this.cancelActive("superseded by new input");
    const run = this.queue.then(() => this.runTurn(text, kind));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** ConversationRelay reported the person spoke over the assistant. */
  interrupt(utteranceUntilInterrupt: string): void {
    const heard = utteranceUntilInterrupt.trim();
    if (this.active) {
      // Still generating: the turn is logged (as interrupted) when the abort unwinds.
      if (heard) this.active.heard = heard;
      this.cancelActive("interrupted");
    } else {
      // Already fully generated but still playing: annotate the logged turn.
      const lastAssistant = [...this.opts.transcript.turns].reverse().find((t) => t.role === "assistant");
      if (lastAssistant) {
        lastAssistant.interrupted = true;
        if (heard) lastAssistant.heard = heard;
      }
    }
    this.pendingNotes.push(heard ? `[The person interrupted after hearing: "${heard}"]` : "[The person interrupted you]");
  }

  private cancelActive(reason: string): void {
    if (!this.active) return;
    this.opts.log.debug({ reason }, "cancelling active model turn");
    this.active.abort.abort();
  }

  private async runTurn(text: string, kind: "speech" | "system"): Promise<TurnStats> {
    const startedAt = Date.now();
    const stats: TurnStats = { toolCalls: 0, text: "", aborted: false };
    if (this.endRequested) return stats;

    const notes = this.pendingNotes.splice(0);
    const inputText = [...notes, text].join("\n");
    this.opts.toolHandlers.beginUserTurn(kind);
    this.history.push(userStep(inputText));
    this.opts.transcript.turns.push({ role: kind === "speech" ? "person" : "system", text: inputText, at: new Date().toISOString() });

    const turn: ActiveTurn = { abort: new AbortController(), spoken: "", sentAny: false, roundText: "" };
    this.active = turn;
    const maxRounds = this.opts.maxToolRounds ?? 6;

    try {
      for (let round = 0; round < maxRounds; round++) {
        turn.roundText = "";
        const result = await this.opts.llm.run(
          { system: this.opts.system, history: this.history, tools: this.opts.tools, signal: turn.abort.signal },
          {
            onText: (delta) => {
              if (turn.abort.signal.aborted || delta.length === 0) return;
              if (stats.firstTokenMs === undefined) stats.firstTokenMs = Date.now() - startedAt;
              // Text after a tool round continues the same spoken reply; keep the words apart.
              if (turn.roundText === "" && turn.spoken.length > 0 && !/\s$/.test(turn.spoken) && !/^\s/.test(delta)) delta = ` ${delta}`;
              turn.roundText += delta;
              turn.spoken += delta;
              turn.sentAny = true;
              this.opts.transport.sendText(delta, false);
            },
          },
        );

        this.history.push(...result.steps);
        stats.text = turn.spoken;

        if (result.aborted) {
          stats.aborted = true;
          break;
        }

        if (result.toolCalls.length === 0) break;

        let endNow = false;
        let anyRecordingFailed = false;
        const askedThisRound = endsWithQuestion(turn.roundText);
        const handled: Array<{ call: LlmToolCall; outcome: ToolOutcome & { premature?: boolean } }> = [];
        for (const call of result.toolCalls) {
          stats.toolCalls++;
          const outcome: ToolOutcome & { premature?: boolean } = this.opts.toolHandlers.handle(call.name, call.args, { roundEndsWithQuestion: askedThisRound });
          if (outcome.premature) this.opts.log.warn({ tool: call.name, args: call.args }, "recording tool called before the person answered; refused");
          this.opts.log.info({ tool: call.name, args: call.args, ok: !outcome.isError }, "tool call");
          this.opts.transcript.toolCalls.push({ at: new Date().toISOString(), name: call.name, args: call.args, result: outcome.payload });
          handled.push({ call, outcome });
          if (outcome.end) {
            this.endRequested = true;
            endNow = true;
            this.pendingEnd = outcome.end;
          }
          if (outcome.premature) endNow = true; // leave the question standing for the person
          else if (outcome.isError) anyRecordingFailed = true;
        }

        // Bridge the silence: a successful recording with no words in this round gets a spoken acknowledgment now.
        if (!endNow && turn.roundText.trim() === "" && !turn.abort.signal.aborted) {
          const bridged = handled.find((h) => !h.outcome.isError && h.outcome.payload.ok === true && BRIDGE_ACKS[h.call.name]);
          const ack = bridged ? pickAck(bridged.call.name, this.ackSeed++) : undefined;
          if (bridged && ack) {
            turn.spoken += (turn.spoken && !/\s$/.test(turn.spoken) ? " " : "") + `${ack} `;
            turn.roundText = `${ack} `;
            turn.sentAny = true;
            if (stats.firstTokenMs === undefined) stats.firstTokenMs = Date.now() - startedAt;
            this.opts.transport.sendText(`${ack} `, false);
            bridged.outcome.payload = {
              ...bridged.outcome.payload,
              already_spoken: ack,
              note: `"${ack}" was just spoken to the person as your acknowledgment. Continue directly with the next question; do not acknowledge again.`,
            };
            this.history.push({ type: "model_output", content: [{ type: "text", text: ack }] });
          }
        }

        for (const { call, outcome } of handled) {
          this.history.push(functionResultStep(call.id, call.name, outcome.payload, outcome.isError));
        }
        // The reply already asked the next question: leave it standing unless a recording failed,
        // in which case one more round lets the model correct itself before the person answers.
        if (askedThisRound && !anyRecordingFailed) endNow = true;
        if (endNow) break;
        if (turn.abort.signal.aborted) {
          stats.aborted = true;
          break;
        }
      }
    } catch (err) {
      this.opts.log.error({ err }, "model turn failed");
      if (!turn.sentAny && !turn.abort.signal.aborted) {
        const fallback = "Sorry, I lost you for a second. Could you say that once more?";
        turn.spoken = fallback;
        turn.sentAny = true;
        this.opts.transport.sendText(fallback, false);
        this.history.push({ type: "model_output", content: [{ type: "text", text: fallback }] });
      }
    } finally {
      if (this.active === turn) this.active = undefined;
    }

    if (turn.sentAny) {
      this.opts.toolHandlers.noteAssistantReply();
      this.opts.transport.sendText("", true);
      stats.lastTokenMs = Date.now() - startedAt;
      this.opts.transcript.turns.push({
        role: "assistant",
        text: turn.spoken,
        at: new Date().toISOString(),
        ...(stats.aborted ? { interrupted: true, ...(turn.heard ? { heard: turn.heard } : {}) } : {}),
      });
    }
    if (this.pendingEnd) {
      const end = this.pendingEnd;
      this.pendingEnd = undefined;
      this.opts.onEndRequested(end);
    }
    return stats;
  }

  private pendingEnd: { reason: EndReason; note?: string } | undefined;
}
