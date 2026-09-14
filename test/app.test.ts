import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type DialerLike } from "../src/app.js";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult } from "../src/conversation/llm.js";
import { makeSessionToken } from "../src/telephony/signature.js";
import { sampleQuestionnaire } from "./helpers.js";

const SECRET = "test-secret-test-secret";
const twilio = { accountSid: "ACtest", authToken: "tok", fromNumber: "+15550009999", publicHost: "example.test", sessionTokenSecret: SECRET };

class ScriptedLlm implements LlmAdapter {
  async run(params: LlmRunParams, h: LlmRunHandlers): Promise<LlmRunResult> {
    const last = params.history.at(-1);
    const text = last?.type === "user_input" ? last.content[0]!.text : "";
    const say = (t: string): LlmRunResult => {
      h.onText(t);
      return { steps: [{ type: "model_output", content: [{ type: "text", text: t }] }], toolCalls: [], text: t, aborted: false };
    };
    if (/not interested/i.test(text)) {
      const t = "No problem at all, thanks for your time. Bye now.";
      h.onText(t);
      const steps: HistoryStep[] = [{ type: "model_output", content: [{ type: "text", text: t }] }, { type: "function_call", id: "e1", name: "end_call", arguments: { reason: "declined" } }];
      return { steps, toolCalls: [{ id: "e1", name: "end_call", args: { reason: "declined" } }], text: t, aborted: false };
    }
    return say("Hi, is this Jordan?");
  }
}

describe("server", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const dialed: unknown[] = [];
  const voicemails: string[] = [];
  const dialer: DialerLike = {
    async dial(c) {
      dialed.push(c);
      return { callSid: "CA-dialed" };
    },
    async leaveVoicemail(_sid, twiml) {
      voicemails.push(twiml);
    },
    async hangup() {},
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screener-app-"));
    app = await buildApp({
      questionnaire: sampleQuestionnaire(),
      llm: new ScriptedLlm(),
      twilio,
      dialer,
      voice: { elevenLabsVoice: "V-flash_v2_5", eotThreshold: 0.7, interruptSensitivity: "medium" },
      recordingEnabled: false,
      csvPath: join(dir, "results.csv"),
      transcriptsDir: join(dir, "calls"),
      log: pino({ level: "silent" }),
      skipSignatureCheck: true,
    });
    await app.ready();
  });
  afterAll(async () => app.close());

  it("serves ConversationRelay TwiML for a signed token and rejects a bad one", async () => {
    const token = makeSessionToken(SECRET, { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 1 });
    const ok = await app.inject({ method: "POST", url: `/twiml/screener?token=${encodeURIComponent(token)}`, payload: { CallSid: "CA1" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/xml");
    expect(ok.body).toContain('speechModel="flux"');
    expect(ok.body).toContain(`<Parameter name="token" value="${token}"/>`);
    const bad = await app.inject({ method: "POST", url: `/twiml/screener?token=nope`, payload: {} });
    expect(bad.statusCode).toBe(403);
    expect(bad.body).toContain("<Hangup/>");
  });

  it("places calls through the control API and tracks them", async () => {
    const unauthorized = await app.inject({ method: "POST", url: "/calls", payload: { contactId: "C9", phone: "+15550001234", firstName: "Priya" } });
    expect(unauthorized.statusCode).toBe(401);
    const auth = { authorization: `Bearer ${SECRET}` };
    const res = await app.inject({ method: "POST", url: "/calls", headers: auth, payload: { contactId: "C9", phone: "+15550001234", firstName: "Priya" } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ callSid: "CA-dialed" });
    expect(dialed).toHaveLength(1);
    const status = await app.inject({ method: "GET", url: "/calls/CA-dialed", headers: auth });
    expect(status.json()).toMatchObject({ contactId: "C9", status: "queued", finalized: false });
  });

  it("runs a relay session over the WebSocket and writes the CSV row on end", async () => {
    const token = makeSessionToken(SECRET, { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 1 });
    const ws = await app.injectWS("/cr");
    const received: Array<Record<string, unknown>> = [];
    const waitFor = (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting; got ${JSON.stringify(received)}`)), timeoutMs);
        const check = () => {
          if (received.some(pred)) {
            clearTimeout(timer);
            resolve();
            return true;
          }
          return false;
        };
        if (check()) return;
        ws.on("message", () => check());
      });
    ws.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));

    ws.send(JSON.stringify({ type: "setup", callSid: "CA-ws", from: "+15550009999", to: "+15550001111", direction: "outbound-api", customParameters: { token } }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Hello?", lang: "en-US", last: true }));
    await waitFor((m) => m.type === "text" && m.last === true);
    expect(received.map((m) => m.token).join("")).toBe("Hi, is this Jordan?");

    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Sorry, not interested.", lang: "en-US", last: true }));
    await waitFor((m) => m.type === "end", 8000);
    expect(JSON.parse(String(received.find((m) => m.type === "end")!.handoffData))).toEqual({ reason: "declined" });
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    const csv = await readFile(join(dir, "results.csv"), "utf8");
    expect(csv.trim().split("\n")).toHaveLength(2);
    expect(csv).toContain("C1,+15550001111,CA-ws,1,");
    expect(csv).toContain(",declined,undetermined,");
    const status = await app.inject({ method: "GET", url: "/calls/CA-ws", headers: { authorization: `Bearer ${SECRET}` } });
    expect(status.json()).toMatchObject({ finalized: true, outcome: "declined" });
  }, 15000);

  it("rejects a relay session with a bad token", async () => {
    const ws = await app.injectWS("/cr");
    const first = new Promise<Record<string, unknown>>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA-bad", customParameters: { token: "forged" } }));
    expect(await first).toMatchObject({ type: "end" });
  });

  it("switches to the voicemail message when AMD reports a machine", async () => {
    const res = await app.inject({ method: "POST", url: "/twilio/amd", payload: { CallSid: "CA-ws", AnsweredBy: "machine_end_beep" } });
    expect(res.statusCode).toBe(204);
    expect(voicemails).toHaveLength(1);
    expect(voicemails[0]).toContain("<Hangup/>");
  });

  it("records terminal statuses for calls that never connected", async () => {
    const token = makeSessionToken(SECRET, { contactId: "C2", phone: "+15550002222", firstName: "Sam", attempt: 1 });
    const res = await app.inject({ method: "POST", url: `/twilio/status?token=${encodeURIComponent(token)}`, payload: { CallSid: "CA-noanswer", CallStatus: "no-answer", CallDuration: "0" } });
    expect(res.statusCode).toBe(204);
    const csv = await readFile(join(dir, "results.csv"), "utf8");
    expect(csv).toContain("C2,+15550002222,CA-noanswer,1,");
    expect(csv).toContain(",no_answer,undetermined,");
  });
});
