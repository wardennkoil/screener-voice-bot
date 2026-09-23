import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import type { StoredAnalysis } from "../analytics/analyze.js";
import type { Questionnaire } from "../screening/schema.js";
import { appendCallRecord, csvColumns, type CallRecord } from "./csv.js";
import type { AnalyticsStore, CallStore, ResultSource, Storage } from "./store.js";
import { isValidSid, saveTranscript, type Transcript } from "./transcripts.js";

/** Writes each finished call as a JSON transcript plus one CSV row; either can be switched off. */
export class FileCallStore implements CallStore {
  constructor(
    private readonly csvPath: string | undefined,
    private readonly transcriptsDir: string | undefined,
  ) {}

  async saveTranscript(t: Transcript): Promise<string> {
    return this.transcriptsDir ? saveTranscript(this.transcriptsDir, t) : "";
  }

  async appendResult(q: Questionnaire, record: CallRecord): Promise<void> {
    if (this.csvPath) await appendCallRecord(this.csvPath, q, record);
  }
}

/** Transcripts and analyses as JSON files, results as the CSVs the calls append to. */
export class FileAnalyticsStore implements AnalyticsStore {
  /** Parsed files keyed by path, reused while size and mtime are unchanged (the panel polls every few seconds). */
  private readonly parsed = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

  constructor(
    private readonly transcriptsDir: string,
    private readonly analysisDir: string,
    private readonly csvPaths: Partial<Record<ResultSource, string>> = {},
  ) {}

  /** Cached values are shared between requests: treat them as read-only. */
  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      const st = await stat(path);
      const hit = this.parsed.get(path);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      this.parsed.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.parsed.delete(path);
        return undefined;
      }
      throw err;
    }
  }

  async listSids(): Promise<string[]> {
    try {
      const files = await readdir(this.transcriptsDir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter(isValidSid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listTranscripts(): Promise<Transcript[]> {
    const sids = await this.listSids();
    const all = await Promise.all(sids.map((sid) => this.transcript(sid).catch(() => undefined)));
    return all.filter((t): t is Transcript => Array.isArray(t?.turns)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  transcript(sid: string): Promise<Transcript | undefined> {
    if (!isValidSid(sid)) return Promise.resolve(undefined);
    return this.readJson<Transcript>(join(this.transcriptsDir, `${sid}.json`));
  }

  analysis(sid: string): Promise<StoredAnalysis | undefined> {
    if (!isValidSid(sid)) return Promise.resolve(undefined);
    return this.readJson<StoredAnalysis>(join(this.analysisDir, `${sid}.json`)).catch(() => undefined);
  }

  async saveAnalysis(a: StoredAnalysis): Promise<void> {
    if (!isValidSid(a.callSid)) throw new Error("invalid call id");
    await mkdir(this.analysisDir, { recursive: true });
    const path = join(this.analysisDir, `${a.callSid}.json`);
    this.parsed.delete(path);
    await writeFile(path, JSON.stringify(a, null, 2), "utf8");
  }

  async resultsCsv(q: Questionnaire, source: ResultSource): Promise<string> {
    const path = this.csvPaths[source];
    try {
      if (path) return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return stringify([csvColumns(q)]);
  }
}

export interface FileStorageOptions {
  transcriptsDir: string;
  analysisDir: string;
  csv: Record<ResultSource, string>;
}

/** Today's layout under data/: the default whenever DATABASE_URL is not set. */
export function fileStorage(opts: FileStorageOptions): Storage {
  const analytics = new FileAnalyticsStore(opts.transcriptsDir, opts.analysisDir, opts.csv);
  return {
    kind: "files",
    calls: (source) => new FileCallStore(opts.csv[source], opts.transcriptsDir),
    analytics,
    close: async () => {},
  };
}
