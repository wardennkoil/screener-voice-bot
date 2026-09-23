import { describe, expect, it } from "vitest";
import { checkElevenLabsVoice } from "../src/local/elevenlabs-voices.js";

function recordingLog() {
  const entries: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const push = (level: string) => (obj: unknown, msg?: string) => void entries.push({ level, obj, msg });
  const log = { level: "info", debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), child: () => log };
  return { log, entries };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const myVoices = { voices: [{ voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature", labels: { use_case: "conversational" } }] };

describe("checkElevenLabsVoice", () => {
  it("passes when the voice is in the account", async () => {
    const { log, entries } = recordingLog();
    const ok = await checkElevenLabsVoice("k", "V1", log, async () => json(200, { voice_id: "V1", name: "Sarah" }));
    expect(ok).toBe(true);
    expect(entries[0]!.msg).toBe("elevenlabs voice ok");
  });

  it("names the plan limit when the voice is a Voice Library voice", async () => {
    const { log, entries } = recordingLog();
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v1/voices/")) return json(404, { detail: "voice_not_found" });
      if (u.includes("/v2/voices")) return json(200, myVoices);
      return json(200, { voices: [{ voice_id: "LIB1", name: "Juniper - Grounded and Professional" }] });
    };
    expect(await checkElevenLabsVoice("k", "LIB1", log, fetchImpl as typeof fetch)).toBe(false);
    const err = entries.find((e) => e.level === "error")!;
    expect(err.msg).toMatch(/Voice Library voice; free ElevenLabs plans cannot use library voices/);
    expect(err.obj).toMatchObject({ name: "Juniper - Grounded and Professional", suggestions: ["Sarah EXAVITQu4vr4xnSDxMaL"] });
  });

  it("falls back to the not-in-library message for unknown ids", async () => {
    const { log, entries } = recordingLog();
    const fetchImpl = async (url: string | URL | Request) => (String(url).includes("/v2/voices") ? json(200, myVoices) : String(url).includes("shared-voices") ? json(200, { voices: [] }) : json(404, {}));
    expect(await checkElevenLabsVoice("k", "NOPE", log, fetchImpl as typeof fetch)).toBe(false);
    expect(entries.find((e) => e.level === "error")!.msg).toMatch(/not in your library/);
  });
});
