import WebSocket from "ws";
import type { Logger } from "../logger.js";
import type { TtsTurn, TtsTurnEvents } from "./tts.js";

export const CARTESIA_VERSION = "2026-08-14";
export const CARTESIA_WS_URL = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`;

export type CartesiaSampleRate = 8000 | 16000 | 22050 | 24000 | 44100 | 48000;

export interface CartesiaTurnOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** PCM output sample rate; 24000 sounds good in a browser. */
  sampleRate: CartesiaSampleRate;
  log?: Logger;
  /** Injected in tests. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface ServerMessage {
  type?: string;
  context_id?: string;
  done?: boolean;
  data?: string;
  word_timestamps?: { words?: string[]; start?: number[]; end?: number[] } | null;
  error?: string;
  title?: string;
  message?: string;
}

/** One Cartesia context. A reply that pauses for a tool round may need several (see ROTATE_AFTER_IDLE_MS). */
interface Segment {
  id: string;
  /** Audio ms delivered before this segment's first audio; its word timestamps count from here. */
  startMs?: number;
  /** Flushes sent but not yet answered: while above 0, Cartesia is still generating text we sent. */
  pendingFlushes: number;
  /** Last time anything was sent or received on this segment. */
  lastActivity: number;
  /** Cartesia reported this context done without being asked; it takes no more text. */
  closed: boolean;
}

/**
 * Cartesia drops a context about 1 s after its last audio. The engine keeps one spoken reply going
 * across tool rounds ("Got it." … model round-trip … "Next question?"), so text arriving after the
 * current segment has gone quiet starts a fresh context instead of landing on an expired one.
 */
const ROTATE_AFTER_IDLE_MS = 300;
/** No traffic for this long means the context has surely expired, even if a flush answer went missing. */
const EXPIRED_AFTER_MS = 1500;

/**
 * One assistant turn of Cartesia streaming synthesis over the TTS WebSocket.
 * Open it as soon as the person stops talking so the handshake overlaps the
 * model's thinking; feed sentence pieces as they are generated (continuations
 * of one context keep the prosody flowing). Keeps a word timeline from the
 * timestamps so the caller can tell exactly what the person heard when they interrupt.
 */
export class CartesiaTurn implements TtsTurn {
  private readonly ws: WebSocket;
  private open = false;
  private ended = false;
  private closed = false;
  private finalSeen = false;
  private readonly queue: string[] = [];
  private readonly segments = new Map<string, Segment>();
  private segment: Segment | undefined;
  private audioMs = 0;
  private readonly words: string[] = [];
  private readonly wordEndMs: number[] = [];

  constructor(
    private readonly opts: CartesiaTurnOptions,
    private readonly events: TtsTurnEvents,
  ) {
    const headers = { "X-API-Key": opts.apiKey };
    this.ws = opts.wsFactory ? opts.wsFactory(CARTESIA_WS_URL, headers) : new WebSocket(CARTESIA_WS_URL, { headers });
    this.ws.on("open", () => {
      this.open = true;
      for (const piece of this.queue.splice(0)) this.sendPiece(piece);
      if (this.ended) this.finishInput();
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("error", (err) => {
      if (!this.closed) this.events.onError(err instanceof Error ? err : new Error(String(err)));
    });
    this.ws.on("close", (code, reason) => {
      const wasClosed = this.closed;
      this.closed = true;
      if (!wasClosed && !this.finalSeen) {
        if (this.ended && code === 1000) this.events.onFinal();
        else if (!this.ended) this.opts.log?.debug({ code, reason: reason.toString() }, "cartesia socket closed early");
        else this.events.onError(new Error(`Cartesia socket closed (${code}) ${reason.toString()}`));
      }
    });
  }

  get deliveredMs(): number {
    return this.audioMs;
  }

  /** Words fully spoken by `playedMs` of audio. */
  heardText(playedMs: number): string {
    const heard: string[] = [];
    for (let i = 0; i < this.words.length; i++) {
      if ((this.wordEndMs[i] ?? Infinity) > playedMs) break;
      heard.push(this.words[i]!);
    }
    return heard.join(" ").trim();
  }

  sendText(text: string): void {
    if (this.ended || this.closed) return;
    const piece = text.endsWith(" ") ? text : `${text} `;
    if (!this.open) {
      this.queue.push(piece);
      return;
    }
    this.sendPiece(piece);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.open && !this.closed) this.finishInput();
  }

  /** Interrupted: cancel what has not started generating and drop the connection. */
  abort(): void {
    const wasOpen = this.open && !this.closed;
    this.closed = true;
    this.ended = true;
    try {
      if (wasOpen && this.segment) {
        this.raw({ context_id: this.segment.id, cancel: true });
        this.ws.close(); // a graceful close still sends the cancel; messages after this are ignored
      } else {
        this.ws.terminate();
      }
    } catch {
      // already gone
    }
  }

  // ---- internals -------------------------------------------------------

  private isIdle(seg: Segment): boolean {
    const quiet = Date.now() - seg.lastActivity;
    return seg.closed || (seg.pendingFlushes === 0 && quiet > ROTATE_AFTER_IDLE_MS) || quiet > EXPIRED_AFTER_MS;
  }

  private newSegment(): Segment {
    const seg: Segment = { id: `s${this.segments.size}`, pendingFlushes: 0, lastActivity: Date.now(), closed: false };
    this.segments.set(seg.id, seg);
    if (this.segment) this.opts.log?.debug({ from: this.segment.id, to: seg.id }, "cartesia context went quiet; continuing in a new one");
    this.segment = seg;
    return seg;
  }

  private sendPiece(piece: string): void {
    const seg = this.segment && !this.isIdle(this.segment) ? this.segment : this.newSegment();
    this.request(seg, { transcript: piece, continue: true });
    // The flush answer tells us when everything sent so far has been generated.
    this.request(seg, { transcript: "", continue: true, flush: true });
    seg.pendingFlushes++;
  }

  /** No more text: close the context, or finish now if its audio is already all here. */
  private finishInput(): void {
    const seg = this.segment;
    if (!seg || this.isIdle(seg)) {
      this.finish();
      return;
    }
    this.request(seg, { transcript: "", continue: false });
  }

  private finish(): void {
    if (this.finalSeen) return;
    this.finalSeen = true;
    this.closed = true;
    this.events.onFinal();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  /** Every request on a context must repeat the same settings; only transcript/continue/flush vary. */
  private request(seg: Segment, fields: Record<string, unknown>): void {
    seg.lastActivity = Date.now();
    this.raw({
      model_id: this.opts.modelId,
      voice: this.opts.voiceId,
      language: "en",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: this.opts.sampleRate },
      add_timestamps: true,
      // SentenceChunker already sends whole sentences or clauses; buffering would only add delay.
      max_buffer_delay_ms: 0,
      context_id: seg.id,
      ...fields,
    });
  }

  private raw(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string): void {
    if (this.closed) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    const seg = msg.context_id ? this.segments.get(msg.context_id) : undefined;
    if (msg.type === "error" && !seg) {
      // Not tied to one of our contexts (bad model, voice or format): nothing on this socket will play.
      this.events.onError(new Error(`Cartesia: ${msg.title ?? msg.message ?? msg.error ?? "unknown error"}`));
      return;
    }
    if (!seg) return;
    seg.lastActivity = Date.now();
    const current = seg === this.segment;

    if (msg.type === "error") {
      const detail = msg.title ?? msg.message ?? msg.error ?? "unknown error";
      if (!current) {
        this.opts.log?.debug({ context: seg.id, detail }, "cartesia error on an earlier context ignored");
      } else if (this.ended && seg.pendingFlushes === 0) {
        this.finish(); // all audio already arrived; the context just expired before our close
      } else {
        this.events.onError(new Error(`Cartesia: ${detail}${msg.message && msg.message !== detail ? ` (${msg.message})` : ""}`));
      }
      return;
    }

    if (msg.type === "chunk" && msg.data) {
      const pcm = Buffer.from(msg.data, "base64");
      seg.startMs ??= this.audioMs;
      this.audioMs += (pcm.length / 2 / this.opts.sampleRate) * 1000;
      this.events.onAudio({ pcm });
    } else if (msg.type === "timestamps" && msg.word_timestamps) {
      this.addWords(seg, msg.word_timestamps);
    } else if (msg.type === "flush_done") {
      seg.pendingFlushes = Math.max(0, seg.pendingFlushes - 1);
    }

    if (msg.done || msg.type === "done") {
      if (current && this.ended) this.finish();
      else seg.closed = true;
    }
  }

  private addWords(seg: Segment, ts: { words?: string[]; start?: number[]; end?: number[] }): void {
    const words = ts.words ?? [];
    if (!words.length) return;
    seg.startMs ??= this.audioMs;
    const at = (s: number | undefined) => (seg.startMs ?? 0) + (s ?? 0) * 1000;
    // Keep the timeline monotonic in case timestamps restart per continuation rather than per context.
    const lastEnd = this.wordEndMs[this.wordEndMs.length - 1] ?? 0;
    const shift = Math.max(0, lastEnd - at(ts.start?.[0]));
    for (let i = 0; i < words.length; i++) {
      this.words.push(words[i]!);
      this.wordEndMs.push(at(ts.end?.[i] ?? ts.start?.[i]) + shift);
    }
  }
}
