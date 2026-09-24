import type { Logger } from "../logger.js";
import { CARTESIA_VERSION } from "./cartesia-tts.js";

const API = "https://api.cartesia.ai";

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": CARTESIA_VERSION };
}

/** A few English voices from the account's catalogue, as "Name id", for the log hint. */
async function suggestVoices(fetchImpl: typeof fetch, apiKey: string): Promise<string[]> {
  try {
    const res = await fetchImpl(`${API}/voices?limit=8&language=en`, { headers: headers(apiKey) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
    return (body.data ?? []).map((v) => `${v.name} ${v.id}`);
  } catch {
    return [];
  }
}

/**
 * Confirms CARTESIA_API_KEY works and CARTESIA_VOICE_ID exists; otherwise logs
 * what to change so the fix is one env edit away. Never blocks startup.
 */
export async function checkCartesiaVoice(apiKey: string, voiceId: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${API}/voices/${encodeURIComponent(voiceId)}`, { headers: headers(apiKey) });
    if (res.ok) {
      const v = (await res.json()) as { name?: string };
      log.info({ voiceId, name: v.name }, "cartesia voice ok");
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      log.error({ status: res.status }, "Cartesia rejected CARTESIA_API_KEY; laptop mode will produce no audio. Check the key in the Cartesia dashboard");
      return false;
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      log.error(
        { voiceId, suggestions: await suggestVoices(fetchImpl, apiKey) },
        "Cartesia has no voice with CARTESIA_VOICE_ID; laptop mode will produce no audio. Set it to one of the suggestions",
      );
      return false;
    }
    log.warn({ status: res.status, voiceId }, "could not check the Cartesia voice");
    return true;
  } catch (err) {
    log.warn({ err, voiceId }, "could not check the Cartesia voice");
    return true;
  }
}
