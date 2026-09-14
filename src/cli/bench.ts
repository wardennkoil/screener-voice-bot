import { parseArgs } from "node:util";
import { env } from "../config.js";
import { createLlm } from "../conversation/llm-factory.js";
import { logger } from "../logger.js";
import { loadQuestionnaire } from "../screening/loader.js";
import { percentile, runSimulation } from "./sim-core.js";

/**
 * Compare models on the thing that matters for a phone call: time to first
 * token and whether they drive the screening correctly.
 *   npm run bench -- --models google/gemini-3.8-flash,openai/gpt-5.6-luna,anthropic/claude-sonnet-5 --persona eligible --n 3
 * The participant is always played by the model in OPENROUTER_MODEL / --person-model so runs are comparable.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { models: { type: "string" }, persona: { type: "string" }, n: { type: "string" }, out: { type: "string" }, "person-model": { type: "string" } } });
  const models = (values.models ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("pass --models a,b,c");
  const personaName = values.persona ?? "eligible";
  const runs = Number(values.n ?? 2);
  const e = env();
  const questionnaire = await loadQuestionnaire(e.QUESTIONNAIRE_PATH);
  const log = logger.child({ mode: "bench" });
  log.level = process.env.LOG_LEVEL ?? "error";
  const personLlm = createLlm(e, log, values["person-model"]);

  const rows: Array<{ model: string; p50: number; p90: number; max: number; pass: number; toolErrors: number; turns: number; failures: string[] }> = [];
  for (const model of models) {
    console.log(`\n=== ${model} ===`);
    const assistantLlm = createLlm(e, log, model);
    const latencies: number[] = [];
    let pass = 0;
    let toolErrors = 0;
    let turns = 0;
    const failures: string[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const r = await runSimulation({ questionnaire, assistantLlm, personLlm, personaName, outDir: values.out ?? "data/bench", runIndex: i, log, tag: model });
        latencies.push(...r.firstTokenMs);
        toolErrors += r.toolErrors;
        turns += r.turns;
        if (r.passed) pass++;
        console.log(`  run ${i + 1}: outcome=${r.record.outcome} eligible=${r.record.eligible} ${r.passed ? "PASS" : "FAIL"} | first-token p50 ${percentile(r.firstTokenMs, 0.5)} ms | tool errors ${r.toolErrors} | turns ${r.turns}`);
      } catch (err) {
        failures.push((err as Error).message);
        console.log(`  run ${i + 1}: ERROR ${(err as Error).message.slice(0, 120)}`);
      }
    }
    rows.push({ model, p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: Math.max(0, ...latencies), pass, toolErrors, turns, failures });
  }

  console.log("\nmodel                                   p50 ms  p90 ms  max ms  pass   tool-errs  turns");
  for (const r of rows) {
    console.log(`${r.model.padEnd(40)}${String(r.p50).padStart(6)}  ${String(r.p90).padStart(6)}  ${String(r.max).padStart(6)}  ${`${r.pass}/${runs}`.padStart(5)}  ${String(r.toolErrors).padStart(9)}  ${String(r.turns).padStart(5)}${r.failures.length ? `  (${r.failures.length} errors)` : ""}`);
  }
  console.log("\nLower p50/p90 = snappier replies; pass and tool-errs tell you whether the model drives the screening correctly.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
