import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AnalysisService } from "../src/analytics/service.js";
import { FileAnalyticsStore, FileCallStore } from "../src/storage/file-store.js";
import type { LlmAdapter } from "../src/conversation/llm.js";
import { sampleTranscript, stubAnalyst } from "./analytics-fixture.js";
import { sampleQuestionnaire } from "./helpers.js";

const log = pino({ level: "silent" });
const noLlm: LlmAdapter = { run: async () => ({ steps: [], toolCalls: [], text: "", aborted: false }) };

async function setup(token?: string) {
  const dir = await mkdtemp(join(tmpdir(), "admin-"));
  const calls = join(dir, "calls");
  const analysis = join(dir, "analysis");
  await mkdir(calls);
  await writeFile(join(calls, "LOCAL-1.json"), JSON.stringify(sampleTranscript("LOCAL-1")));
  const short = sampleTranscript("LOCAL-2");
  short.turns = short.turns.slice(0, 1);
  await writeFile(join(calls, "LOCAL-2.json"), JSON.stringify(short));
  const store = new FileAnalyticsStore(calls, analysis);
  const analyst = stubAnalyst();
  const service = new AnalysisService({ store, questionnaire: sampleQuestionnaire(), llm: analyst, model: "stub:model", log });
  const app = await buildApp({
    questionnaire: sampleQuestionnaire(),
    llm: noLlm,
    voice: { elevenLabsVoice: "V", eotThreshold: 0.7, interruptSensitivity: "medium" },
    recordingEnabled: false,
    store: new FileCallStore(undefined, calls),
    accessToken: token,
    log,
    admin: { store, service },
  });
  return { app, dir, analysis, service, analyst };
}

describe("admin panel", () => {
  let cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.map((f) => f()));
    cleanup = [];
  });
  const make = async (token?: string) => {
    const s = await setup(token);
    cleanup.push(() => s.app.close(), () => rm(s.dir, { recursive: true, force: true }));
    return s;
  };

  it("without a token, answers localhost only and refuses tunneled requests", async () => {
    const { app } = await make();
    expect((await app.inject({ url: "/admin" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/calls", headers: { "x-forwarded-for": "1.2.3.4" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/api/calls", remoteAddress: "10.0.0.5" })).statusCode).toBe(401);
    // DNS rebinding: a page on another name resolved to 127.0.0.1 still carries its own Host.
    expect((await app.inject({ url: "/admin/api/calls", headers: { host: "attacker.example:3000" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/api/calls", headers: { host: "127.0.0.1:3000" } })).statusCode).toBe(200);
  });

  it("refuses cross-site POSTs that would start paid analysis runs", async () => {
    const { app } = await make();
    const evil = await app.inject({ method: "POST", url: "/admin/api/analyze-pending", headers: { host: "localhost:3000", origin: "https://attacker.example" } });
    expect(evil.statusCode).toBe(403);
    const same = await app.inject({ method: "POST", url: "/admin/api/analyze-pending", headers: { host: "localhost:3000", origin: "http://localhost:3000" } });
    expect(same.statusCode).toBe(202);
  });

  it("with a token, accepts bearer or the cookie set by the login link", async () => {
    const token = "secret-token-123";
    const { app } = await make(token);
    expect((await app.inject({ url: "/admin/api/calls" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/api/calls", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "1.2.3.4" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin?token=wrong" })).statusCode).toBe(401);
    const login = await app.inject({ url: `/admin?token=${token}` });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/admin");
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(String(login.headers["set-cookie"])).toContain("HttpOnly");
    expect((await app.inject({ url: "/admin/api/overview", headers: { cookie } })).statusCode).toBe(200);
  });

  it("lists calls and serves a call with stats and planned questions", async () => {
    const { app } = await make();
    const list = (await app.inject({ url: "/admin/api/calls" })).json();
    expect(list.calls.map((c: { sid: string }) => c.sid).sort()).toEqual(["LOCAL-1", "LOCAL-2"]);
    const short = list.calls.find((c: { sid: string }) => c.sid === "LOCAL-2");
    expect(short.analysisStatus).toBe("too_short");
    const d = (await app.inject({ url: "/admin/api/calls/LOCAL-1" })).json();
    expect(d.turns[6].note).toContain("interrupted");
    expect(d.stats.toolErrors).toHaveLength(1);
    expect(d.plan[0].id).toBe("age");
    expect(d.analysis).toBeNull();
    expect(d.analysisStatus).toBe("none");
  });

  it("rejects bad call ids", async () => {
    const { app } = await make();
    expect((await app.inject({ url: "/admin/api/calls/..%2F..%2Fetc" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/admin/api/calls/nope/analyze" })).statusCode).toBe(404);
  });

  it("analyzes a call in the background, caches it and reports it", async () => {
    const { app, service, analysis, analyst } = await make();
    expect((await app.inject({ method: "POST", url: "/admin/api/calls/LOCAL-1/analyze" })).statusCode).toBe(202);
    await service.idle();
    const saved = JSON.parse(await readFile(join(analysis, "LOCAL-1.json"), "utf8"));
    expect(saved.model).toBe("stub:model");
    const d = (await app.inject({ url: "/admin/api/calls/LOCAL-1" })).json();
    expect(d.analysisStatus).toBe("done");
    expect(d.analysis.stale).toBe(false);
    expect(d.analysis.analysis.deviations[0].kind).toBe("answer_changed");
    const o = (await app.inject({ url: "/admin/api/overview" })).json();
    expect(o.analyzed).toBe(1);
    // Already current and the short call is skipped, so nothing more is queued.
    expect((await app.inject({ method: "POST", url: "/admin/api/analyze-pending" })).json()).toEqual({ queued: 0 });
    expect(analyst.calls).toHaveLength(1);
  });

  it("records analysis failures without crashing", async () => {
    const { app, service } = await make();
    (service as unknown as { deps: { llm: LlmAdapter } }).deps.llm = noLlm;
    await app.inject({ method: "POST", url: "/admin/api/analyze-pending" });
    await service.idle();
    const d = (await app.inject({ url: "/admin/api/calls/LOCAL-1" })).json();
    expect(d.analysisStatus).toBe("error");
    expect(d.analysisError).toMatch(/no analysis/);
  });
});
