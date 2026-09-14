export interface ElevenLabsVoiceSpec {
  voiceId: string;
  /** ElevenLabs model id, e.g. eleven_flash_v2_5. */
  modelId: string;
  speed?: number;
  stability?: number;
  similarity?: number;
}

const MODEL_SUFFIX = /^(flash|turbo)_v\d(?:_\d)?$/;

/**
 * Parses the Twilio ConversationRelay voice string
 * `<VoiceID>-<model>-<speed>_<stability>_<similarity>` (model and settings optional)
 * into what the ElevenLabs API needs, so one setting drives both the phone
 * path and the laptop voice mode.
 */
export function parseElevenLabsVoiceSpec(spec: string, defaults: { modelId?: string } = {}): ElevenLabsVoiceSpec {
  const parts = spec.trim().split("-");
  const voiceId = parts.shift() ?? "";
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) throw new Error(`Invalid ElevenLabs voice spec "${spec}": expected a voice id first`);
  const out: ElevenLabsVoiceSpec = { voiceId, modelId: defaults.modelId ?? "eleven_flash_v2_5" };
  for (const part of parts) {
    if (MODEL_SUFFIX.test(part)) {
      out.modelId = `eleven_${part}`;
      continue;
    }
    const settings = part.split("_").map(Number);
    if (settings.length === 3 && settings.every((n) => Number.isFinite(n))) {
      const [speed, stability, similarity] = settings as [number, number, number];
      out.speed = speed;
      out.stability = stability;
      out.similarity = similarity;
      continue;
    }
    throw new Error(`Invalid ElevenLabs voice spec "${spec}": unrecognized part "${part}"`);
  }
  return out;
}
