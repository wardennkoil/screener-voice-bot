import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { LlmAdapter } from "../src/conversation/llm.js";
import type { FluxEvents, SttStream } from "../src/local/deepgram-flux.js";
import type { ElevenLabsTurnEvents } from "../src/local/elevenlabs-tts.js";
import type { TtsTurn } from "../src/local/local-session.js";
import { sampleQuestionnaire } from "./helpers.js";

describe("laptop voice mode over the app", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let flux: FluxEvents | undefined;
  const mic: Buffer[] = [];
  let ttsEvents: ElevenLabsTurnEvents | undefined;
  const llm: LlmAdapter = {
    async run(_p, h) {
      h.onText("Hi, is this Jordan? ");
      return { steps: [{ type: "model_output", content: [{ type: "text", text: "Hi, is this Jordan? " }] }], toolCalls: [], text: "Hi, is this Jordan? ", aborted: false };
    },
  };

  beforeAll(async () => {
    app = await buildApp({
      questionnaire: sampleQuestionnaire(),
      llm,
      voice: { elevenLabsVoice: "V", eotThreshold: 0.7, interruptSensitivity: "medium" },
      recordingEnabled: false,
      csvPath: "/dev/null",
      transcriptsDir: "/tmp",
      log: pino({ level: "silent" }),
      local: {
        deepgramApiKey: "dg",
        elevenLabsApiKey: "el",
        voice: { voiceId: "V", modelId: "eleven_flash_v2_5" },
        sampleRate: 24000,
        eotThreshold: 0.7,
        csvPath: undefined as unknown as string,
        transcriptsDir: undefined as unknown as string,
        sttFactory: async (_o, events): Promise<SttStream> => {
          flux = events;
          return { sendAudio: (b) => void mic.push(b), close: () => undefined };
        },
        ttsFactory: (_o, events): TtsTurn => {
          ttsEvents = events;
          return { sendText: () => undefined, end: () => undefined, abort: () => undefined, heardText: () => "", deliveredMs: 0 };
        },
      },
    });
    await app.ready();
  });
  afterAll(async () => app.close());

  it("boots without Twilio and serves the test page", async () => {
    const page = await app.inject({ method: "GET", url: "/local" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Start call");
    expect(page.body).toContain("Restful Nights");
    const twiml = await app.inject({ method: "POST", url: "/twiml/screener" });
    expect(twiml.statusCode).toBe(404);
  });

  it("streams mic audio to speech recognition and speech back to the browser with turn ids", async () => {
    const ws = await app.injectWS("/local-ws");
    const json: Array<Record<string, unknown>> = [];
    const audio: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) audio.push(data as Buffer);
      else json.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    const until = (pred: () => boolean, ms = 2000) =>
      new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const tick = () => (pred() ? resolve() : Date.now() - start > ms ? reject(new Error("timeout")) : setTimeout(tick, 10));
        tick();
      });
    ws.send(JSON.stringify({ type: "start", sampleRate: 24000, name: "Jordan" }));
    await until(() => json.some((m) => m.type === "state" && m.state === "listening"));
    ws.send(Buffer.alloc(3840));
    await until(() => mic.length > 0);
    expect(mic[0]!.length).toBe(3840);

    flux!.onTurn({ event: "EndOfTurn", transcript: "Hello?", turnIndex: 0, confidence: 0.9, words: ["Hello?"] });
    await until(() => json.some((m) => m.type === "transcript" && m.final === true && m.role === "Sam"));
    ttsEvents!.onAudio({ pcm: Buffer.from([1, 2, 3, 4]), chars: ["H", "i"], charStartMs: [0, 50] });
    await until(() => audio.length > 0);
    expect(audio[0]!.readUInt32LE(0)).toBe(1);
    expect([...audio[0]!.subarray(4)]).toEqual([1, 2, 3, 4]);
    ws.close();
  }, 10000);
});
