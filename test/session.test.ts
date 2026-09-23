import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult } from "../src/conversation/llm.js";
import { CallSession, estimateSpeechMs } from "../src/conversation/session.js";
import type { Transport } from "../src/conversation/transport.js";
import type { CallRecord } from "../src/storage/csv.js";
import { sampleQuestionnaire } from "./helpers.js";
import { FileCallStore } from "../src/storage/file-store.js";

type Script = (params: LlmRunParams, h: LlmRunHandlers) => LlmRunResult;

class FakeLlm implements LlmAdapter {
  readonly inputs: string[] = [];
  constructor(private readonly script: Script[]) {}
  async run(params: LlmRunParams, h: LlmRunHandlers): Promise<LlmRunResult> {
    const last = params.history.at(-1);
    if (last?.type === "user_input") this.inputs.push(last.content[0]!.text);
    const fn = this.script.shift() ?? say("Okay.");
    return fn(params, h);
  }
}

class FakeTransport implements Transport {
  spoken = "";
  ended: Record<string, unknown> | undefined;
  sendText(token: string) {
    this.spoken += token;
  }
  end(data?: Record<string, unknown>) {
    this.ended = data ?? {};
  }
}

const say = (text: string): Script => (_p, h) => {
  h.onText(text);
  return { steps: [{ type: "model_output", content: [{ type: "text", text }] }], toolCalls: [], text, aborted: false };
};
const sayAndCall = (text: string, name: string, args: Record<string, unknown>): Script => (_p, h) => {
  h.onText(text);
  const steps: HistoryStep[] = [{ type: "model_output", content: [{ type: "text", text }] }, { type: "function_call", id: "c1", name, arguments: args }];
  return { steps, toolCalls: [{ id: "c1", name, args }], text, aborted: false };
};

function make(script: Script[], extra: Partial<ConstructorParameters<typeof CallSession>[0]> = {}) {
  const llm = new FakeLlm(script);
  const transport = new FakeTransport();
  const finished: CallRecord[] = [];
  const session = new CallSession({
    callSid: "CA-test",
    contact: { contactId: "C1", phone: "+15550001111", firstName: "Jordan" },
    questionnaire: sampleQuestionnaire(),
    llm,
    transport,
    log: pino({ level: "silent" }),
    recordingEnabled: false,
    onFinished: (r) => finished.push(r),
    ...extra,
  });
  return { llm, transport, session, finished };
}

describe("CallSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the person to speak first, then opens the call itself after the grace period", async () => {
    const t = make([say("Hi, is this Jordan?")]);
    t.session.start();
    await vi.advanceTimersByTimeAsync(2400);
    expect(t.llm.inputs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.llm.inputs[0]).toMatch(/call connected/);
    expect(t.transport.spoken).toBe("Hi, is this Jordan?");
  });

  it("responds to a real 'hello' immediately and cancels the fallback opener", async () => {
    const t = make([say("Hi, is this Jordan?")]);
    t.session.start();
    t.session.onPrompt("Hello?", true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.llm.inputs).toEqual(["Hello?"]);
  });

  it("stays silent on a voicemail greeting and records the outcome", async () => {
    const t = make([]);
    t.session.start();
    t.session.onPrompt("Hi, you've reached Jordan. Leave a message after the beep.", true);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.llm.inputs).toHaveLength(0);
    expect(t.transport.ended).toEqual({ reason: "voicemail" });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.finished[0]?.outcome).toBe("voicemail");
  });

  it("nudges on silence and gives up after three attempts", async () => {
    const t = make([say("How old are you?"), say("Take your time."), say("Are you still there?"), sayAndCall("Bye for now.", "end_call", { reason: "no_response" })]);
    t.session.start();
    t.session.onPrompt("Hello?", true);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(estimateSpeechMs("How old are you?") + 7000);
    expect(t.llm.inputs.at(-1)).toMatch(/^\[silence/);
    await vi.advanceTimersByTimeAsync(estimateSpeechMs("Take your time.") + 7000);
    expect(t.llm.inputs.at(-1)).toMatch(/still there/);
    await vi.advanceTimersByTimeAsync(estimateSpeechMs("Are you still there?") + 7000);
    expect(t.llm.inputs.at(-1)).toMatch(/three attempts/);
    await vi.advanceTimersByTimeAsync(15000);
    expect(t.transport.ended).toEqual({ reason: "no_response" });
    expect(t.finished[0]?.outcome).toBe("no_response");
  });

  it("lets the goodbye play before ending and persists the row and transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "screener-session-"));
    const csvPath = join(dir, "out.csv");
    const t = make([sayAndCall("Thanks, take care, goodbye.", "end_call", { reason: "declined" })], { store: new FileCallStore(csvPath, join(dir, "calls")) });
    t.session.start();
    t.session.onPrompt("Not interested, thanks.", true);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.transport.ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(estimateSpeechMs("Thanks, take care, goodbye.") + 800);
    expect(t.transport.ended).toEqual({ reason: "declined" });
    await vi.advanceTimersByTimeAsync(50);
    // Twilio then closes the socket; finalize must stay idempotent.
    t.session.onClose();
    await t.session.finalize();
    expect(t.finished).toHaveLength(1);
    const csv = await readFile(csvPath, "utf8");
    expect(csv.trim().split("\n")).toHaveLength(2);
    expect(csv).toContain(",declined,undetermined,");
    const transcript = JSON.parse(await readFile(t.finished[0]!.transcript_path, "utf8")) as { turns: unknown[]; outcome: string };
    expect(transcript.outcome).toBe("declined");
    expect(transcript.turns.length).toBeGreaterThan(0);
  });

  it("classifies a hang-up mid-screening as partial", async () => {
    const t = make([
      sayAndCall("", "confirm_identity", { result: "confirmed" }),
      say("Got a few minutes?"),
      sayAndCall("", "record_consent", { proceed: true }),
      say("How old are you?"),
      sayAndCall("Okay.", "record_answer", { question_id: "age", value: 42 }),
      say("Any insomnia diagnosis?"),
    ]);
    t.session.start();
    t.session.onPrompt("Yes it's me", true);
    await vi.advanceTimersByTimeAsync(10);
    t.session.onPrompt("Sure", true);
    await vi.advanceTimersByTimeAsync(10);
    t.session.onPrompt("Forty-two", true);
    await vi.advanceTimersByTimeAsync(10);
    t.session.onClose();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.finished[0]).toMatchObject({ outcome: "partial", eligible: "undetermined", answers: { age: "42" } });
  });
});
