import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult } from "../src/conversation/llm.js";
import type { FluxEvents, SttStream } from "../src/local/deepgram-flux.js";
import { isBackchannel, LocalVoiceSession, proportionalHeard, type BrowserLink } from "../src/local/local-session.js";
import type { TtsTurn, TtsTurnEvents } from "../src/local/tts.js";
import type { CallRecord } from "../src/storage/csv.js";
import { sampleQuestionnaire } from "./helpers.js";

type Script = (params: LlmRunParams, h: LlmRunHandlers) => LlmRunResult;
const say = (text: string): Script => (_p, h) => {
  h.onText(text);
  return { steps: [{ type: "model_output", content: [{ type: "text", text }] }], toolCalls: [], text, aborted: false };
};
const sayAndCall = (text: string, name: string, args: Record<string, unknown>): Script => (_p, h) => {
  h.onText(text);
  const steps: HistoryStep[] = [{ type: "model_output", content: [{ type: "text", text }] }, { type: "function_call", id: "c1", name, arguments: args }];
  return { steps, toolCalls: [{ id: "c1", name, args }], text, aborted: false };
};

class FakeLlm implements LlmAdapter {
  readonly inputs: string[] = [];
  constructor(private readonly script: Script[]) {}
  async run(params: LlmRunParams, h: LlmRunHandlers): Promise<LlmRunResult> {
    const last = params.history.at(-1);
    if (last?.type === "user_input") this.inputs.push(last.content[0]!.text);
    return (this.script.shift() ?? say("Okay."))(params, h);
  }
}

class FakeTts implements TtsTurn {
  readonly sent: string[] = [];
  ended = false;
  aborted = false;
  private chars: string[] = [];
  deliveredMs = 0;
  constructor(readonly events: TtsTurnEvents) {}
  sendText(text: string) {
    this.sent.push(text);
  }
  end() {
    this.ended = true;
  }
  abort() {
    this.aborted = true;
  }
  /** Simulate 50 ms of audio per character with alignment. */
  emitAudio(text: string) {
    const chars = [...text];
    const charStartMs = chars.map((_, i) => this.deliveredMs + i * 50);
    this.chars.push(...chars);
    this.deliveredMs += chars.length * 50;
    this.events.onAudio({ pcm: Buffer.alloc(chars.length * 50 * 48), chars, charStartMs });
  }
  finish() {
    this.events.onFinal();
  }
  heardText(playedMs: number): string {
    const idx = Math.min(this.chars.length, Math.floor(playedMs / 50));
    const out = this.chars.slice(0, idx).join("");
    const trimmed = out.trimEnd();
    // Same rule as the real client: a cut on whitespace keeps the word; a cut mid-word drops it.
    if (trimmed.length < out.length || idx >= this.chars.length) return trimmed;
    const sp = trimmed.lastIndexOf(" ");
    return sp > 0 ? trimmed.slice(0, sp) : trimmed;
  }
}

class FakeLink implements BrowserLink {
  readonly json: Array<Record<string, unknown>> = [];
  readonly audio: Array<{ turn: number; bytes: number }> = [];
  closed = false;
  sendJson(msg: Record<string, unknown>) {
    this.json.push(msg);
  }
  sendAudio(turnId: number, pcm: Buffer) {
    this.audio.push({ turn: turnId, bytes: pcm.length });
  }
  close() {
    this.closed = true;
  }
  ofType(type: string) {
    return this.json.filter((m) => m.type === type);
  }
}

function setup(script: Script[]) {
  let flux!: FluxEvents;
  const sttClosed = { value: false };
  const ttss: FakeTts[] = [];
  const link = new FakeLink();
  const llm = new FakeLlm(script);
  const finished: CallRecord[] = [];
  const s = new LocalVoiceSession(
    {
      questionnaire: sampleQuestionnaire(),
      llm,
      log: pino({ level: "silent" }),
      deepgramApiKey: "dg",
      tts: { provider: "cartesia", apiKey: "ca", voiceId: "V", modelId: "sonic-3.6" },
      sampleRate: 24000,
      eotThreshold: 0.7,
      firstName: "Jordan",
      sttFactory: async (_o, events): Promise<SttStream> => {
        flux = events;
        return { sendAudio: () => undefined, close: () => void (sttClosed.value = true) };
      },
      ttsFactory: (_o, events) => {
        const t = new FakeTts(events);
        ttss.push(t);
        return t;
      },
      onFinished: (r) => finished.push(r),
    },
    link,
  );
  return { s, link, llm, ttss, finished, sttClosed, flux: () => flux };
}

const eot = (transcript: string) => ({ event: "EndOfTurn" as const, transcript, turnIndex: 0, confidence: 0.9, words: transcript.split(" ") });

describe("helpers", () => {
  it("recognizes backchannels", () => {
    expect(isBackchannel("uh-huh")).toBe(true);
    expect(isBackchannel("Okay.")).toBe(true);
    expect(isBackchannel("Yeah, sure")).toBe(true);
    expect(isBackchannel("wait, I have a question")).toBe(false);
  });
  it("estimates heard text proportionally", () => {
    expect(proportionalHeard("Hello there, how are you today?", 1000, 2000)).toBe("Hello there,");
    expect(proportionalHeard("Hello there", 5000, 2000)).toBe("Hello there");
    expect(proportionalHeard("Hello there", 0, 2000)).toBe("");
  });
});

describe("LocalVoiceSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("turns a finished utterance into streamed speech with latency reporting", async () => {
    const t = setup([say("Hi there, is this Jordan? ")]);
    await t.s.start();
    expect(t.link.ofType("state").at(-1)).toEqual({ type: "state", state: "listening" });
    t.flux().onTurn(eot("Hello?"));
    expect(t.ttss).toHaveLength(1); // synthesis socket opened before the model answered
    await vi.advanceTimersByTimeAsync(5);
    expect(t.llm.inputs).toEqual(["Hello?"]);
    expect(t.ttss[0]!.sent).toEqual(["Hi there, is this Jordan? "]);
    expect(t.ttss[0]!.ended).toBe(true);
    expect(t.link.ofType("turn")).toEqual([{ type: "turn", id: 1 }]);
    t.ttss[0]!.emitAudio("Hi there, is this Jordan? ");
    expect(t.link.audio).toEqual([{ turn: 1, bytes: 26 * 50 * 48 }]);
    expect(t.link.ofType("state").at(-1)).toEqual({ type: "state", state: "speaking" });
    expect(t.link.ofType("latency")[0]).toMatchObject({ type: "latency" });
    t.ttss[0]!.finish();
    t.s.onClientMessage({ type: "playback_done", turn: 1, ms: 1300 });
    expect(t.link.ofType("state").at(-1)).toEqual({ type: "state", state: "listening" });
  });

  it("ignores a backchannel while speaking but interrupts on real speech, telling the model what was heard", async () => {
    const t = setup([say("Let me tell you about the study, it takes six weeks. "), say("Of course, what would you like to know? ")]);
    await t.s.start();
    t.flux().onTurn(eot("Okay"));
    await vi.advanceTimersByTimeAsync(5);
    const tts = t.ttss[0]!;
    tts.emitAudio("Let me tell you about the study, it takes six weeks. ");
    t.s.onClientMessage({ type: "played", turn: 1, ms: 1000 });

    // "uh-huh" mid-sentence: no interruption
    t.flux().onTurn({ event: "StartOfTurn", transcript: "uh", turnIndex: 1, confidence: 0.1, words: ["uh"] });
    t.flux().onTurn(eot("uh-huh"));
    await vi.advanceTimersByTimeAsync(600);
    expect(t.link.ofType("clear")).toHaveLength(0);
    expect(t.llm.inputs).toEqual(["Okay"]);

    // Real interruption: two words in
    t.s.onClientMessage({ type: "played", turn: 1, ms: 1100 });
    t.flux().onTurn({ event: "StartOfTurn", transcript: "wait", turnIndex: 2, confidence: 0.1, words: ["wait"] });
    t.flux().onTurn({ event: "Update", transcript: "wait I have", turnIndex: 2, confidence: 0.1, words: ["wait", "I", "have"] });
    expect(t.link.ofType("clear")).toEqual([{ type: "clear", turn: 1 }]);
    expect(tts.aborted).toBe(true);
    const interrupted = t.link.ofType("transcript").find((m) => m.interrupted);
    expect(interrupted?.text).toBe("Let me tell you about");
    t.flux().onTurn(eot("wait I have a question first"));
    await vi.advanceTimersByTimeAsync(5);
    expect(t.llm.inputs.at(-1)).toBe('[The person interrupted after hearing: "Let me tell you about"]\nwait I have a question first');
    expect(t.ttss).toHaveLength(2);
    expect(t.ttss[1]!.sent).toEqual(["Of course, what would you like to know? "]);
  });

  it("ends the call after the goodbye finishes playing and persists the result", async () => {
    const t = setup([sayAndCall("Thanks, bye now. ", "end_call", { reason: "declined" })]);
    await t.s.start();
    t.flux().onTurn(eot("Not interested, sorry"));
    await vi.advanceTimersByTimeAsync(5);
    t.ttss[0]!.emitAudio("Thanks, bye now. ");
    t.ttss[0]!.finish();
    await vi.advanceTimersByTimeAsync(3000); // session grace period elapses
    // Still speaking as far as the browser reported; the end waits for playback_done.
    expect(t.link.ofType("end")).toHaveLength(0);
    t.s.onClientMessage({ type: "playback_done", turn: 1, ms: 900 });
    expect(t.link.ofType("end")).toEqual([{ type: "end", reason: "declined" }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.link.closed).toBe(true);
    t.s.close();
    await t.s.session.finalize();
    expect(t.finished[0]).toMatchObject({ outcome: "declined" });
    expect(t.sttClosed.value).toBe(true);
  });
});
