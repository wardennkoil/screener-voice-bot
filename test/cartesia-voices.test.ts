import pino from "pino";
import { describe, expect, it } from "vitest";
import { checkCartesiaVoice } from "../src/local/cartesia-voices.js";

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = new URL(url).pathname + new URL(url).search;
    const r = routes[path] ?? { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

const log = pino({ level: "silent" });

describe("checkCartesiaVoice", () => {
  it("accepts a known voice and sends the key and API version", async () => {
    const f = fakeFetch({ "/voices/katie": { status: 200, body: { id: "katie", name: "Katie" } } });
    expect(await checkCartesiaVoice("key", "katie", log, f.impl)).toBe(true);
    expect(f.calls[0]!.headers).toEqual({ Authorization: "Bearer key", "Cartesia-Version": "2026-08-14" });
  });

  it("flags a rejected key", async () => {
    const f = fakeFetch({ "/voices/katie": { status: 401 } });
    expect(await checkCartesiaVoice("bad", "katie", log, f.impl)).toBe(false);
  });

  it("flags an unknown voice and looks up suggestions", async () => {
    const f = fakeFetch({ "/voices?limit=8&language=en": { status: 200, body: { data: [{ id: "a1", name: "Skylar" }] } } });
    expect(await checkCartesiaVoice("key", "nope", log, f.impl)).toBe(false);
    expect(f.calls.map((c) => c.url)).toContain("https://api.cartesia.ai/voices?limit=8&language=en");
  });

  it("does not block startup when Cartesia is unreachable", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await checkCartesiaVoice("key", "katie", log, impl)).toBe(true);
  });
});
