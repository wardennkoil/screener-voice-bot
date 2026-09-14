import { parseArgs } from "node:util";
import { env } from "../config.js";
import { createLlm, describeLlm } from "../conversation/llm-factory.js";
import { logger } from "../logger.js";
import { loadQuestionnaire } from "../screening/loader.js";
import { PERSONAS, percentile, runSimulation } from "./sim-core.js";

/**
 * Simulated participants: a second model plays a person with a persona and
 * answers the phone. Runs the real session (prompt, tools, timers scaled down)
 * and writes results to data/sim so you can read the transcripts and CSV rows.
 *   npm run sim -- --persona confused --n 3 [--model openai/gpt-5.6-luna]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { persona: { type: "string" }, n: { type: "string" }, out: { type: "string" }, "max-turns": { type: "string" }, model: { type: "string" }, "person-model": { type: "string" } } });
  const personaName = values.persona ?? "eligible";
  if (!PERSONAS[personaName]) throw new Error(`unknown persona ${personaName}; choose one of ${Object.keys(PERSONAS).join(", ")}`);
  const runs = Number(values.n ?? 1);
  const e = env();
  const questionnaire = await loadQuestionnaire(e.QUESTIONNAIRE_PATH);
  const log = logger.child({ mode: "sim" });
  log.level = process.env.LOG_LEVEL ?? "warn";
  const assistantLlm = createLlm(e, log, values.model);
  const personLlm = createLlm(e, log, values["person-model"] ?? values.model);
  const choice = describeLlm(e, values.model);
  console.log(`assistant model: ${choice.provider}:${choice.model}`);

  let pass = 0;
  for (let i = 0; i < runs; i++) {
    console.log(`\n=== run ${i + 1}/${runs} persona=${personaName} ===`);
    const r = await runSimulation({ questionnaire, assistantLlm, personLlm, personaName, outDir: values.out ?? "data/sim", runIndex: i, maxTurns: Number(values["max-turns"] ?? 40), log, verbose: true, tag: choice.model });
    if (r.passed) pass++;
    console.log(`result: outcome=${r.record.outcome} eligible=${r.record.eligible} ${r.passed ? "PASS" : `FAIL (expected ${JSON.stringify(PERSONAS[personaName]!.expect)})`}`);
    console.log(`answers: ${JSON.stringify(r.record.answers)}`);
    if (r.firstTokenMs.length) console.log(`first-token latency ms: median ${percentile(r.firstTokenMs, 0.5)}, p90 ${percentile(r.firstTokenMs, 0.9)}, max ${Math.max(...r.firstTokenMs)} | tool errors: ${r.toolErrors}`);
    console.log(`transcript: ${r.transcriptPath}`);
  }
  console.log(`\n${pass}/${runs} runs matched expectations for persona ${personaName}`);
  process.exit(pass === runs ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
