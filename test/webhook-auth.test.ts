import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import twilio from "twilio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { LlmAdapter } from "../src/conversation/llm.js";
import { makeSessionToken } from "../src/telephony/signature.js";
import { sampleQuestionnaire } from "./helpers.js";

const twilioEnv = { accountSid: "ACaccount", authToken: "auth-token", fromNumber: "+15550009999", publicHost: "example.test", sessionTokenSecret: "webhook-secret-webhook-secret" };
const llm: LlmAdapter = { run: async () => ({ steps: [], toolCalls: [], text: "", aborted: false }) };

describe("Twilio webhook authorization (signature check on)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const token = makeSessionToken(twilioEnv.sessionTokenSecret, { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 1 });
  const path = `/twiml/screener?token=${encodeURIComponent(token)}`;
  const body = { CallSid: "CA1", AccountSid: "ACaccount", From: "+15550009999", To: "+15550001111" };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "screener-auth-"));
    app = await buildApp({
      questionnaire: sampleQuestionnaire(),
      llm,
      twilio: twilioEnv,
      dialer: { dial: async () => ({ callSid: "CA" }), leaveVoicemail: async () => {}, hangup: async () => {} },
      voice: { elevenLabsVoice: "V", eotThreshold: 0.7, interruptSensitivity: "medium" },
      recordingEnabled: false,
      csvPath: join(dir, "r.csv"),
      transcriptsDir: join(dir, "calls"),
      log: pino({ level: "silent" }),
    });
    await app.ready();
  });
  afterAll(async () => app.close());

  it("accepts a correctly signed request", async () => {
    const signature = twilio.getExpectedTwilioSignature(twilioEnv.authToken, `https://example.test${path}`, body);
    const res = await app.inject({ method: "POST", url: path, headers: { "x-twilio-signature": signature }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<ConversationRelay");
  });

  it("rejects a bad signature even with a valid token", async () => {
    const res = await app.inject({ method: "POST", url: path, headers: { "x-twilio-signature": "nope" }, payload: body });
    expect(res.statusCode).toBe(403);
  });

  it("accepts an unsigned request that carries a valid token for our own account", async () => {
    const res = await app.inject({ method: "POST", url: path, payload: body });
    expect(res.statusCode).toBe(200);
  });

  it("rejects unsigned requests with a bad token or another account", async () => {
    const other = await app.inject({ method: "POST", url: path, payload: { ...body, AccountSid: "ACsomeoneelse" } });
    expect(other.statusCode).toBe(403);
    const forged = await app.inject({ method: "POST", url: "/twiml/screener?token=forged.token", payload: body });
    expect(forged.statusCode).toBe(403);
    const status = await app.inject({ method: "POST", url: "/twilio/status?token=forged.token", payload: { ...body, CallStatus: "completed" } });
    expect(status.statusCode).toBe(403);
  });
});
