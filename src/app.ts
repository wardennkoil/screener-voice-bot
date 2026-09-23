import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import type { TwilioEnv } from "./config.js";
import type { LlmAdapter } from "./conversation/llm.js";
import type { CallSession } from "./conversation/session.js";
import type { Logger } from "./logger.js";
import { registerAdminRoutes, type AdminDeps } from "./routes/admin.js";
import { registerCallRoutes } from "./routes/calls.js";
import { registerLocalRoutes, type LocalRouteDeps } from "./routes/local.js";
import { registerRelayRoute } from "./routes/relay-ws.js";
import { registerTwilioCallbackRoutes } from "./routes/twilio-callbacks.js";
import { registerTwimlRoute } from "./routes/twiml.js";
import type { Questionnaire } from "./screening/schema.js";
import type { SessionTokenPayload } from "./telephony/signature.js";
import type { CallOutcome } from "./storage/csv.js";

export interface VoiceSettings {
  elevenLabsVoice: string;
  eotThreshold: number;
  interruptSensitivity: "high" | "medium" | "low";
}

export interface TrackedCall {
  callSid: string;
  contact: SessionTokenPayload;
  status: string;
  startedAt: string;
  outcome?: CallOutcome;
  eligible?: string;
  session?: CallSession;
  finalized: boolean;
}

/** What the routes need from the dialer (the real one wraps the Twilio SDK; tests stub it). */
export interface DialerLike {
  dial(contact: { contactId: string; phone: string; firstName: string; attempt: number }): Promise<{ callSid: string }>;
  leaveVoicemail(callSid: string, twiml: string): Promise<void>;
  hangup(callSid: string): Promise<void>;
}

export interface AppDeps {
  questionnaire: Questionnaire;
  llm: LlmAdapter;
  /** Phone path; when either is missing the Twilio routes are not registered. */
  twilio?: TwilioEnv;
  dialer?: DialerLike;
  /** Laptop voice mode; registered when present. */
  local?: Omit<LocalRouteDeps, "questionnaire" | "llm" | "log" | "recordingEnabled" | "onCallSaved">;
  /** Admin panel at /admin with post-call analysis; registered when present. */
  admin?: AdminDeps;
  voice: VoiceSettings;
  recordingEnabled: boolean;
  csvPath: string;
  transcriptsDir: string;
  log: Logger;
  /** Development only: accept Twilio webhooks without a valid signature. */
  skipSignatureCheck?: boolean;
  /** Twilio account type as reported by the API ("Trial" or "Full"); undefined when unknown. */
  twilioAccountType?: string;
  /** Let trial accounts dial anyway (the relay verb is blocked on them, so calls end in seconds). */
  allowTrialCalls?: boolean;
  /** Called once a finished call's transcript is on disk; buildApp wires it to the analysis queue. */
  onCallSaved?(callSid: string): void;
}

/** AppDeps with the phone path present; what the Twilio routes require. */
export type PhoneAppDeps = AppDeps & { twilio: TwilioEnv; dialer: DialerLike };

export class CallRegistry {
  private readonly calls = new Map<string, TrackedCall>();

  track(callSid: string, contact: SessionTokenPayload, status = "queued"): TrackedCall {
    const existing = this.calls.get(callSid);
    if (existing) return existing;
    const call: TrackedCall = { callSid, contact, status, startedAt: new Date().toISOString(), finalized: false };
    this.calls.set(callSid, call);
    return call;
  }

  get(callSid: string): TrackedCall | undefined {
    return this.calls.get(callSid);
  }

  list(): TrackedCall[] {
    return [...this.calls.values()];
  }

  activeCount(): number {
    return this.list().filter((c) => !c.finalized).length;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    callRegistry: CallRegistry;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log as unknown as FastifyBaseLogger, trustProxy: true });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 1_048_576 } });

  if (deps.admin) {
    const service = deps.admin.service;
    const outer = deps.onCallSaved;
    deps = {
      ...deps,
      onCallSaved: (sid) => {
        outer?.(sid);
        service.enqueue(sid);
      },
    };
  }

  const registry = new CallRegistry();
  app.decorate("callRegistry", registry);

  app.get("/health", async () => ({
    ok: true,
    activeCalls: registry.activeCount(),
    phone: Boolean(deps.twilio && deps.dialer),
    local: deps.local ? { voiceId: deps.local.voice.voiceId, modelId: deps.local.voice.modelId, sampleRate: deps.local.sampleRate, eotThreshold: deps.local.eotThreshold } : null,
  }));

  if (deps.twilio && deps.dialer) {
    const phone: PhoneAppDeps = { ...deps, twilio: deps.twilio, dialer: deps.dialer };
    await registerTwimlRoute(app, phone);
    await registerRelayRoute(app, phone, registry);
    await registerTwilioCallbackRoutes(app, phone, registry);
    await registerCallRoutes(app, phone, registry);
  } else {
    deps.log.warn("Twilio is not configured; phone routes are disabled (set TWILIO_* and PUBLIC_HOST to enable)");
  }

  if (deps.local) {
    await registerLocalRoutes(app, { ...deps.local, questionnaire: deps.questionnaire, llm: deps.llm, log: deps.log, recordingEnabled: deps.recordingEnabled, onCallSaved: deps.onCallSaved });
  }

  if (deps.admin) {
    await registerAdminRoutes(app, { ...deps.admin, questionnaire: deps.questionnaire });
  }

  return app;
}
