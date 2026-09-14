import type { FastifyInstance } from "fastify";
import type { PhoneAppDeps as AppDeps } from "../app.js";
import { flattenQuestions, type Questionnaire } from "../screening/schema.js";
import { authorizeTwilioWebhook, verifySessionToken } from "../telephony/signature.js";

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Speech-recognition hints: names and option words the person is likely to say. */
export function buildHints(q: Questionnaire): string {
  const words = new Set<string>([q.caller.persona_name, q.study.organization, q.study.name]);
  for (const question of flattenQuestions(q)) for (const o of question.options ?? []) words.add(o);
  return [...words]
    .map((w) => w.replace(/^the /i, "").trim())
    .filter((w) => w.length > 1)
    .slice(0, 40)
    .join(", ");
}

export interface RelayTwimlOptions {
  publicHost: string;
  token: string;
  voice: string;
  eotThreshold: number;
  interruptSensitivity: string;
  hints: string;
}

/**
 * The TwiML that hands the answered call to ConversationRelay. Attribute names
 * follow Twilio's documented camelCase; the SDK's builder lags behind on the
 * Flux-specific ones, so the XML is assembled by hand.
 */
export function buildRelayTwiml(o: RelayTwimlOptions): string {
  const action = `https://${o.publicHost}/twilio/session-ended?token=${encodeURIComponent(o.token)}`;
  const attrs: Record<string, string> = {
    url: `wss://${o.publicHost}/cr`,
    ttsProvider: "ElevenLabs",
    voice: o.voice,
    elevenlabsTextNormalization: "off",
    transcriptionProvider: "Deepgram",
    speechModel: "flux",
    eotThreshold: o.eotThreshold.toFixed(2),
    interruptible: "any",
    interruptSensitivity: o.interruptSensitivity,
    ignoreBackchannel: "true",
    dtmfDetection: "true",
    events: "speaker-events tokens-played",
    hints: o.hints,
  };
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${escapeXml(action)}">
    <ConversationRelay ${attrText}>
      <Parameter name="token" value="${escapeXml(o.token)}"/>
    </ConversationRelay>
  </Connect>
</Response>`;
}

export async function registerTwimlRoute(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const hints = buildHints(deps.questionnaire);
  app.post<{ Querystring: { token?: string } }>("/twiml/screener", async (req, reply) => {
    if (!deps.skipSignatureCheck) {
      const verdict = authorizeTwilioWebhook(req, deps.twilio);
      if (!verdict.ok) {
        req.log.warn({ reason: verdict.reason }, "rejected TwiML request");
        return reply.code(403).send(verdict.reason);
      }
      req.log.info({ via: verdict.via }, "TwiML request authorized");
    }
    const token = req.query.token;
    const payload = verifySessionToken(deps.twilio.sessionTokenSecret, token);
    if (!payload || !token) {
      req.log.warn("twiml request with invalid token");
      return reply.code(403).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
    const twiml = buildRelayTwiml({
      publicHost: deps.twilio.publicHost,
      token,
      voice: deps.voice.elevenLabsVoice,
      eotThreshold: deps.voice.eotThreshold,
      interruptSensitivity: deps.voice.interruptSensitivity,
      hints,
    });
    return reply.type("text/xml").send(twiml);
  });
}
