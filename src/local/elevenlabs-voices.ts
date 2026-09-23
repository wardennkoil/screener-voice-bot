import type { Logger } from "../logger.js";

interface VoiceSummary {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  /** Present with status "copied" when a Voice Library voice was added to the account. */
  sharing?: { status?: string } | null;
}

const API = "https://api.elevenlabs.io";

/** GET a JSON body; undefined on any network, status, or parse failure, so a side lookup never masks the main result. */
async function getJson<T>(fetchImpl: typeof fetch, url: string, apiKey: string): Promise<T | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { "xi-api-key": apiKey } });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Conversational voices from the account, leaving out the configured one and library copies (those may need a paid plan). */
async function suggestVoices(fetchImpl: typeof fetch, apiKey: string, exclude: string): Promise<string[]> {
  const voices = (await getJson<{ voices?: VoiceSummary[] }>(fetchImpl, `${API}/v2/voices?page_size=100`, apiKey))?.voices ?? [];
  return voices
    .filter((v) => v.voice_id !== exclude && v.sharing?.status !== "copied")
    .filter((v) => /conversational|informative|professional/i.test(`${v.labels?.use_case ?? ""} ${v.labels?.descriptive ?? ""}`))
    .slice(0, 8)
    .map((v) => `${v.name.split(" - ")[0]} ${v.voice_id}`);
}

/**
 * Voice Library voices (added to the account or not) only work over the API on paid plans;
 * on the free plan ElevenLabs answers 402 paid_plan_required and laptop mode stays silent.
 */
async function checkLibraryVoicePlan(fetchImpl: typeof fetch, apiKey: string, voiceId: string, name: string, log: Logger): Promise<boolean> {
  const tier = (await getJson<{ tier?: string }>(fetchImpl, `${API}/v1/user/subscription`, apiKey))?.tier;
  if (tier && tier !== "free") {
    log.info({ voiceId, name, tier }, "elevenlabs library voice ok on this plan");
    return true;
  }
  log.error(
    { voiceId, name, tier: tier ?? "unknown", suggestions: await suggestVoices(fetchImpl, apiKey, voiceId) },
    "The configured ElevenLabs voice is a Voice Library voice, which ElevenLabs only allows over the API on paid plans; on a free plan laptop mode will produce no audio. Upgrade the ElevenLabs plan, or set ELEVENLABS_VOICE_ID to one of the suggestions",
  );
  return false;
}

/**
 * Confirms the configured ElevenLabs voice is usable with this account;
 * otherwise logs the conversational voices that are available so the fix is
 * one env change away. Never blocks startup.
 */
export async function checkElevenLabsVoice(apiKey: string, voiceId: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": apiKey } });
    if (res.ok) {
      const v = (await res.json()) as VoiceSummary;
      if (v.sharing?.status === "copied") return checkLibraryVoicePlan(fetchImpl, apiKey, voiceId, v.name, log);
      log.info({ voiceId, name: v.name }, "elevenlabs voice ok");
      return true;
    }
    if (res.status !== 404 && res.status !== 400 && res.status !== 422) {
      log.warn({ status: res.status }, "could not verify the ElevenLabs voice (continuing)");
      return true;
    }
    const libraryVoice = (await getJson<{ voices?: VoiceSummary[] }>(fetchImpl, `${API}/v1/shared-voices?page_size=5&search=${encodeURIComponent(voiceId)}`, apiKey))?.voices?.find(
      (v) => v.voice_id === voiceId,
    );
    if (libraryVoice) return checkLibraryVoicePlan(fetchImpl, apiKey, voiceId, libraryVoice.name, log);
    log.error(
      { voiceId, suggestions: await suggestVoices(fetchImpl, apiKey, voiceId) },
      "The configured ElevenLabs voice is not in your library; set ELEVENLABS_VOICE_ID to one of the suggestions (laptop mode will produce no audio until then)",
    );
    return false;
  } catch (err) {
    log.warn({ err }, "could not verify the ElevenLabs voice (continuing)");
    return true;
  }
}
