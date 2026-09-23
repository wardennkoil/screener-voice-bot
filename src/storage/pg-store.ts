import pg from "pg";
import type { StoredAnalysis } from "../analytics/analyze.js";
import type { Logger } from "../logger.js";
import type { Questionnaire } from "../screening/schema.js";
import { fieldsToCsv, recordToFields, type CallRecord } from "./csv.js";
import type { AnalyticsStore, CallStore, ResultSource, Storage } from "./store.js";
import { isValidSid, transcriptFileId, type Transcript } from "./transcripts.js";

/** The slice of a Postgres client this store needs; satisfied by pg.Pool and by PGlite in tests. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One statement each: PGlite's query() takes a single statement. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS transcripts (
     sid text PRIMARY KEY,
     started_at timestamptz NOT NULL,
     data jsonb NOT NULL,
     saved_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS transcripts_started_at ON transcripts (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS call_results (
     id bigserial PRIMARY KEY,
     source text NOT NULL,
     call_sid text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     fields jsonb NOT NULL,
     UNIQUE (source, call_sid))`,
  `CREATE TABLE IF NOT EXISTS analyses (
     sid text PRIMARY KEY,
     data jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now())`,
];

/**
 * Transcripts, results and analyses in Postgres, for hosts without a persistent disk
 * (Render's free plan). Results are kept as their CSV fields so the export matches the
 * CSV files exactly and survives questionnaire changes.
 */
export class PgStorage implements Storage {
  readonly kind = "postgres" as const;
  readonly analytics: AnalyticsStore;

  constructor(
    private readonly db: SqlClient,
    private readonly onClose: () => Promise<void> = async () => {},
  ) {
    this.analytics = {
      listTranscripts: () => this.listTranscripts(),
      transcript: (sid) => this.transcript(sid),
      analysis: (sid) => this.analysis(sid),
      saveAnalysis: (a) => this.saveAnalysis(a).then(() => undefined),
      resultsCsv: (q, source) => this.resultsCsv(q, source),
    };
  }

  /** Connects with a small pool and creates the tables if needed. */
  static async connect(connectionString: string, log: Logger): Promise<PgStorage> {
    const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    // Neon closes idle connections when it scales to zero; without a listener that error would crash the process.
    pool.on("error", (err) => log.warn({ err: err.message }, "idle postgres connection closed"));
    const storage = new PgStorage(pool, () => pool.end());
    await storage.migrate();
    return storage;
  }

  async migrate(): Promise<void> {
    for (const sql of MIGRATIONS) await this.db.query(sql);
  }

  close(): Promise<void> {
    return this.onClose();
  }

  calls(source: ResultSource): CallStore {
    return {
      saveTranscript: (t) => this.saveTranscript(t),
      appendResult: (q, record) => this.appendResult(source, q, record).then(() => undefined),
    };
  }

  async saveTranscript(t: Transcript, opts: { overwrite?: boolean } = {}): Promise<string> {
    const sid = transcriptFileId(t.callSid);
    const onConflict = opts.overwrite === false ? "DO NOTHING" : "DO UPDATE SET data = EXCLUDED.data, started_at = EXCLUDED.started_at, saved_at = now()";
    await this.db.query(`INSERT INTO transcripts (sid, started_at, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (sid) ${onConflict}`, [sid, t.startedAt, JSON.stringify(t)]);
    return `db:transcripts/${sid}`;
  }

  /** Returns false when this call already has a result for the source (a re-run import, or a duplicate status callback). */
  async appendResult(source: ResultSource, q: Questionnaire, record: CallRecord): Promise<boolean> {
    return this.insertResultFields(source, record.call_sid, recordToFields(q, record));
  }

  async insertResultFields(source: ResultSource, callSid: string, fields: Record<string, string>, createdAt?: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO call_results (source, call_sid, fields, created_at) VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()))
       ON CONFLICT (source, call_sid) DO NOTHING RETURNING id`,
      [source, callSid, JSON.stringify(fields), createdAt ?? null],
    );
    return res.rows.length > 0;
  }

  async listTranscripts(): Promise<Transcript[]> {
    const res = await this.db.query(`SELECT data FROM transcripts ORDER BY started_at DESC`);
    return (res.rows as Array<{ data: Transcript }>).map((r) => r.data).filter((t) => Array.isArray(t?.turns));
  }

  async transcript(sid: string): Promise<Transcript | undefined> {
    if (!isValidSid(sid)) return undefined;
    const res = await this.db.query(`SELECT data FROM transcripts WHERE sid = $1`, [sid]);
    return (res.rows[0] as { data: Transcript } | undefined)?.data;
  }

  async analysis(sid: string): Promise<StoredAnalysis | undefined> {
    if (!isValidSid(sid)) return undefined;
    const res = await this.db.query(`SELECT data FROM analyses WHERE sid = $1`, [sid]);
    return (res.rows[0] as { data: StoredAnalysis } | undefined)?.data;
  }

  async saveAnalysis(a: StoredAnalysis, opts: { overwrite?: boolean } = {}): Promise<boolean> {
    if (!isValidSid(a.callSid)) throw new Error("invalid call id");
    const onConflict = opts.overwrite === false ? "DO NOTHING" : "DO UPDATE SET data = EXCLUDED.data, created_at = now()";
    const res = await this.db.query(`INSERT INTO analyses (sid, data) VALUES ($1, $2::jsonb) ON CONFLICT (sid) ${onConflict} RETURNING sid`, [a.callSid, JSON.stringify(a)]);
    return res.rows.length > 0;
  }

  async resultsCsv(q: Questionnaire, source: ResultSource): Promise<string> {
    const res = await this.db.query(`SELECT fields FROM call_results WHERE source = $1 ORDER BY created_at, id`, [source]);
    return fieldsToCsv(q, (res.rows as Array<{ fields: Record<string, string> }>).map((r) => r.fields));
  }
}
