import { DeepgramClient } from "@deepgram/sdk";
import type { Logger } from "../logger.js";

export type FluxEventName = "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";

export interface FluxTurnEvent {
  event: FluxEventName;
  transcript: string;
  turnIndex: number;
  confidence: number;
  words: string[];
  /** For EndOfTurn: ms of audio between the last word ending and the turn being declared over. */
  eotDelayMs?: number;
}

export interface FluxEvents {
  onTurn(e: FluxTurnEvent): void;
  onError(err: Error): void;
  onConnected?(): void;
}

export interface FluxOptions {
  apiKey: string;
  sampleRate: number;
  eotThreshold: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  log?: Logger;
}

/** What the local session needs from a speech-to-text stream; tests provide fakes. */
export interface SttStream {
  sendAudio(pcm16: Buffer): void;
  close(): void;
}

/**
 * Deepgram Flux over the official SDK: linear16 audio in, turn events out.
 * Flux decides when the person has finished speaking, which is what makes the
 * conversation feel unhurried without long dead air.
 */
export async function connectFlux(opts: FluxOptions, events: FluxEvents): Promise<SttStream> {
  const client = new DeepgramClient({ apiKey: opts.apiKey });
  const socket = await client.listen.v2.connect({
    model: "flux-general-en",
    encoding: "linear16",
    sample_rate: opts.sampleRate,
    eot_threshold: opts.eotThreshold,
    eot_timeout_ms: opts.eotTimeoutMs ?? 5000,
    ...(opts.eagerEotThreshold !== undefined ? { eager_eot_threshold: opts.eagerEotThreshold } : {}),
    Authorization: `Token ${opts.apiKey}`,
  });

  socket.on("message", (message) => {
    const m = message as { type?: string; event?: string; transcript?: string; turn_index?: number; end_of_turn_confidence?: number; audio_window_end?: number; words?: Array<{ word?: string; end?: number }>; description?: string; code?: string };
    if (m.type === "TurnInfo" && m.event) {
      const lastWordEnd = (m.words ?? []).reduce((acc, w) => (typeof w.end === "number" && w.end > acc ? w.end : acc), 0);
      const eotDelayMs = m.event === "EndOfTurn" && typeof m.audio_window_end === "number" && lastWordEnd > 0 ? Math.max(0, Math.round((m.audio_window_end - lastWordEnd) * 1000)) : undefined;
      events.onTurn({
        event: m.event as FluxEventName,
        transcript: (m.transcript ?? "").trim(),
        turnIndex: m.turn_index ?? 0,
        confidence: m.end_of_turn_confidence ?? 0,
        words: (m.words ?? []).map((w) => w.word ?? "").filter(Boolean),
        ...(eotDelayMs !== undefined ? { eotDelayMs } : {}),
      });
    } else if (m.type === "Connected") {
      events.onConnected?.();
    } else if (m.type === "Error") {
      events.onError(new Error(`Deepgram: ${m.description ?? m.code ?? "unknown error"}`));
    }
  });
  socket.on("error", (err) => events.onError(err instanceof Error ? err : new Error(String(err))));

  socket.connect();
  await socket.waitForOpen();
  opts.log?.info({ sampleRate: opts.sampleRate, eotThreshold: opts.eotThreshold }, "deepgram flux connected");

  return {
    sendAudio(pcm16) {
      socket.sendMedia(pcm16);
    },
    close() {
      try {
        socket.sendCloseStream({ type: "CloseStream" });
      } catch {
        // socket may already be gone
      }
      socket.close();
    },
  };
}
