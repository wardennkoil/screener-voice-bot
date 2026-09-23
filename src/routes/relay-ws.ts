import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { PhoneAppDeps as AppDeps, CallRegistry } from "../app.js";
import { CallSession } from "../conversation/session.js";
import type { Transport } from "../conversation/transport.js";
import { verifySessionToken } from "../telephony/signature.js";

/** Assistant speech goes out as ConversationRelay text tokens. */
class RelayTransport implements Transport {
  constructor(private readonly socket: WebSocket) {}
  private send(msg: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(msg));
  }
  sendText(token: string, last: boolean): void {
    this.send({ type: "text", token, last });
  }
  play(url: string): void {
    this.send({ type: "play", source: url, loop: 1, interruptible: true });
  }
  end(handoffData?: Record<string, unknown>): void {
    this.send({ type: "end", handoffData: JSON.stringify(handoffData ?? {}) });
  }
}

interface RelayMessage {
  type: string;
  [k: string]: unknown;
}

export async function registerRelayRoute(app: FastifyInstance, deps: AppDeps, registry: CallRegistry): Promise<void> {
  app.get("/cr", { websocket: true }, (socket, req) => {
    let session: CallSession | undefined;
    const log = req.log;

    socket.on("message", (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString()) as RelayMessage;
      } catch {
        log.warn("relay: non-JSON message");
        return;
      }

      if (msg.type === "setup") {
        const custom = (msg.customParameters ?? {}) as Record<string, string>;
        const payload = verifySessionToken(deps.twilio.sessionTokenSecret, custom.token);
        const callSid = String(msg.callSid ?? "unknown");
        if (!payload) {
          log.warn({ callSid }, "relay setup with invalid token; ending");
          socket.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason: "unauthorized" }) }));
          socket.close();
          return;
        }
        const tracked = registry.track(callSid, payload, "in-progress");
        const transport = new RelayTransport(socket);
        session = new CallSession({
          callSid,
          contact: { contactId: payload.contactId, phone: payload.phone, firstName: payload.firstName, attempt: payload.attempt },
          questionnaire: deps.questionnaire,
          llm: deps.llm,
          transport,
          log: log.child({ callSid, contactId: payload.contactId }),
          recordingEnabled: deps.recordingEnabled,
          csvPath: deps.csvPath,
          transcriptsDir: deps.transcriptsDir,
          onFinished: (record) => {
            tracked.finalized = true;
            tracked.outcome = record.outcome;
            tracked.eligible = record.eligible;
            tracked.status = "finished";
            if (record.transcript_path) deps.onCallSaved?.(callSid);
          },
        });
        tracked.session = session;
        session.transcript.relayEvents.push({ at: new Date().toISOString(), type: "setup", data: { from: msg.from, to: msg.to, direction: msg.direction } });
        session.start();
        log.info({ callSid, contactId: payload.contactId }, "relay session started");
        return;
      }

      if (!session) {
        log.warn({ type: msg.type }, "relay message before setup");
        return;
      }

      switch (msg.type) {
        case "prompt":
          session.onPrompt(String(msg.voicePrompt ?? ""), msg.last !== false);
          break;
        case "interrupt":
          session.onInterrupt(String(msg.utteranceUntilInterrupt ?? ""), typeof msg.durationUntilInterruptMs === "number" ? msg.durationUntilInterruptMs : undefined);
          break;
        case "dtmf":
          session.onDtmf(String(msg.digit ?? ""));
          break;
        case "error":
          session.onError(String(msg.description ?? "unknown"));
          break;
        default:
          // speaker-events / tokens-played subscriptions and anything new: keep for analysis.
          if (/token/i.test(msg.type)) session.onTokensPlayed(msg);
          else session.transcript.relayEvents.push({ at: new Date().toISOString(), type: msg.type, data: msg });
          break;
      }
    });

    socket.on("close", () => {
      log.info("relay socket closed");
      session?.onClose();
    });
    socket.on("error", (err) => {
      log.warn({ err }, "relay socket error");
    });
  });
}
