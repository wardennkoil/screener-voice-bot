import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PhoneAppDeps as AppDeps, CallRegistry } from "../app.js";

const DialBody = z.object({
  contactId: z.string().min(1),
  phone: z.string().regex(/^\+\d{8,15}$/),
  firstName: z.string().min(1),
  attempt: z.number().int().min(1).default(1),
});

/**
 * Control API used by the CLI. The server is reachable through ngrok, so every
 * route here requires `Authorization: Bearer <SESSION_TOKEN_SECRET>`.
 */
export async function registerCallRoutes(app: FastifyInstance, deps: AppDeps, registry: CallRegistry): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/calls")) return;
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${deps.twilio.sessionTokenSecret}`) return reply.code(401).send({ error: "missing or invalid bearer token" });
  });

  app.post("/calls", async (req, reply) => {
    const parsed = DialBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    if (deps.twilioAccountType === "Trial" && !deps.allowTrialCalls) {
      return reply.code(409).send({
        error:
          "This Twilio account is a trial account. Twilio blocks the ConversationRelay verb on trial accounts, so the call would connect and end within seconds. " +
          "Upgrade the account at https://console.twilio.com/ (Billing -> Upgrade), buy a voice-capable number and put it in TWILIO_FROM_NUMBER, then restart the server. " +
          "Set ALLOW_TRIAL_CALLS=true to dial anyway.",
      });
    }
    const contact = parsed.data;
    const { callSid } = await deps.dialer.dial(contact);
    registry.track(callSid, { ...contact, exp: 0 }, "queued");
    return reply.code(202).send({ callSid });
  });

  app.get<{ Params: { sid: string } }>("/calls/:sid", async (req, reply) => {
    const call = registry.get(req.params.sid);
    if (!call) return reply.code(404).send({ error: "unknown call" });
    return {
      callSid: call.callSid,
      contactId: call.contact.contactId,
      status: call.status,
      finalized: call.finalized,
      outcome: call.outcome ?? null,
      eligible: call.eligible ?? null,
      startedAt: call.startedAt,
    };
  });

  app.get("/calls", async () => registry.list().map((c) => ({ callSid: c.callSid, contactId: c.contact.contactId, status: c.status, finalized: c.finalized, outcome: c.outcome ?? null })));
}
