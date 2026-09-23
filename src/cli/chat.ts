import { parseArgs } from "node:util";
import readline from "node:readline";
import { env } from "../config.js";
import { createLlm, describeLlm } from "../conversation/llm-factory.js";
import { CallSession } from "../conversation/session.js";
import type { Transport } from "../conversation/transport.js";
import { logger } from "../logger.js";
import { loadQuestionnaire } from "../screening/loader.js";
import { FileCallStore } from "../storage/file-store.js";

/**
 * Text harness: the exact engine, prompt, tools and timers, driven from the
 * terminal. Type what the person would say. Special commands:
 *   /interrupt <words heard>   simulate speaking over the assistant
 *   /quit                       hang up
 */
class ConsoleTransport implements Transport {
  private line = "";
  sendText(token: string, last: boolean): void {
    if (token) {
      if (!this.line) process.stdout.write("\nSam: ");
      process.stdout.write(token);
      this.line += token;
    }
    if (last) {
      process.stdout.write("\n");
      this.line = "";
    }
  }
  end(handoffData?: Record<string, unknown>): void {
    console.log(`\n[call ended: ${JSON.stringify(handoffData ?? {})}]`);
    this.onEnd?.();
  }
  onEnd: (() => void) | undefined;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { name: { type: "string" }, csv: { type: "string" }, transcripts: { type: "string" }, model: { type: "string" } } });
  const e = env();
  const questionnaire = await loadQuestionnaire(e.QUESTIONNAIRE_PATH);
  const llm = createLlm(e, logger, values.model);
  const choice = describeLlm(e, values.model);
  const transport = new ConsoleTransport();
  const log = logger.child({ mode: "chat" });
  log.level = process.env.LOG_LEVEL ?? "warn";

  const session = new CallSession({
    callSid: `CHAT-${Date.now()}`,
    contact: { contactId: "chat", phone: "+10000000000", firstName: values.name ?? "Jordan" },
    questionnaire,
    llm,
    transport,
    log,
    recordingEnabled: e.RECORD_CALLS,
    store: new FileCallStore(values.csv, values.transcripts),
    onFinished: (record) => {
      console.log("\n--- result ---");
      console.log(JSON.stringify({ outcome: record.outcome, eligible: record.eligible, answers: record.answers, notes: record.notes }, null, 2));
      const lat = session.transcript.metrics.map((m) => m.firstTokenMs).filter((x): x is number => typeof x === "number");
      if (lat.length) console.log(`first-token latency ms: median ${median(lat)}, max ${Math.max(...lat)}`);
      process.exit(0);
    },
  });
  transport.onEnd = () => void session.finalize();

  console.log(`Text harness for "${questionnaire.study.name}" using ${choice.provider}:${choice.model}. You are ${values.name ?? "Jordan"} answering the phone. Type what you'd say (or wait 2.5s for the assistant to open). /quit to hang up.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/quit") {
      session.onClose();
      return;
    }
    if (text.startsWith("/interrupt")) {
      session.onInterrupt(text.replace("/interrupt", "").trim());
      return;
    }
    session.onPrompt(text, true);
  });
  session.start();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
