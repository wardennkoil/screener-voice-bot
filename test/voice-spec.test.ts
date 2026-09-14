import { describe, expect, it } from "vitest";
import { parseElevenLabsVoiceSpec } from "../src/local/voice-spec.js";

describe("parseElevenLabsVoiceSpec", () => {
  it("parses the Twilio voice string into ElevenLabs settings", () => {
    expect(parseElevenLabsVoiceSpec("UgBBYS2sOqTuMpoF3BR0-flash_v2_5-1.0_0.5_0.75")).toEqual({ voiceId: "UgBBYS2sOqTuMpoF3BR0", modelId: "eleven_flash_v2_5", speed: 1, stability: 0.5, similarity: 0.75 });
    expect(parseElevenLabsVoiceSpec("XrExE9yKIg1WjnnlVkGX-1.2_0.6_0.8")).toMatchObject({ voiceId: "XrExE9yKIg1WjnnlVkGX", modelId: "eleven_flash_v2_5", speed: 1.2 });
    expect(parseElevenLabsVoiceSpec("XrExE9yKIg1WjnnlVkGX-turbo_v2_5")).toEqual({ voiceId: "XrExE9yKIg1WjnnlVkGX", modelId: "eleven_turbo_v2_5" });
    expect(parseElevenLabsVoiceSpec("XrExE9yKIg1WjnnlVkGX", { modelId: "eleven_v3" }).modelId).toBe("eleven_v3");
  });

  it("rejects malformed specs", () => {
    expect(() => parseElevenLabsVoiceSpec("abc")).toThrow(/voice id/);
    expect(() => parseElevenLabsVoiceSpec("XrExE9yKIg1WjnnlVkGX-fast")).toThrow(/unrecognized/);
  });
});
