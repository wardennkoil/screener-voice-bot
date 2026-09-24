import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARTESIA_WS_URL, CartesiaTurn } from "../src/local/cartesia-tts.js";
import type { TtsTurnEvents } from "../src/local/tts.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  reply(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  /** Only the text-bearing requests (not flushes or cancels). */
  get texts(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => !m.flush && !m.cancel);
  }
}

/** PCM16 bytes for `ms` of audio at 24 kHz. */
const pcm = (ms: number) => Buffer.alloc((24000 * ms) / 1000 * 2).toString("base64");

function setup() {
  let socket!: FakeSocket;
  let url = "";
  let headers: Record<string, string> = {};
  const events = { audio: [] as Buffer[], final: 0, errors: [] as Error[] };
  const handlers: TtsTurnEvents = {
    onAudio: (c) => void events.audio.push(c.pcm),
    onFinal: () => void events.final++,
    onError: (e) => void events.errors.push(e),
  };
  const turn = new CartesiaTurn(
    {
      apiKey: "key",
      voiceId: "voice-1",
      modelId: "sonic-3.6",
      sampleRate: 24000,
      wsFactory: (u, h) => {
        url = u;
        headers = h;
        socket = new FakeSocket();
        return socket as unknown as WebSocket;
      },
    },
    handlers,
  );
  return { turn, socket: () => socket, url: () => url, headers: () => headers, events };
}

describe("CartesiaTurn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects with the key and version, queues text until open, and repeats the settings on every request", () => {
    const t = setup();
    expect(t.url()).toBe(CARTESIA_WS_URL);
    expect(t.url()).toContain("cartesia_version=2026-08-14");
    expect(t.headers()).toEqual({ "X-API-Key": "key" });

    t.turn.sendText("Hi, is this Jordan?");
    expect(t.socket().sent).toHaveLength(0);
    t.socket().open();

    const [text, flush] = t.socket().sent;
    const settings = {
      model_id: "sonic-3.6",
      voice: "voice-1",
      language: "en",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      add_timestamps: true,
      max_buffer_delay_ms: 0,
      context_id: "s0",
    };
    expect(text).toEqual({ ...settings, transcript: "Hi, is this Jordan? ", continue: true });
    expect(flush).toEqual({ ...settings, transcript: "", continue: true, flush: true });
  });

  it("streams audio, closes the context on end, and reports final on done", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("Hello there. ");
    t.socket().reply({ type: "chunk", context_id: "s0", data: pcm(500), done: false });
    t.turn.end();
    expect(t.socket().sent.at(-1)).toMatchObject({ context_id: "s0", transcript: "", continue: false });
    expect(t.events.final).toBe(0);
    t.socket().reply({ type: "done", context_id: "s0", done: true });
    expect(t.events.final).toBe(1);
    expect(t.events.audio).toHaveLength(1);
    expect(t.turn.deliveredMs).toBeCloseTo(500);
    expect(t.socket().closed).toBe(true);
  });

  it("reports what was heard from word timestamps, only counting finished words", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("Let me tell you about the study. ");
    t.socket().reply({ type: "chunk", context_id: "s0", data: pcm(1000) });
    t.socket().reply({ type: "timestamps", context_id: "s0", word_timestamps: { words: ["Let", "me", "tell"], start: [0, 0.2, 0.4], end: [0.18, 0.35, 0.6] } });
    t.socket().reply({ type: "timestamps", context_id: "s0", word_timestamps: { words: ["you", "about"], start: [0.62, 0.8], end: [0.75, 1.0] } });
    expect(t.turn.heardText(700)).toBe("Let me tell");
    expect(t.turn.heardText(1000)).toBe("Let me tell you about");
    expect(t.turn.heardText(100)).toBe("");
  });

  it("starts a new context after the old one went quiet (a tool round) and offsets its timestamps", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("Got it. ");
    t.socket().reply({ type: "chunk", context_id: "s0", data: pcm(600) });
    t.socket().reply({ type: "timestamps", context_id: "s0", word_timestamps: { words: ["Got", "it."], start: [0, 0.3], end: [0.25, 0.55] } });
    t.socket().reply({ type: "flush_done", context_id: "s0", flush_done: true, flush_id: 1 });

    vi.advanceTimersByTime(1200); // model round-trip for the next question
    t.turn.sendText("Do you have trouble sleeping? ");
    expect(t.socket().texts.at(-1)).toMatchObject({ context_id: "s1", transcript: "Do you have trouble sleeping? ", continue: true });

    t.socket().reply({ type: "chunk", context_id: "s1", data: pcm(800) });
    t.socket().reply({ type: "timestamps", context_id: "s1", word_timestamps: { words: ["Do", "you"], start: [0, 0.2], end: [0.15, 0.35] } });
    // s1's words start after s0's 600 ms of audio.
    expect(t.turn.heardText(950)).toBe("Got it. Do you");
    expect(t.turn.heardText(800)).toBe("Got it. Do");
    expect(t.turn.heardText(700)).toBe("Got it.");
    expect(t.turn.deliveredMs).toBeCloseTo(1400);
  });

  it("keeps using the same context while text arrives before generation finishes", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("First sentence. ");
    vi.advanceTimersByTime(800); // still generating: no flush answer yet
    t.turn.sendText("Second sentence. ");
    expect(t.socket().texts.map((m) => m.context_id)).toEqual(["s0", "s0"]);
  });

  it("finishes without another request when the context already went quiet", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("Thanks for your time. ");
    t.socket().reply({ type: "chunk", context_id: "s0", data: pcm(900) });
    t.socket().reply({ type: "flush_done", context_id: "s0", flush_done: true, flush_id: 1 });
    vi.advanceTimersByTime(1500);
    const before = t.socket().sent.length;
    t.turn.end();
    expect(t.socket().sent).toHaveLength(before);
    expect(t.events.final).toBe(1);
  });

  it("finishes straight away when no text was ever sent", () => {
    const t = setup();
    t.socket().open();
    t.turn.end();
    expect(t.socket().sent).toHaveLength(0);
    expect(t.events.final).toBe(1);
  });

  it("cancels the context on abort and ignores anything that still arrives", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("A long answer. ");
    t.turn.abort();
    expect(t.socket().sent.at(-1)).toEqual({ context_id: "s0", cancel: true });
    expect(t.socket().closed).toBe(true);
    t.socket().reply({ type: "chunk", context_id: "s0", data: pcm(200) });
    expect(t.events.audio).toHaveLength(0);
  });

  it("surfaces errors on the current context and ignores them on an earlier one", () => {
    const t = setup();
    t.socket().open();
    t.turn.sendText("One. ");
    t.socket().reply({ type: "flush_done", context_id: "s0", flush_done: true });
    vi.advanceTimersByTime(1200);
    t.turn.sendText("Two. ");
    t.socket().reply({ type: "error", context_id: "s0", done: true, title: "Context expired", status_code: 400 });
    expect(t.events.errors).toHaveLength(0);
    t.socket().reply({ type: "error", context_id: "s1", done: true, title: "Invalid voice", message: "voice not found", status_code: 400 });
    expect(t.events.errors.map((e) => e.message)).toEqual(["Cartesia: Invalid voice (voice not found)"]);
  });

  it("surfaces errors that are not tied to a context", () => {
    const t = setup();
    t.socket().open();
    t.socket().reply({ type: "error", done: true, title: "Unauthorized", status_code: 401 });
    expect(t.events.errors.map((e) => e.message)).toEqual(["Cartesia: Unauthorized"]);
  });
});
