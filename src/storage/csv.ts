import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { stringify } from "csv-stringify/sync";
import { flattenQuestions, type Questionnaire } from "../screening/schema.js";

export type CallOutcome =
  | "completed"
  | "partial"
  | "declined"
  | "callback_requested"
  | "wrong_person"
  | "voicemail"
  | "no_response"
  | "hung_up"
  | "no_answer"
  | "busy"
  | "failed";

export type EligibleFlag = "yes" | "no" | "undetermined";

export interface CallRecord {
  contact_id: string;
  phone: string;
  call_sid: string;
  attempt: number;
  started_at: string;
  ended_at: string;
  duration_s: number;
  outcome: CallOutcome;
  eligible: EligibleFlag;
  /** Normalized answers keyed by question id (already rendered as CSV strings). */
  answers: Record<string, string>;
  /** The person's own words per question id (optional). */
  verbatim: Record<string, string>;
  callback_when: string;
  notes: string;
  transcript_path: string;
  recording_sid: string;
}

const FIXED_HEAD = ["contact_id", "phone", "call_sid", "attempt", "started_at", "ended_at", "duration_s", "outcome", "eligible"] as const;
const FIXED_TAIL = ["callback_when", "notes", "transcript_path", "recording_sid"] as const;

/** Column order is derived from the questionnaire so the CSV stays stable and readable. */
export function csvColumns(q: Questionnaire): string[] {
  const questionIds = flattenQuestions(q).map((x) => x.id);
  const verbatimCols = q.settings.store_verbatim ? questionIds.map((id) => `${id}__verbatim`) : [];
  return [...FIXED_HEAD, ...questionIds, ...verbatimCols, ...FIXED_TAIL];
}

export function recordToRow(q: Questionnaire, r: CallRecord): string[] {
  const cols = csvColumns(q);
  const flat: Record<string, string> = {
    contact_id: r.contact_id,
    phone: r.phone,
    call_sid: r.call_sid,
    attempt: String(r.attempt),
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_s: String(r.duration_s),
    outcome: r.outcome,
    eligible: r.eligible,
    callback_when: r.callback_when,
    notes: r.notes,
    transcript_path: r.transcript_path,
    recording_sid: r.recording_sid,
  };
  for (const [id, v] of Object.entries(r.answers)) flat[id] = v;
  for (const [id, v] of Object.entries(r.verbatim)) flat[`${id}__verbatim`] = v;
  return cols.map((c) => flat[c] ?? "");
}

/** The CSV columns and values for one record, keyed by column; how results are kept outside CSV files. */
export function recordToFields(q: Questionnaire, r: CallRecord): Record<string, string> {
  const row = recordToRow(q, r);
  return Object.fromEntries(csvColumns(q).map((c, i) => [c, row[i] ?? ""]));
}

/**
 * CSV text for stored result rows: the current questionnaire's columns first, then any
 * columns only older rows have, so editing the questionnaire never drops collected data.
 */
export function fieldsToCsv(q: Questionnaire, rows: Array<Record<string, string>>): string {
  const columns = csvColumns(q);
  const known = new Set(columns);
  for (const row of rows) for (const key of Object.keys(row)) if (!known.has(key)) (known.add(key), columns.push(key));
  return stringify([columns, ...rows.map((row) => columns.map((c) => row[c] ?? ""))]);
}

export class CsvHeaderMismatchError extends Error {
  constructor(path: string, expected: string[], found: string[]) {
    super(
      `The CSV at ${path} has a header that does not match the current questionnaire.\n` +
        `  expected: ${expected.join(",")}\n` +
        `  found:    ${found.join(",")}\n` +
        `Point OUTPUT_CSV at a new file or align the questionnaire; the existing file was left untouched.`,
    );
    this.name = "CsvHeaderMismatchError";
  }
}

async function readHeader(path: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.trim().length === 0) return null;
  return firstLine.split(",").map((c) => c.replace(/^"|"$/g, ""));
}

/**
 * Appends one row, creating the file with a header when needed. Guarded by a
 * lock so several calls finishing at once cannot interleave writes.
 */
export async function appendCallRecord(path: string, q: Questionnaire, record: CallRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const columns = csvColumns(q);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 10, minTimeout: 50, maxTimeout: 500 } });
  try {
    const existing = await readHeader(path);
    if (existing && (existing.length !== columns.length || existing.some((c, i) => c !== columns[i]))) {
      throw new CsvHeaderMismatchError(path, columns, existing);
    }
    const rows: string[][] = [];
    if (!existing) rows.push(columns);
    rows.push(recordToRow(q, record));
    const text = stringify(rows);
    const handle = await open(path, "a");
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
  } finally {
    await release();
  }
}

export async function csvExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
