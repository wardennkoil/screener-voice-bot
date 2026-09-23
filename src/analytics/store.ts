import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Transcript } from "../storage/transcripts.js";
import type { StoredAnalysis } from "./analyze.js";

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid);
}

/** Read-side access to saved transcripts and their cached analyses. */
export class AnalyticsStore {
  /** Parsed files keyed by path, reused while size and mtime are unchanged (the panel polls every few seconds). */
  private readonly parsed = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

  constructor(
    private readonly transcriptsDir: string,
    private readonly analysisDir: string,
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

  /** All transcripts, newest first; unreadable files are skipped. */
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
}
