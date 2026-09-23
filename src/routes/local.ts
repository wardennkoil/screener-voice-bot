import type { FastifyInstance } from "fastify";
import type { Logger } from "../logger.js";
import type { LlmAdapter } from "../conversation/llm.js";
import { LocalVoiceSession, type BrowserLink, type LocalVoiceDeps } from "../local/local-session.js";
import { localPageHtml } from "../local/page.js";
import type { Questionnaire } from "../screening/schema.js";
import type { ElevenLabsVoiceSpec } from "../local/voice-spec.js";

export interface LocalRouteDeps {
  questionnaire: Questionnaire;
  llm: LlmAdapter;
  log: Logger;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  voice: ElevenLabsVoiceSpec;
  sampleRate: number;
  eotThreshold: number;
  eagerEotThreshold?: number;
  csvPath: string;
  transcriptsDir: string;
  recordingEnabled: boolean;
  /** Called once a finished call's transcript is on disk (queues its analysis). */
  onCallSaved?(callSid: string): void;
  /** Test seams passed through to the session. */
  sttFactory?: LocalVoiceDeps["sttFactory"];
  ttsFactory?: LocalVoiceDeps["ttsFactory"];
}

/** Laptop test mode: a page at /local and a WebSocket at /local-ws carrying mic audio in and speech out. */
export async function registerLocalRoutes(app: FastifyInstance, deps: LocalRouteDeps): Promise<void> {
  app.get("/local", async (_req, reply) => {
    return reply.type("text/html").send(localPageHtml({ sampleRate: deps.sampleRate, studyName: deps.questionnaire.study.name, persona: deps.questionnaire.caller.persona_name }));
  });

  app.get("/local-ws", { websocket: true }, (socket, req) => {
    let session: LocalVoiceSession | undefined;
    const link: BrowserLink = {
      sendJson: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      sendAudio: (turnId, pcm) => {
        if (socket.readyState !== socket.OPEN) return;
        const frame = Buffer.alloc(4 + pcm.length);
        frame.writeUInt32LE(turnId, 0);
        pcm.copy(frame, 4);
        socket.send(frame);
      },
      close: () => socket.close(),
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        session?.onMicAudio(buf);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "start") {
        if (session) return;
        const firstName = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
        session = new LocalVoiceSession(
          {
            questionnaire: deps.questionnaire,
            llm: deps.llm,
            log: req.log.child({ mode: "local" }),
            deepgramApiKey: deps.deepgramApiKey,
            elevenLabsApiKey: deps.elevenLabsApiKey,
            voice: deps.voice,
            sampleRate: deps.sampleRate,
            eotThreshold: deps.eotThreshold,
            eagerEotThreshold: deps.eagerEotThreshold,
            csvPath: deps.csvPath,
            transcriptsDir: deps.transcriptsDir,
            recordingEnabled: deps.recordingEnabled,
            firstName,
            sttFactory: deps.sttFactory,
            ttsFactory: deps.ttsFactory,
            onFinished: (record) => {
              if (record.transcript_path) deps.onCallSaved?.(record.call_sid);
            },
          },
          link,
        );
        void session.start();
        return;
      }
      session?.onClientMessage(msg);
    });
    socket.on("close", () => session?.close());
    socket.on("error", (err) => req.log.warn({ err }, "local socket error"));
  });
}
