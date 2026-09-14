import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCallRecord, csvColumns, CsvHeaderMismatchError, type CallRecord } from "../src/storage/csv.js";
import { sampleQuestionnaire } from "./helpers.js";

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    contact_id: "C1",
    phone: "+15550001111",
    call_sid: "CA123",
    attempt: 1,
    started_at: "2026-09-14T10:00:00.000Z",
    ended_at: "2026-09-14T10:06:00.000Z",
    duration_s: 360,
    outcome: "completed",
    eligible: "yes",
    answers: { age: "42", diagnosed_insomnia: "yes", smoker: "never" },
    verbatim: { age: 'said "forty-two, last May"' },
    callback_when: "",
    notes: "",
    transcript_path: "data/calls/CA123.json",
    recording_sid: "",
    ...overrides,
  };
}

describe("csv storage", () => {
  it("creates the header once and appends rows in questionnaire column order", async () => {
    const q = sampleQuestionnaire();
    const dir = await mkdtemp(join(tmpdir(), "screener-"));
    const path = join(dir, "out.csv");
    await appendCallRecord(path, q, record());
    await appendCallRecord(path, q, record({ call_sid: "CA456", eligible: "no", outcome: "partial" }));
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(csvColumns(q).join(","));
    expect(lines[1]).toContain('"said ""forty-two, last May"""');
    expect(lines[2]).toMatch(/^C1,\+15550001111,CA456,1,/);
  });

  it("refuses to append to a file whose header does not match", async () => {
    const q = sampleQuestionnaire();
    const dir = await mkdtemp(join(tmpdir(), "screener-"));
    const path = join(dir, "other.csv");
    await writeFile(path, "foo,bar\n1,2\n");
    await expect(appendCallRecord(path, q, record())).rejects.toBeInstanceOf(CsvHeaderMismatchError);
    expect(await readFile(path, "utf8")).toBe("foo,bar\n1,2\n");
  });

  it("serializes concurrent appends", async () => {
    const q = sampleQuestionnaire();
    const dir = await mkdtemp(join(tmpdir(), "screener-"));
    const path = join(dir, "concurrent.csv");
    await Promise.all(Array.from({ length: 6 }, (_, i) => appendCallRecord(path, q, record({ call_sid: `CA${i}` }))));
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(7);
    expect(new Set(lines.slice(1).map((l) => l.split(",")[2]))).toEqual(new Set(["CA0", "CA1", "CA2", "CA3", "CA4", "CA5"]));
  });
});
