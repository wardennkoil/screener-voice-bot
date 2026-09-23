import { describe, expect, it } from "vitest";
import { checkElevenLabsVoice } from "../src/local/elevenlabs-voices.js";

function recordingLog() {
  const entries: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const push = (level: string) => (obj: unknown, msg?: string) => void entries.push({ level, obj, msg });
  const log = { level: "info", debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), child: () => log };
  return { log, entries };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const myVoices = {
  voices: [
    { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature", labels: { use_case: "conversational" } },
    { voice_id: "LIB1", name: "Juniper", labels: { use_case: "conversational" }, sharing: { status: "copied" } },
  ],
};

describe("checkElevenLabsVoice", () => {
  it("passes when the voice is in the account", async () => {
    const { log, entries } = recordingLog();
    const ok = await checkElevenLabsVoice("k", "V1", log, async () => json(200, { voice_id: "V1", name: "Sarah" }));
    expect(ok).toBe(true);
    expect(entries[0]!.msg).toBe("elevenlabs voice ok");
  });

  const libraryFetch = (tier: string | undefined, sharedBody: unknown = { voices: [{ voice_id: "LIB1", name: "Juniper - Grounded and Professional" }] }) =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v1/voices/")) return json(404, { detail: "voice_not_found" });
      if (u.includes("/v2/voices")) return json(200, myVoices);
      if (u.includes("/v1/user/subscription")) return tier ? json(200, { tier }) : json(401, {});
      if (typeof sharedBody === "string") return new Response(sharedBody, { status: 200 });
      return json(200, sharedBody);
    }) as typeof fetch;

  it("names the plan limit when a Voice Library voice is used on the free plan", async () => {
    const { log, entries } = recordingLog();
    expect(await checkElevenLabsVoice("k", "LIB1", log, libraryFetch("free"))).toBe(false);
    const err = entries.find((e) => e.level === "error")!;
    expect(err.msg).toMatch(/Voice Library voice, which ElevenLabs only allows over the API on paid plans/);
    expect(err.obj).toMatchObject({ name: "Juniper - Grounded and Professional", tier: "free", suggestions: ["Sarah EXAVITQu4vr4xnSDxMaL"] });
  });

  it("accepts a Voice Library voice on a paid plan", async () => {
    const { log, entries } = recordingLog();
    expect(await checkElevenLabsVoice("k", "LIB1", log, libraryFetch("starter"))).toBe(true);
    expect(entries.some((e) => e.level === "error")).toBe(false);
  });

  it("flags a library voice already added to the account when the plan is free", async () => {
    const copied = (tier: string) =>
      (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/v1/voices/")) return json(200, { voice_id: "LIB1", name: "Juniper", sharing: { status: "copied" } });
        if (u.includes("/v1/user/subscription")) return json(200, { tier });
        return json(200, myVoices);
      }) as typeof fetch;
    const free = recordingLog();
    expect(await checkElevenLabsVoice("k", "LIB1", free.log, copied("free"))).toBe(false);
    expect(free.entries.find((e) => e.level === "error")!.obj).toMatchObject({ name: "Juniper", tier: "free" });
    const paid = recordingLog();
    expect(await checkElevenLabsVoice("k", "LIB1", paid.log, copied("creator"))).toBe(true);
    expect(paid.entries.some((e) => e.level === "error")).toBe(false);
  });

  it("keeps the not-in-library error when the library lookup returns garbage", async () => {
    const { log, entries } = recordingLog();
    expect(await checkElevenLabsVoice("k", "LIB1", log, libraryFetch("free", "<html>oops"))).toBe(false);
    expect(entries.find((e) => e.level === "error")!.msg).toMatch(/not in your library/);
  });

  it("falls back to the not-in-library message for unknown ids", async () => {
    const { log, entries } = recordingLog();
    const fetchImpl = async (url: string | URL | Request) => (String(url).includes("/v2/voices") ? json(200, myVoices) : String(url).includes("shared-voices") ? json(200, { voices: [] }) : json(404, {}));
    expect(await checkElevenLabsVoice("k", "NOPE", log, fetchImpl as typeof fetch)).toBe(false);
    expect(entries.find((e) => e.level === "error")!.msg).toMatch(/not in your library/);
  });
});
