import pino from "pino";
import { describe, expect, it } from "vitest";
import { ConversationEngine } from "../src/conversation/engine.js";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult } from "../src/conversation/llm.js";
import { TOOL_DECLARATIONS, ToolHandlers } from "../src/conversation/tools.js";
import type { Transport } from "../src/conversation/transport.js";
import { ScreeningState } from "../src/screening/state.js";
import { newTranscript } from "../src/storage/transcripts.js";
import { sampleQuestionnaire } from "./helpers.js";

type Script = (params: LlmRunParams, h: LlmRunHandlers) => Promise<LlmRunResult> | LlmRunResult;

class FakeLlm implements LlmAdapter {
  readonly runs: LlmRunParams[] = [];
  constructor(private readonly script: Script[]) {}
  async run(params: LlmRunParams, h: LlmRunHandlers): Promise<LlmRunResult> {
    this.runs.push({ ...params, history: [...params.history] });
    const fn = this.script.shift();
    if (!fn) throw new Error("fake LLM ran out of script");
    return fn(params, h);
  }
}

class FakeTransport implements Transport {
  readonly sent: Array<{ token: string; last: boolean }> = [];
  ended: unknown = undefined;
  sendText(token: string, last: boolean) {
    this.sent.push({ token, last });
  }
  end(data?: Record<string, unknown>) {
    this.ended = data ?? {};
  }
  get spoken() {
    return this.sent.map((s) => s.token).join("");
  }
}

const say = (text: string): Script => (_p, h) => {
  for (const word of text.split(/(?<= )/)) h.onText(word);
  return { steps: [{ type: "model_output", content: [{ type: "text", text }] }], toolCalls: [], text, aborted: false };
};

const sayThenCall = (text: string, name: string, args: Record<string, unknown>, id = "call-1"): Script => (_p, h) => {
  if (text) h.onText(text);
  const steps: HistoryStep[] = [];
  if (text) steps.push({ type: "model_output", content: [{ type: "text", text }] });
  steps.push({ type: "function_call", id, name, arguments: args });
  return { steps, toolCalls: [{ id, name, args }], text, aborted: false };
};

function setup(script: Script[]) {
  const q = sampleQuestionnaire();
  const state = new ScreeningState(q);
  const transport = new FakeTransport();
  const transcript = newTranscript({ callSid: "CA1", contactId: "C1", phone: "+15550000000" });
  const llm = new FakeLlm(script);
  const ends: unknown[] = [];
  const engine = new ConversationEngine({
    system: "sys",
    tools: TOOL_DECLARATIONS,
    toolHandlers: new ToolHandlers(state, q, { recordingEnabled: false }),
    llm,
    transport,
    transcript,
    log: pino({ level: "silent" }),
    onEndRequested: (e) => ends.push(e),
  });
  return { q, state, transport, transcript, llm, engine, ends };
}

describe("ConversationEngine", () => {
  it("streams model text to the transport and closes the turn", async () => {
    const t = setup([say("Hi there, is this Jordan?")]);
    const stats = await t.engine.handleUserInput("Hello?");
    expect(t.transport.spoken).toBe("Hi there, is this Jordan?");
    expect(t.transport.sent.at(-1)).toEqual({ token: "", last: true });
    expect(t.engine.history.map((s) => s.type)).toEqual(["user_input", "model_output"]);
    expect(stats.firstTokenMs).toBeTypeOf("number");
    expect(t.transcript.turns.map((x) => x.role)).toEqual(["person", "assistant"]);
  });

  it("executes tool calls inline and continues the same spoken turn", async () => {
    const t = setup([sayThenCall("Great. ", "confirm_identity", { result: "confirmed" }), say("I'm Sam, calling about the sleep study. Do you have five minutes?")]);
    const stats = await t.engine.handleUserInput("Yes, this is Jordan.");
    expect(t.state.identity).toBe("confirmed");
    expect(t.state.stage).toBe("consent");
    expect(stats.toolCalls).toBe(1);
    expect(t.transport.spoken).toBe("Great. I'm Sam, calling about the sleep study. Do you have five minutes?");
    expect(t.transport.sent.filter((s) => s.last)).toHaveLength(1);
    const types = t.engine.history.map((s) => s.type);
    expect(types).toEqual(["user_input", "model_output", "function_call", "function_result", "model_output"]);
    const result = t.engine.history[3];
    expect(result?.type === "function_result" && JSON.parse(result.result[0]!.text).ok).toBe(true);
    // second run saw the function result in its history
    expect(t.llm.runs[1]?.history).toHaveLength(4);
  });

  it("feeds validation errors back to the model instead of recording bad values", async () => {
    const t = setup([
      sayThenCall("", "confirm_identity", { result: "confirmed" }),
      say("Do you have five minutes?"),
      sayThenCall("", "record_consent", { proceed: true }),
      say("How old are you?"),
      sayThenCall("", "record_answer", { question_id: "age", value: 7, verbatim: "seven" }),
      say("Sorry, did you say seven or seventy?"),
    ]);
    await t.engine.handleUserInput("Yes");
    await t.engine.handleUserInput("Sure");
    await t.engine.handleUserInput("seven");
    expect(t.state.answers.has("age")).toBe(false);
    const last = t.engine.history.filter((s) => s.type === "function_result").at(-1);
    expect(last?.type === "function_result" && last.is_error).toBe(true);
    expect(t.transport.spoken).toContain("seven or seventy");
  });

  it("requests the end of the call after the closing words", async () => {
    const t = setup([sayThenCall("Thanks so much, bye for now.", "end_call", { reason: "declined" })]);
    await t.engine.handleUserInput("No thanks, not interested.");
    expect(t.ends).toEqual([{ reason: "declined", note: undefined }]);
    expect(t.engine.hasEnded).toBe(true);
    expect(t.state.stage).toBe("ended");
  });

  it("aborts on interruption and tells the model what was heard", async () => {
    const slow: Script = async (params, h) => {
      h.onText("Let me tell you about the study, it is ");
      await new Promise<void>((resolve) => params.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { steps: [{ type: "model_output", content: [{ type: "text", text: "Let me tell you about the study, it is " }] }], toolCalls: [], text: "…", aborted: true };
    };
    const t = setup([slow, say("Of course, what would you like to know?")]);
    const first = t.engine.handleUserInput("Okay");
    await new Promise((r) => setTimeout(r, 5));
    t.engine.interrupt("Let me tell you about");
    const stats = await first;
    expect(stats.aborted).toBe(true);
    expect(t.transcript.turns.at(-1)).toMatchObject({ role: "assistant", interrupted: true, heard: "Let me tell you about" });
    await t.engine.handleUserInput("Wait, I have a question first.");
    const userSteps = t.engine.history.filter((s) => s.type === "user_input");
    expect(userSteps.at(-1)?.type === "user_input" && userSteps.at(-1)!.content[0]!.text).toBe('[The person interrupted after hearing: "Let me tell you about"]\nWait, I have a question first.');
    expect(t.transport.spoken).toContain("Of course");
  });

  it("keeps a space between text generated before and after a tool round", async () => {
    const t = setup([sayThenCall("Okay.", "confirm_identity", { result: "confirmed" }), say("Do you have five minutes?")]);
    await t.engine.handleUserInput("Yes, this is Jordan");
    expect(t.transport.spoken).toBe("Okay. Do you have five minutes?");
  });

  it("refuses to confirm identity in the same opening reply that asks for it, and leaves the question standing", async () => {
    const t = setup([sayThenCall("Hello! Am I speaking with Jordan?", "confirm_identity", { result: "confirmed" }), say("SHOULD NOT RUN")]);
    await t.engine.handleUserInput("Hello?");
    expect(t.state.identity).toBe("unknown");
    expect(t.transport.spoken).toBe("Hello! Am I speaking with Jordan?");
    const last = t.engine.history.at(-1);
    expect(last?.type === "function_result" && last.is_error).toBe(true);
    expect(last?.type === "function_result" && last.result[0]!.text).toMatch(/wait for their reply/);
    // The person answers; now the same tool call plus the next question in one reply is fine.
    t.llm["script"].length = 0;
    t.llm["script"].push(sayThenCall("Great. I'm Sam, an automated assistant. Do you have five minutes?", "confirm_identity", { result: "confirmed" }));
    await t.engine.handleUserInput("Yes, speaking");
    expect(t.state.identity).toBe("confirmed");
    expect(t.state.stage).toBe("consent");
  });

  it("lets one reply record the pending answer and ask the next question, but not answer questions nobody was asked", async () => {
    const twoCalls: Script = (_p, h) => {
      const text = "Okay. Do you take any prescription sleep medication?";
      h.onText(text);
      const steps: HistoryStep[] = [
        { type: "model_output", content: [{ type: "text", text }] },
        { type: "function_call", id: "c1", name: "record_answer", arguments: { question_id: "diagnosed_insomnia", value: true } },
        { type: "function_call", id: "c2", name: "record_answer", arguments: { question_id: "sleep_medication", value: false } },
      ];
      return { steps, toolCalls: [{ id: "c1", name: "record_answer", args: { question_id: "diagnosed_insomnia", value: true } }, { id: "c2", name: "record_answer", args: { question_id: "sleep_medication", value: false } }], text, aborted: false };
    };
    const t = setup([
      say("Hi, am I speaking with Jordan?"),
      sayThenCall("Hi, I'm Sam, an automated assistant. Do you have five minutes?", "confirm_identity", { result: "confirmed" }),
      sayThenCall("Great. How old are you?", "record_consent", { proceed: true }),
      sayThenCall("Got it, forty-two. Has a doctor ever told you that you have insomnia?", "record_answer", { question_id: "age", value: 42 }),
      twoCalls,
    ]);
    await t.engine.handleUserInput("Hello?");
    await t.engine.handleUserInput("Yes, this is Jordan");
    expect(t.state.stage).toBe("consent");
    await t.engine.handleUserInput("Sure");
    expect(t.state.stage).toBe("screening");
    await t.engine.handleUserInput("Forty-two");
    expect(t.state.answers.get("age")?.value).toBe(42);
    // Each question stood after its reply: no extra model round re-asked it.
    expect(t.transport.spoken).toBe("Hi, am I speaking with Jordan?Hi, I'm Sam, an automated assistant. Do you have five minutes?Great. How old are you?Got it, forty-two. Has a doctor ever told you that you have insomnia?");
    // Pending answer recorded; the answer to the question just asked is refused.
    await t.engine.handleUserInput("Yes, years ago");
    expect(t.state.answers.get("diagnosed_insomnia")?.value).toBe(true);
    expect(t.state.answers.has("sleep_medication")).toBe(false);
    const results = t.engine.history.filter((h) => h.type === "function_result").slice(-2);
    expect(results.map((r) => r.type === "function_result" && r.is_error === true)).toEqual([false, true]);
  });

  it("gives the model one correction round when a recorded value fails validation after it asked the next question", async () => {
    const t = setup([
      say("Hi, am I speaking with Jordan?"),
      sayThenCall("Hi, I'm Sam. Do you have five minutes?", "confirm_identity", { result: "confirmed" }),
      sayThenCall("Great. How old are you?", "record_consent", { proceed: true }),
      sayThenCall("Got it, seven. Do you take any sleep medication?", "record_answer", { question_id: "age", value: 7 }),
      say("Sorry, before that, did you say seven or seventy?"),
    ]);
    await t.engine.handleUserInput("Hello?");
    await t.engine.handleUserInput("Yes");
    await t.engine.handleUserInput("Sure");
    await t.engine.handleUserInput("Seven");
    expect(t.state.answers.has("age")).toBe(false);
    expect(t.transport.spoken).toContain("seven or seventy");
  });

  it("speaks an acknowledgment itself when the model answers with a bare recording call, and tells the model not to repeat it", async () => {
    const t = setup([
      say("Hi, am I speaking with Jordan?"),
      sayThenCall("", "confirm_identity", { result: "confirmed" }),
      say("I'm Sam, an automated assistant. Do you have five minutes?"),
      sayThenCall("", "record_consent", { proceed: true }),
      say("How old are you?"),
      sayThenCall("", "record_answer", { question_id: "age", value: 42 }),
      say("Has a doctor ever told you that you have insomnia?"),
    ]);
    await t.engine.handleUserInput("Hello?");
    await t.engine.handleUserInput("Yes, speaking");
    expect(t.transport.spoken).toContain("Great. I'm Sam");
    await t.engine.handleUserInput("Sure");
    await t.engine.handleUserInput("Forty-two");
    expect(t.transport.spoken).toMatch(/Great, thank you\. How old are you\?(Got it|Okay|Thanks|Alright)\. Has a doctor/);
    const result = t.engine.history.filter((h) => h.type === "function_result").at(-1);
    const payload = result?.type === "function_result" ? JSON.parse(result.result[0]!.text) : {};
    expect(payload.already_spoken).toMatch(/Got it|Okay|Thanks|Alright/);
    expect(payload.note).toMatch(/do not acknowledge again/);
    // The spoken ack is part of the model's own history, right before the tool result.
    const types = t.engine.history.slice(-4).map((h) => h.type);
    expect(types).toEqual(["function_call", "model_output", "function_result", "model_output"]);
  });

  it("recovers from a model failure with a spoken fallback", async () => {
    const t = setup([
      () => {
        throw new Error("boom");
      },
    ]);
    await t.engine.handleUserInput("Hello?");
    expect(t.transport.spoken).toMatch(/say that once more/);
    expect(t.transport.sent.at(-1)?.last).toBe(true);
  });
});
