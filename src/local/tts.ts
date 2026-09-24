import type { Logger } from "../logger.js";
import { CartesiaTurn, type CartesiaSampleRate } from "./cartesia-tts.js";
import { ElevenLabsTurn, type ElevenLabsTurnOptions } from "./elevenlabs-tts.js";
import type { ElevenLabsVoiceSpec } from "./voice-spec.js";

/** Laptop-mode speech provider, picked by TTS_PROVIDER. The phone path always speaks through Twilio (ElevenLabs). */
export type TtsConfig =
  | { provider: "cartesia"; apiKey: string; voiceId: string; modelId: string }
  | { provider: "elevenlabs"; apiKey: string; voice: ElevenLabsVoiceSpec };

export interface TtsAudioChunk {
  pcm: Buffer;
  /** ElevenLabs only: absolute ms (from the start of the turn's audio) at which each char starts. */
  chars?: string[];
  charStartMs?: number[];
}

export interface TtsTurnEvents {
  onAudio(chunk: TtsAudioChunk): void;
  /** All audio for the turn has been delivered. */
  onFinal(): void;
  onError(err: Error): void;
}

/** One assistant turn of streaming synthesis, whatever the provider (tests provide fakes). */
export interface TtsTurn {
  /** One sentence or clause piece, ending with a space. */
  sendText(text: string): void;
  /** No more text; audio keeps streaming until the provider reports the end. */
  end(): void;
  /** Interrupted: stop right away. */
  abort(): void;
  /** Text heard up to `playedMs` of audio, cut at a word boundary; "" when the provider gave no timing. */
  heardText(playedMs: number): string;
  /** Total audio duration delivered so far, in ms. */
  readonly deliveredMs: number;
}

export function voiceIdOf(cfg: TtsConfig): string {
  return cfg.provider === "cartesia" ? cfg.voiceId : cfg.voice.voiceId;
}

export function modelIdOf(cfg: TtsConfig): string {
  return cfg.provider === "cartesia" ? cfg.modelId : cfg.voice.modelId;
}

export function createTtsTurn(cfg: TtsConfig, sampleRate: number, log: Logger, events: TtsTurnEvents): TtsTurn {
  if (cfg.provider === "cartesia") {
    return new CartesiaTurn({ apiKey: cfg.apiKey, voiceId: cfg.voiceId, modelId: cfg.modelId, sampleRate: sampleRate as CartesiaSampleRate, log }, events);
  }
  return new ElevenLabsTurn({ apiKey: cfg.apiKey, voice: cfg.voice, sampleRate: sampleRate as ElevenLabsTurnOptions["sampleRate"], log }, events);
}
