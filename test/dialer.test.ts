import pino from "pino";
import { describe, expect, it } from "vitest";
import { Dialer, type CallsClient } from "../src/telephony/dialer.js";

const env = { accountSid: "ACtest", authToken: "tok", fromNumber: "+15550009999", publicHost: "example.test", sessionTokenSecret: "s3cret-s3cret-s3cret" };
const contact = { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 1 };
const TRIAL_ERROR = new Error("Invalid or disallowed parameters provided - trial accounts have limited parameter access, upgrade your account to unlock full functionality");

function stubClient(rejectWhile: (params: Record<string, unknown>) => boolean): { client: CallsClient; attempts: Record<string, unknown>[] } {
  const attempts: Record<string, unknown>[] = [];
  const calls = Object.assign((sid: string) => ({ update: async (p: Record<string, unknown>) => ({ sid, ...p }) }), {
    create: async (params: Record<string, unknown>) => {
      attempts.push(params);
      if (rejectWhile(params)) throw TRIAL_ERROR;
      return { sid: `CA${attempts.length}` };
    },
  });
  return { client: { calls }, attempts };
}

describe("Dialer", () => {
  it("sends the full parameter set when Twilio accepts it", async () => {
    const { client, attempts } = stubClient(() => false);
    const d = new Dialer(env, { record: true }, pino({ level: "silent" }), client);
    const r = await d.dial(contact);
    expect(r).toEqual({ callSid: "CA1", tier: "full" });
    expect(attempts[0]).toMatchObject({ machineDetection: "DetectMessageEnd", asyncAmd: "true", record: true, to: "+15550001111" });
    expect(String(attempts[0]!.url)).toMatch(/^https:\/\/example\.test\/twiml\/screener\?token=/);
  });

  it("retries with the trial-safe set (no AMD, recording, method or timeout), then remembers the tier", async () => {
    const trialRejects = (p: Record<string, unknown>) => ["method", "timeout", "machineDetection", "asyncAmd", "record"].some((k) => k in p);
    const { client, attempts } = stubClient(trialRejects);
    const d = new Dialer(env, { record: true }, pino({ level: "silent" }), client);
    const r = await d.dial(contact);
    expect(r.tier).toBe("trial_safe");
    expect(attempts).toHaveLength(2);
    expect(Object.keys(attempts[1]!).sort()).toEqual(["from", "statusCallback", "statusCallbackEvent", "to", "url"]);
    expect(String(attempts[1]!.statusCallback)).toMatch(/\/twilio\/status\?token=/);
    await d.dial({ ...contact, attempt: 2 });
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).not.toHaveProperty("machineDetection");
  });

  it("falls back to the bare call if status callbacks are also rejected", async () => {
    const { client, attempts } = stubClient((p) => "statusCallback" in p);
    const d = new Dialer(env, { record: false }, pino({ level: "silent" }), client);
    const r = await d.dial(contact);
    expect(r.tier).toBe("bare");
    expect(attempts).toHaveLength(3);
    expect(Object.keys(attempts[2]!).sort()).toEqual(["from", "to", "url"]);
  });

  it("does not retry on unrelated errors", async () => {
    const calls = Object.assign((sid: string) => ({ update: async () => ({ sid }) }), {
      create: async () => {
        throw new Error("The number +15550001111 is unverified. Trial accounts cannot call unverified numbers.");
      },
    });
    const d = new Dialer(env, { record: false }, pino({ level: "silent" }), { calls });
    await expect(d.dial(contact)).rejects.toThrow(/unverified/);
  });
});
