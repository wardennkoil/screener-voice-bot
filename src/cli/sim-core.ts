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
    profile:
      "You are Jordan, 38. This morning you filled out a website form about a weight management study. You are five foot five and 205 pounds, and your weight has been steady for months. You have high blood pressure and take amlodipine. No diabetes or prediabetes, no weight-loss medication or supplements, no weight-loss surgery, never had pancreatitis, no thyroid cancer in the family. Not pregnant or planning to be; you have an IUD. Not in another study. You work from home, so the visits are fine, and you pick the Tuesday slot. The placebo does not put you off. Cooperative and brief.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  ineligible: {
    profile:
      "You are Jordan, 45, and you filled out the weight study form. Five foot eight, 240 pounds, weight steady. No high blood pressure, no diabetes. Your doctor started you on Ozempic last month. Everything else is a no. If asked about other studies, you'd be glad to hear about them. Polite and a little chatty.",
    expect: { outcome: "completed", eligible: "no" },
  },
  ineligible_no_other: {
    profile:
      "You are Jordan, 45, and you filled out the weight study form. Five foot eight, 240 pounds, weight steady. No high blood pressure, no diabetes. You had weight-loss surgery two years ago. If asked about other studies, you say no thanks, this was a one-off. Polite and brief.",
    expect: { outcome: "completed", eligible: "no" },
  },
  bmi_borderline: {
    profile:
      "You are Jordan, 50, and you filled out the weight study form. Five foot six, 170 pounds, weight steady. You have high blood pressure and take ramipril. Your doctor once said you have prediabetes. No weight-loss medication, no surgery, no pancreatitis, no thyroid cancer in the family, not pregnant, not in another study. The visits are fine, but neither offered time works; Friday mornings are best for you.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  chatty: {
    profile:
      "You are Jordan, 34, and you filled out the weight study form. You tell little stories with every answer and sometimes ask the caller questions back, like whether you get paid. Five foot four, 190 pounds, steady. No high blood pressure, no diabetes, none of the other conditions or medications, not pregnant, not in another study, visits are fine, you pick Thursday.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  confused: {
    profile:
      "You are Jordan, 61, hard of hearing; you often say 'sorry, what?' the first time and need questions repeated more simply. You filled out the weight study form. Five foot ten, 250 pounds, steady. High blood pressure, no medication for it. No diabetes, none of the other conditions or medications, not pregnant, not in another study, visits are fine, Tuesday works.",
    expect: { outcome: "completed", eligible: "yes" },
  },
  placebo_no: {
    profile:
      "You are Jordan, 42, and you filled out the weight study form. You have time and agree to the questions, but once you hear there is a one in three chance of placebo for a year and a half, you say that's not for you and you're no longer interested.",
    expect: { outcome: "completed", eligible: "no" },
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
    profile: "You are Alex. Nobody named Jordan lives here; this is a wrong number. Be brief.",
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
