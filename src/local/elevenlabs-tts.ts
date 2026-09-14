import WebSocket from "ws";
import type { Logger } from "../logger.js";
import type { ElevenLabsVoiceSpec } from "./voice-spec.js";

export interface ElevenLabsTurnOptions {
  apiKey: string;
  voice: ElevenLabsVoiceSpec;
  /** PCM output sample rate; 24000 sounds good in a browser, 16000/8000 for telephony. */
  sampleRate: 8000 | 16000 | 22050 | 24000 | 44100;
  log?: Logger;
  /** Injected in tests. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

export interface TtsAudioChunk {
  pcm: Buffer;
  /** Absolute ms (from the start of the turn's audio) at which each char starts. */
  chars: string[];
  charStartMs: number[];
}

export interface ElevenLabsTurnEvents {
  onAudio(chunk: TtsAudioChunk): void;
  /** All audio for the turn has been delivered. */
  onFinal(): void;
  onError(err: Error): void;
}

interface ServerMessage {
  audio?: string | null;
  isFinal?: boolean | null;
  alignment?: { chars?: string[]; charStartTimesMs?: number[]; charDurationsMs?: number[] } | null;
  error?: string;
  message?: string;
  code?: number;
}

/**
 * One assistant turn of ElevenLabs streaming synthesis over the stream-input
 * WebSocket. Open it as soon as the person stops talking so the handshake
 * overlaps the model's thinking; feed sentence pieces as they are generated.
 * Keeps a character timeline (from the alignment data) so the caller can tell
 * exactly what the person heard when they interrupt.
 */
export class ElevenLabsTurn {
  private readonly ws: WebSocket;
  private open = false;
  private ended = false;
  private closed = false;
  private readonly queue: string[] = [];
  private audioMs = 0;
  readonly chars: string[] = [];
  readonly charStartMs: number[] = [];
  readonly openedAt = Date.now();
  firstAudioAt: number | undefined;

  constructor(
    private readonly opts: ElevenLabsTurnOptions,
    private readonly events: ElevenLabsTurnEvents,
  ) {
    const { voice, sampleRate } = opts;
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}/stream-input` +
      `?model_id=${encodeURIComponent(voice.modelId)}&output_format=pcm_${sampleRate}&auto_mode=true&sync_alignment=true&inactivity_timeout=60`;
    const headers = { "xi-api-key": opts.apiKey };
    this.ws = opts.wsFactory ? opts.wsFactory(url, headers) : new WebSocket(url, { headers });
    this.ws.on("open", () => {
      this.open = true;
      const voiceSettings: Record<string, number> = {};
      if (voice.stability !== undefined) voiceSettings.stability = voice.stability;
      if (voice.similarity !== undefined) voiceSettings.similarity_boost = voice.similarity;
      if (voice.speed !== undefined) voiceSettings.speed = voice.speed;
      this.raw({ text: " ", ...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}) });
      for (const text of this.queue.splice(0)) this.raw({ text, flush: true });
      if (this.ended) this.raw({ text: "" });
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
        else if (!this.ended) this.opts.log?.debug({ code, reason: reason.toString() }, "elevenlabs socket closed early");
        else this.events.onError(new Error(`ElevenLabs socket closed (${code}) ${reason.toString()}`));
      }
    });
  }

  private finalSeen = false;

  /** Total audio duration delivered so far, in ms. */
  get deliveredMs(): number {
    return this.audioMs;
  }

  /** Text heard up to `playedMs` of audio, cut at a word boundary. */
  heardText(playedMs: number): string {
    let out = "";
    for (let i = 0; i < this.chars.length; i++) {
      if ((this.charStartMs[i] ?? 0) > playedMs) break;
      out += this.chars[i];
    }
    const trimmed = out.trimEnd();
    if (trimmed.length < out.length || this.chars.length === 0) return trimmed;
    // Ended mid-word: drop the partial word.
    const lastSpace = trimmed.lastIndexOf(" ");
    return lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed;
  }

  /** Sends one piece of text (should end with a space). Forces generation so audio starts right away. */
  sendText(text: string): void {
    if (this.ended || this.closed) return;
    const piece = text.endsWith(" ") ? text : `${text} `;
    if (!this.open) {
      this.queue.push(piece);
      return;
    }
    this.raw({ text: piece, flush: true });
  }

  /** No more text for this turn; audio keeps streaming until ElevenLabs reports the final chunk. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.open && !this.closed) this.raw({ text: "" });
  }

  /** Interrupted: drop the connection immediately. */
  abort(): void {
    this.closed = true;
    this.ended = true;
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
  }

  private raw(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (msg.error || (msg.code && msg.code >= 400)) {
      this.events.onError(new Error(`ElevenLabs: ${msg.error ?? msg.message ?? "unknown error"}`));
      return;
    }
    if (msg.audio) {
      const pcm = Buffer.from(msg.audio, "base64");
      if (this.firstAudioAt === undefined) this.firstAudioAt = Date.now();
      const chunkChars = msg.alignment?.chars ?? [];
      const chunkStarts = msg.alignment?.charStartTimesMs ?? [];
      const chars: string[] = [];
      const charStartMs: number[] = [];
      for (let i = 0; i < chunkChars.length; i++) {
        chars.push(chunkChars[i]!);
        charStartMs.push(this.audioMs + (chunkStarts[i] ?? 0));
      }
      this.chars.push(...chars);
      this.charStartMs.push(...charStartMs);
      this.audioMs += (pcm.length / 2 / this.opts.sampleRate) * 1000;
      this.events.onAudio({ pcm, chars, charStartMs });
    }
    if (msg.isFinal) {
      this.finalSeen = true;
      this.events.onFinal();
      this.closed = true;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }
}
