import type { StoredAnalysis } from "../analytics/analyze.js";
import type { Questionnaire } from "../screening/schema.js";
import type { CallRecord } from "./csv.js";
import type { Transcript } from "./transcripts.js";

/** Which path a call came through; each keeps its own results table/CSV. */
export type ResultSource = "phone" | "local";

/** Where a finished call is written. */
export interface CallStore {
  /** Saves (or replaces) the transcript; returns where it went, recorded as the result's transcript_path. */
  saveTranscript(t: Transcript): Promise<string>;
  appendResult(q: Questionnaire, record: CallRecord): Promise<void>;
}

/** What the admin panel reads and writes. */
export interface AnalyticsStore {
  /** All transcripts, newest first; unreadable entries are skipped. */
  listTranscripts(): Promise<Transcript[]>;
  transcript(sid: string): Promise<Transcript | undefined>;
  analysis(sid: string): Promise<StoredAnalysis | undefined>;
  saveAnalysis(a: StoredAnalysis): Promise<void>;
  /** The results for one source as CSV text (header only when there are none). */
  resultsCsv(q: Questionnaire, source: ResultSource): Promise<string>;
}

/** A storage backend: files under data/ locally, Postgres when DATABASE_URL is set. */
export interface Storage {
  readonly kind: "files" | "postgres";
  calls(source: ResultSource): CallStore;
  readonly analytics: AnalyticsStore;
  close(): Promise<void>;
}
