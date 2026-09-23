import { PGlite } from "@electric-sql/pglite";
import { parse } from "csv-parse/sync";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildApp } from "../src/app.js";
import { isAnalysisCurrent, transcriptHash } from "../src/analytics/analyze.js";
import { AnalysisService } from "../src/analytics/service.js";
import type { LlmAdapter } from "../src/conversation/llm.js";
import { CallSession } from "../src/conversation/session.js";
import type { CallRecord } from "../src/storage/csv.js";
import { PgStorage } from "../src/storage/pg-store.js";
import { sampleTranscript, stubAnalyst } from "./analytics-fixture.js";
import { sampleQuestionnaire } from "./helpers.js";

const q = sampleQuestionnaire();
const log = pino({ level: "silent" });

function record(callSid: string, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    contact_id: "C1",
    phone: "+15550001111",
    call_sid: callSid,
    attempt: 1,
    started_at: "2026-09-16T15:31:47.000Z",
    ended_at: "2026-09-16T15:33:47.000Z",
    duration_s: 120,
    outcome: "completed",
    eligible: "yes",
    answers: { age: "22", smoker: "never" },
    verbatim: { age: "I'm twenty two." },
    callback_when: "",
    notes: "",
    transcript_path: `db:transcripts/${callSid}`,
    recording_sid: "",
    ...extra,
  };
}

describe("Postgres storage (PGlite)", () => {
  let db: PGlite;
  let storage: PgStorage;

  beforeEach(async () => {
    db = new PGlite();
    storage = new PgStorage(db);
    await storage.migrate();
    await storage.migrate(); // startup runs this every boot; it must be repeatable
  });
  afterEach(async () => db.close());

  it("saves, replaces and lists transcripts newest first", async () => {
    const older = sampleTranscript("CA/1");
    const newer = { ...sampleTranscript("LOCAL-2"), startedAt: "2026-09-17T10:00:00.000Z" };
    expect(await storage.saveTranscript(older)).toBe("db:transcripts/CA_1");
    await storage.saveTranscript(newer);
    expect((await storage.listTranscripts()).map((t) => t.callSid)).toEqual(["LOCAL-2", "CA/1"]);

    await storage.saveTranscript({ ...older, outcome: "partial" });
    expect((await storage.transcript("CA_1"))?.outcome).toBe("partial");
    // Import mode never overwrites what is already there.
    await storage.saveTranscript({ ...older, outcome: "declined" }, { overwrite: false });
    expect((await storage.transcript("CA_1"))?.outcome).toBe("partial");
    expect(await storage.transcript("../etc")).toBeUndefined();
  });

  it("keeps one result per call and exports CSV that survives questionnaire changes", async () => {
    const calls = storage.calls("local");
    await calls.appendResult(q, record("LOCAL-1"));
    await calls.appendResult(q, record("LOCAL-1", { outcome: "partial" })); // duplicate callback: ignored
    await storage.insertResultFields("local", "LOCAL-0", { call_sid: "LOCAL-0", outcome: "hung_up", retired_question: "yes" }, "2026-09-01T00:00:00.000Z");
    await storage.calls("phone").appendResult(q, record("CA-9"));

    const rows = parse(await storage.resultsCsv(q, "local"), { columns: true }) as Array<Record<string, string>>;
    expect(rows.map((r) => r.call_sid)).toEqual(["LOCAL-0", "LOCAL-1"]);
    expect(rows[1]).toMatchObject({ outcome: "completed", age: "22", age__verbatim: "I'm twenty two.", smoker: "never" });
    // A column the current questionnaire no longer has is kept at the end.
    expect(rows[0]!.retired_question).toBe("yes");
    expect((parse(await storage.resultsCsv(q, "phone"), { columns: true }) as unknown[]).length).toBe(1);
  });

  it("hashes a transcript the same after the jsonb round trip, so analyses do not all look out of date", async () => {
    const original = sampleTranscript("LOCAL-7");
    await storage.saveTranscript(original);
    const roundTripped = (await storage.transcript("LOCAL-7"))!;
    expect(JSON.stringify(roundTripped.turns[0])).not.toBe(JSON.stringify(original.turns[0])); // jsonb really reorders keys
    expect(transcriptHash(roundTripped)).toBe(transcriptHash(original));
    // Analyses saved before canonical hashing (file key order) still count as current for the file transcript.
    const legacy = createHash("sha256").update(JSON.stringify({ turns: original.turns, toolCalls: original.toolCalls })).digest("hex").slice(0, 16);
    expect(isAnalysisCurrent({ transcriptHash: legacy }, original)).toBe(true);
    expect(isAnalysisCurrent({ transcriptHash: "0000000000000000" }, original)).toBe(false);
  });

  it("stores and replaces analyses", async () => {
    const a = { callSid: "LOCAL-1", model: "m1", createdAt: "2026-09-16T00:00:00.000Z", transcriptHash: "h1", analysis: { summary: "one" } as never };
    await storage.analytics.saveAnalysis(a);
    await storage.analytics.saveAnalysis({ ...a, model: "m2" });
    expect((await storage.analytics.analysis("LOCAL-1"))?.model).toBe("m2");
    expect(await storage.saveAnalysis({ ...a, model: "m3" }, { overwrite: false })).toBe(false);
    expect(await storage.analytics.analysis("nope")).toBeUndefined();
  });

  it("carries a finished call from the session through the admin panel and into the CSV download", async () => {
    // 1. A laptop call that ends with a decline, saved through the Postgres call store.
    let turn = 0;
    const llm: LlmAdapter = {
      async run(_p, h) {
        if (turn++ === 0) {
          h.onText("Hi, is this Jordan?");
          return { steps: [{ type: "model_output", content: [{ type: "text", text: "Hi, is this Jordan?" }] }], toolCalls: [], text: "Hi, is this Jordan?", aborted: false };
        }
        const text = "Thanks, take care, goodbye.";
        h.onText(text);
        const call = { id: "c1", name: "end_call", args: { reason: "declined" } };
        return { steps: [{ type: "model_output", content: [{ type: "text", text }] }, { type: "function_call", id: "c1", name: call.name, arguments: call.args }], toolCalls: [call], text, aborted: false };
      },
    };
    const finished: CallRecord[] = [];
    const session = new CallSession({
      callSid: "LOCAL-42",
      contact: { contactId: "local", phone: "+10000000000", firstName: "Jordan" },
      questionnaire: q,
      llm,
      transport: { sendText: () => {}, end: () => {} },
      log,
      recordingEnabled: false,
      store: storage.calls("local"),
      onFinished: (r) => finished.push(r),
    });
    session.start();
    session.onPrompt("Hello?", true);
    await new Promise((r) => setTimeout(r, 20));
    session.onPrompt("Not interested, thanks.", true);
    await new Promise((r) => setTimeout(r, 30));
    session.onClose();
    await session.finalize();
    expect(finished[0]).toMatchObject({ outcome: "declined", transcript_path: "db:transcripts/LOCAL-42" });

    // 2. The admin panel reads it from Postgres, analyzes it, and serves the results CSV.
    const service = new AnalysisService({ store: storage.analytics, questionnaire: q, llm: stubAnalyst(), model: "stub", log });
    const app = await buildApp({
      questionnaire: q,
      llm,
      voice: { elevenLabsVoice: "V", eotThreshold: 0.7, interruptSensitivity: "medium" },
      recordingEnabled: false,
      store: storage.calls("phone"),
      log,
      admin: { store: storage.analytics, service },
    });
    try {
      const list = (await app.inject({ url: "/admin/api/calls" })).json() as { calls: Array<{ sid: string; outcome: string }> };
      expect(list.calls).toEqual([expect.objectContaining({ sid: "LOCAL-42", outcome: "declined" })]);
      expect((await app.inject({ method: "POST", url: "/admin/api/calls/LOCAL-42/analyze" })).statusCode).toBe(202);
      await service.idle();
      const detail = (await app.inject({ url: "/admin/api/calls/LOCAL-42" })).json() as { analysisStatus: string };
      expect(detail.analysisStatus).toBe("done");

      const csv = await app.inject({ url: "/admin/api/results.csv?source=local" });
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.headers["content-disposition"]).toContain("screening-results-laptop.csv");
      const rows = parse(csv.body, { columns: true }) as Array<Record<string, string>>;
      expect(rows).toEqual([expect.objectContaining({ call_sid: "LOCAL-42", outcome: "declined", transcript_path: "db:transcripts/LOCAL-42" })]);
      expect(parse((await app.inject({ url: "/admin/api/results.csv?source=phone" })).body)).toHaveLength(1); // header only
    } finally {
      await app.close();
    }
  });
});
