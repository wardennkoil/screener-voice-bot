import type { FastifyInstance } from "fastify";
import type { PhoneAppDeps as AppDeps, CallRegistry } from "../app.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Questionnaire } from "../screening/schema.js";
import { appendCallRecord, type CallOutcome, type CallRecord } from "../storage/csv.js";
import { authorizeTwilioWebhook, verifySessionToken, type SessionTokenPayload } from "../telephony/signature.js";
import { escapeXml } from "./twiml.js";

type TwilioBody = Record<string, string>;

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

export function voicemailTwiml(q: Questionnaire, publicHost: string): string {
  const mp3 = resolve("assets/voicemail.mp3");
  if (existsSync(mp3)) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Play>https://${publicHost}/assets/voicemail.mp3</Play><Hangup/></Response>`;
  }
  const text = `Hi, this is ${q.caller.persona_name}, an automated assistant calling from ${q.study.organization} about ${q.study.name}. Sorry we missed you. We will try again another time, or you can reach the study team at ${q.study.callback_number_spoken}. Thanks, and have a good day.`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Google.en-US-Neural2-F">${escapeXml(text)}</Say><Hangup/></Response>`;
}

function outcomeForStatus(status: string): CallOutcome | undefined {
  switch (status) {
    case "no-answer":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return undefined;
  }
}

function emptyRecord(contact: SessionTokenPayload, callSid: string, outcome: CallOutcome, startedAt: string, durationS: number, note = ""): CallRecord {
  return {
    contact_id: contact.contactId,
    phone: contact.phone,
    call_sid: callSid,
    attempt: contact.attempt,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    duration_s: durationS,
    outcome,
    eligible: "undetermined",
    answers: {},
    verbatim: {},
    callback_when: "",
    notes: note,
    transcript_path: "",
    recording_sid: "",
  };
}

export async function registerTwilioCallbackRoutes(app: FastifyInstance, deps: AppDeps, registry: CallRegistry): Promise<void> {
  const guard = (req: Parameters<typeof authorizeTwilioWebhook>[0]): boolean => {
    if (deps.skipSignatureCheck) return true;
    const verdict = authorizeTwilioWebhook(req, deps.twilio);
    if (!verdict.ok) req.log.warn({ reason: verdict.reason, url: req.url }, "rejected Twilio callback");
    return verdict.ok;
  };

  // Serve the optional pre-recorded voicemail clip.
  app.get("/assets/voicemail.mp3", async (_req, reply) => {
    const { readFile } = await import("node:fs/promises");
    try {
      const buf = await readFile(resolve("assets/voicemail.mp3"));
      return reply.type("audio/mpeg").send(buf);
    } catch {
      return reply.code(404).send("no voicemail clip");
    }
  });

  /** Call progress: initiated / ringing / answered / completed, plus terminal failures. */
  app.post<{ Querystring: { token?: string }; Body: TwilioBody }>("/twilio/status", async (req, reply) => {
    if (!guard(req)) return reply.code(403).send("invalid signature");
    const contact = verifySessionToken(deps.twilio.sessionTokenSecret, req.query.token);
    const callSid = req.body.CallSid ?? "";
    const status = req.body.CallStatus ?? "";
    req.log.info({ callSid, status, answeredBy: req.body.AnsweredBy }, "call status");
    if (!contact || !callSid) return reply.code(204).send();

    const tracked = registry.track(callSid, contact, status);
    tracked.status = status;

    const terminal = outcomeForStatus(status);
    if (terminal && !tracked.finalized) {
      tracked.finalized = true;
      tracked.outcome = terminal;
      await appendCallRecord(deps.csvPath, deps.questionnaire, emptyRecord(contact, callSid, terminal, tracked.startedAt, Number(req.body.CallDuration ?? 0)));
    } else if (status === "completed" && !tracked.finalized) {
      if (tracked.session) {
        await tracked.session.finalize();
      } else {
        tracked.finalized = true;
        tracked.outcome = "failed";
        await appendCallRecord(deps.csvPath, deps.questionnaire, emptyRecord(contact, callSid, "failed", tracked.startedAt, Number(req.body.CallDuration ?? 0), "call completed without a relay session"));
      }
    }
    return reply.code(204).send();
  });

  /** Asynchronous answering-machine detection result. */
  app.post<{ Querystring: { token?: string }; Body: TwilioBody }>("/twilio/amd", async (req, reply) => {
    if (!guard(req)) return reply.code(403).send("invalid signature");
    const callSid = req.body.CallSid ?? "";
    const answeredBy = req.body.AnsweredBy ?? "unknown";
    req.log.info({ callSid, answeredBy }, "amd result");
    const tracked = registry.get(callSid);
    if (answeredBy.startsWith("machine_end") || answeredBy === "machine_start") {
      tracked?.session?.transcript.notes.push(`AMD: ${answeredBy}`);
      if (tracked?.session) tracked.session.markVoicemail();
      try {
        await deps.dialer.leaveVoicemail(callSid, voicemailTwiml(deps.questionnaire, deps.twilio.publicHost));
      } catch (err) {
        req.log.warn({ err }, "could not switch call to voicemail message");
      }
    } else if (answeredBy === "fax") {
      try {
        await deps.dialer.hangup(callSid);
      } catch (err) {
        req.log.warn({ err }, "could not hang up fax line");
      }
    }
    return reply.code(204).send();
  });

  /** <Connect action>: the relay session ended; tell Twilio to hang up. */
  app.post<{ Querystring: { token?: string }; Body: TwilioBody }>("/twilio/session-ended", async (req, reply) => {
    if (!guard(req)) return reply.code(403).send("invalid signature");
    const callSid = req.body.CallSid ?? "";
    req.log.info({ callSid, sessionStatus: req.body.SessionStatus, duration: req.body.SessionDuration, handoff: req.body.HandoffData, error: req.body.ErrorMessage }, "relay session ended");
    const tracked = registry.get(callSid);
    if (tracked?.session) void tracked.session.finalize();
    return reply.type("text/xml").send(HANGUP);
  });

  /** Recording lifecycle; the SID arrives with the in-progress event while the call is live. */
  app.post<{ Querystring: { token?: string }; Body: TwilioBody }>("/twilio/recording", async (req, reply) => {
    if (!guard(req)) return reply.code(403).send("invalid signature");
    const callSid = req.body.CallSid ?? "";
    const sid = req.body.RecordingSid ?? "";
    const tracked = registry.get(callSid);
    if (tracked?.session && sid) tracked.session.recordingSid = sid;
    req.log.info({ callSid, recordingSid: sid, status: req.body.RecordingStatus }, "recording status");
    return reply.code(204).send();
  });
}
