import { mkdir } from "node:fs/promises";
import type { LlmAdapter, HistoryStep } from "../conversation/llm.js";
import { CallSession } from "../conversation/session.js";
import type { Transport } from "../conversation/transport.js";
import type { Logger } from "../logger.js";
import type { Questionnaire } from "../screening/schema.js";
import type { CallRecord } from "../storage/csv.js";
import { FileCallStore } from "../storage/file-store.js";

/** Simulated participants: a second model plays a person with a persona. */
export const PERSONAS: Record<string, { profile: string; expect: Partial<Pick<CallRecord, "outcome" | "eligible">> }> = {
  eligible: {
    profile: "You are Jordan, 42, diagnosed with insomnia two years ago, not on sleep medication, not pregnant, can attend visits, never smoked, best reached in the evenings. Cooperative and brief.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  ineligible: {
    profile: "You are Jordan, 71, you have insomnia, you take zolpidem nightly, not pregnant, can attend visits, former smoker. Polite and a little chatty.",
    expect: { outcome: "completed", eligible: "no" },
  },
  chatty: {
    profile: "You are Jordan, 35, insomnia since your kids were born, no medication, not pregnant, can attend visits, never smoked. You tell little stories with every answer and sometimes ask the caller questions back.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  confused: {
    profile: "You are Jordan, 58, hard of hearing; you often say 'sorry, what?' the first time and need questions repeated more simply. Insomnia yes, no medication, not pregnant, can attend, current smoker.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  declines: {
    profile: "You are Jordan. You are busy and not interested. You politely decline within the first two turns and want to hang up.",
    expect: { outcome: "declined" },
  },
  callback: {
    profile: "You are Jordan, at work right now. You confirm your name but ask them to call back tomorrow morning instead.",
    expect: { outcome: "callback_requested" },
  },
  wrong_person: {
    profile: "You are Sam's neighbor Alex. Jordan does not live here; this is a wrong number. Be brief.",
    expect: { outcome: "wrong_person" },
  },
};

class CollectingTransport implements Transport {
  private buffer = "";
  ended = false;
  onTurn: ((text: string) => void) | undefined;
  onEnd: (() => void) | undefined;
  sendText(token: string, last: boolean): void {
    this.buffer += token;
    if (last) {
      const text = this.buffer.trim();
      this.buffer = "";
      if (text) this.onTurn?.(text);
    }
  }
  end(): void {
    this.ended = true;
    this.onEnd?.();
  }
}

export interface SimulationOptions {
  questionnaire: Questionnaire;
  assistantLlm: LlmAdapter;
  personLlm: LlmAdapter;
  personaName: string;
  outDir: string;
  runIndex: number;
  maxTurns?: number;
  log: Logger;
  /** Print each exchange as it happens. */
  verbose?: boolean;
  /** Tag for file names (e.g. the model id). */
  tag?: string;
}

export interface SimulationResult {
  record: CallRecord;
  firstTokenMs: number[];
  toolErrors: number;
  turns: number;
  passed: boolean;
  transcriptPath: string;
}

export async function runSimulation(opts: SimulationOptions): Promise<SimulationResult> {
  const persona = PERSONAS[opts.personaName];
  if (!persona) throw new Error(`unknown persona ${opts.personaName}; choose one of ${Object.keys(PERSONAS).join(", ")}`);
  await mkdir(opts.outDir, { recursive: true });
  const maxTurns = opts.maxTurns ?? 40;
  const transport = new CollectingTransport();
  const personHistory: HistoryStep[] = [];
  let turns = 0;
  let finished!: (r: CallRecord) => void;
  const done = new Promise<CallRecord>((resolve) => (finished = resolve));
  const tag = (opts.tag ?? "sim").replace(/[^A-Za-z0-9_.-]/g, "_");

  const session = new CallSession({
    callSid: `SIM-${tag}-${opts.personaName}-${Date.now()}-${opts.runIndex}`,
    contact: { contactId: `sim-${opts.personaName}-${opts.runIndex}`, phone: "+10000000000", firstName: "Jordan" },
    questionnaire: opts.questionnaire,
    llm: opts.assistantLlm,
    transport,
    log: opts.log,
    recordingEnabled: false,
    store: new FileCallStore(`${opts.outDir}/results.csv`, `${opts.outDir}/calls`),
    timers: { firstUtteranceMs: 800, silenceMs: 1500, maxEndGraceMs: 300 },
    onFinished: (record) => finished(record),
  });

  const personSystem = `You are role-playing a real person answering an unexpected phone call, for testing a phone screener. ${persona.profile}
Rules: speak only as this person, one short spoken reply per turn (a few words to two sentences), no narration, no quotes, no stage directions. Answer the caller's question but stay in character. Start the call by answering the phone naturally (for example "Hello?"). If the caller says goodbye, say a short goodbye.`;

  const personSpeaks = async (assistantText: string): Promise<void> => {
    if (transport.ended || session.engine.hasEnded) return;
    if (++turns > maxTurns) {
      if (opts.verbose) console.log("max turns reached; hanging up");
      session.onClose();
      return;
    }
    personHistory.push({ type: "user_input", content: [{ type: "text", text: assistantText }] });
    const res = await opts.personLlm.run({ system: personSystem, history: personHistory, tools: [], signal: new AbortController().signal }, { onText: () => undefined });
    personHistory.push(...res.steps);
    const reply = res.text.trim();
    if (opts.verbose) {
      console.log(`  ${opts.questionnaire.caller.persona_name}: ${assistantText}`);
      console.log(`  Jordan: ${reply}`);
    }
    if (reply) session.onPrompt(reply, true);
  };

  transport.onTurn = (text) => void personSpeaks(text);
  transport.onEnd = () => void session.finalize();
  session.start();
  await personSpeaks("[The phone rings and you pick up]");
  const record = await done;

  const okOutcome = !persona.expect.outcome || persona.expect.outcome === record.outcome;
  const okEligible = !persona.expect.eligible || persona.expect.eligible === record.eligible;
  const firstTokenMs = session.transcript.metrics.map((m) => m.firstTokenMs).filter((x): x is number => typeof x === "number");
  const toolErrors = session.transcript.toolCalls.filter((c) => (c.result as { ok?: boolean } | undefined)?.ok === false).length;
  return { record, firstTokenMs, toolErrors, turns, passed: okOutcome && okEligible, transcriptPath: record.transcript_path };
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}
