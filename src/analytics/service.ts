import type { LlmAdapter } from "../conversation/llm.js";
import type { Logger } from "../logger.js";
import type { Questionnaire } from "../screening/schema.js";
import type { Transcript } from "../storage/transcripts.js";
import { analyzeCall, transcriptHash, type StoredAnalysis } from "./analyze.js";
import { isValidSid, type AnalyticsStore } from "./store.js";

export type AnalysisStatus = "none" | "queued" | "running" | "done" | "stale" | "error" | "too_short";

export interface AnalysisServiceDeps {
  store: AnalyticsStore;
  questionnaire: Questionnaire;
  llm: LlmAdapter;
  /** Recorded with each analysis so you can tell which model wrote it. */
  model: string;
  log: Logger;
  concurrency?: number;
}

/** Fewer person turns than this and there is nothing worth a model request. */
export const MIN_PERSON_TURNS = 2;

export function isTooShort(t: Transcript): boolean {
  return t.turns.filter((x) => x.role === "person").length < MIN_PERSON_TURNS;
}

/** Background queue that analyzes calls a couple at a time and caches the results on disk. */
export class AnalysisService {
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly errors = new Map<string, string>();
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: AnalysisServiceDeps) {}

  get model(): string {
    return this.deps.model;
  }

  /** Accepts a raw call SID or a transcript file id (same sanitizing as saveTranscript). */
  enqueue(callSid: string): boolean {
    const sid = callSid.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!isValidSid(sid) || this.queue.includes(sid) || this.running.has(sid)) return false;
    this.errors.delete(sid);
    this.queue.push(sid);
    this.pump();
    return true;
  }

  /** Status without touching disk for in-flight work; pass the stored analysis and transcript for the rest. */
  status(sid: string, t: Transcript | undefined, stored: StoredAnalysis | undefined): { status: AnalysisStatus; error?: string } {
    if (this.running.has(sid)) return { status: "running" };
    if (this.queue.includes(sid)) return { status: "queued" };
    const error = this.errors.get(sid);
    if (error) return { status: "error", error };
    if (stored) return { status: t && stored.transcriptHash !== transcriptHash(t) ? "stale" : "done" };
    if (t && isTooShort(t)) return { status: "too_short" };
    return { status: "none" };
  }

  /** Queues every call without a current analysis. Returns how many were queued. */
  async analyzeAllPending(): Promise<number> {
    let n = 0;
    for (const t of await this.deps.store.listTranscripts()) {
      const sid = this.sidOf(t);
      if (isTooShort(t)) continue;
      const stored = await this.deps.store.analysis(sid);
      if (stored && stored.transcriptHash === transcriptHash(t)) continue;
      if (this.enqueue(sid)) n++;
    }
    return n;
  }

  /** Resolves when nothing is queued or running (tests and shutdown). */
  idle(): Promise<void> {
    if (!this.queue.length && !this.running.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  sidOf(t: Transcript): string {
    return t.callSid.replace(/[^A-Za-z0-9_-]/g, "_");
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? 2;
    while (this.running.size < limit && this.queue.length) {
      const sid = this.queue.shift()!;
      this.running.add(sid);
      void this.run(sid).finally(() => {
        this.running.delete(sid);
        this.pump();
        if (!this.queue.length && !this.running.size) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }

  private async run(sid: string): Promise<void> {
    const log = this.deps.log.child({ callSid: sid });
    try {
      const t = await this.deps.store.transcript(sid);
      if (!t) throw new Error("transcript not found");
      if (isTooShort(t)) return;
      const started = Date.now();
      const analysis = await analyzeCall(t, this.deps.questionnaire, this.deps.llm);
      await this.deps.store.saveAnalysis({ callSid: sid, model: this.deps.model, createdAt: new Date().toISOString(), transcriptHash: transcriptHash(t), analysis });
      log.info({ ms: Date.now() - started, deviations: analysis.deviations.length, sentiment: analysis.sentiment.label }, "call analyzed");
    } catch (err) {
      this.errors.set(sid, (err as Error).message);
      log.warn({ err }, "call analysis failed");
    }
  }
}
