import type { Logger } from "../logger.js";

interface VoiceSummary {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
}

/**
 * Confirms the configured ElevenLabs voice exists in this account's library;
 * otherwise logs the conversational voices that are available so the fix is
 * one env change away. Never blocks startup.
 */
export async function checkElevenLabsVoice(apiKey: string, voiceId: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": apiKey } });
    if (res.ok) {
      const v = (await res.json()) as VoiceSummary;
      log.info({ voiceId, name: v.name }, "elevenlabs voice ok");
      return true;
    }
    if (res.status !== 404 && res.status !== 400 && res.status !== 422) {
      log.warn({ status: res.status }, "could not verify the ElevenLabs voice (continuing)");
      return true;
    }
    const list = await fetchImpl("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": apiKey } });
    const voices = list.ok ? (((await list.json()) as { voices?: VoiceSummary[] }).voices ?? []) : [];
    const suggestions = voices
      .filter((v) => /conversational|informative|professional/i.test(`${v.labels?.use_case ?? ""} ${v.labels?.descriptive ?? ""}`))
      .slice(0, 8)
      .map((v) => `${v.name.split(" - ")[0]} ${v.voice_id}`);
    // A Voice Library voice is a different fix: ElevenLabs refuses those over the API on free plans (402 paid_plan_required).
    const shared = await fetchImpl(`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": apiKey } }).catch(() => undefined);
    const libraryVoice = shared?.ok ? (((await shared.json()) as { voices?: VoiceSummary[] }).voices ?? []).find((v) => v.voice_id === voiceId) : undefined;
    if (libraryVoice) {
      log.error(
        { voiceId, name: libraryVoice.name, suggestions },
        "The configured ElevenLabs voice is a Voice Library voice; free ElevenLabs plans cannot use library voices over the API, so laptop mode will produce no audio. Upgrade the ElevenLabs plan, or set ELEVENLABS_VOICE_ID to one of the suggestions",
      );
      return false;
    }
    log.error(
      { voiceId, suggestions },
      "The configured ElevenLabs voice is not in your library; set ELEVENLABS_VOICE_ID to one of the suggestions (laptop mode will produce no audio until then)",
    );
    return false;
  } catch (err) {
    log.warn({ err }, "could not verify the ElevenLabs voice (continuing)");
    return true;
  }
}
