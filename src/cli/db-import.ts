import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { isAnalysisCurrent, transcriptHash } from "../analytics/analyze.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { FileAnalyticsStore } from "../storage/file-store.js";
import { PgStorage } from "../storage/pg-store.js";
import type { ResultSource } from "../storage/store.js";
import { transcriptFileId } from "../storage/transcripts.js";

/**
 * Copies the local data/ files (transcripts, analyses, both results CSVs) into the Postgres
 * database in DATABASE_URL, so a deployed admin panel starts with your existing calls.
 * Safe to re-run: anything already in the database is left as it is.
 * Usage: DATABASE_URL=postgres://... npm run db:import
 */
async function readCsvRows(path: string): Promise<Array<Record<string, string>>> {
  try {
    return parse(await readFile(path, "utf8"), { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const e = env();
  if (!e.DATABASE_URL) {
    console.error("Set DATABASE_URL to the Postgres connection string to import into (see README: Deploy free on Render + Neon).");
    process.exit(2);
  }
  const files = new FileAnalyticsStore(e.TRANSCRIPTS_DIR, e.ANALYSIS_DIR);
  const db = await PgStorage.connect(e.DATABASE_URL, logger);
  try {
    const counts = { transcripts: 0, analyses: 0, results: 0, skipped: 0 };
    for (const t of await files.listTranscripts()) {
      const sid = transcriptFileId(t.callSid);
      if (await db.transcript(sid)) counts.skipped++;
      else {
        await db.saveTranscript(t, { overwrite: false });
        counts.transcripts++;
      }
      const analysis = await files.analysis(sid);
      // Re-stamp current analyses with the canonical hash so they still match after the jsonb round trip.
      const copy = analysis && isAnalysisCurrent(analysis, t) ? { ...analysis, transcriptHash: transcriptHash(t) } : analysis;
      if (copy && (await db.saveAnalysis(copy, { overwrite: false }))) counts.analyses++;
    }
    const sources: Array<[ResultSource, string]> = [
      ["phone", e.OUTPUT_CSV],
      ["local", e.LOCAL_OUTPUT_CSV],
    ];
    for (const [source, path] of sources) {
      for (const row of await readCsvRows(path)) {
        if (!row.call_sid) continue;
        if (await db.insertResultFields(source, row.call_sid, row, row.ended_at || row.started_at || undefined)) counts.results++;
        else counts.skipped++;
      }
    }
    console.log(`Imported ${counts.transcripts} transcripts, ${counts.analyses} analyses and ${counts.results} result rows; ${counts.skipped} already in the database.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
