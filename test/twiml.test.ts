import { describe, expect, it } from "vitest";
import { buildHints, buildRelayTwiml } from "../src/routes/twiml.js";
import { makeSessionToken, verifySessionToken } from "../src/telephony/signature.js";
import { sampleQuestionnaire } from "./helpers.js";

describe("relay TwiML", () => {
  it("emits ConversationRelay with Flux turn detection and the signed token", () => {
    const xml = buildRelayTwiml({ publicHost: "example.ngrok.app", token: "abc.def", voice: "V-flash_v2_5-1.0_0.5_0.75", eotThreshold: 0.7, interruptSensitivity: "medium", hints: "Sam, Meridian & Co" });
    expect(xml).toContain('url="wss://example.ngrok.app/cr"');
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('eotThreshold="0.70"');
    expect(xml).toContain('ttsProvider="ElevenLabs"');
    expect(xml).toContain('ignoreBackchannel="true"');
    expect(xml).toContain('hints="Sam, Meridian &amp; Co"');
    expect(xml).toContain('<Parameter name="token" value="abc.def"/>');
    expect(xml).toContain('action="https://example.ngrok.app/twilio/session-ended?token=abc.def"');
    expect(xml).not.toContain("welcomeGreeting");
  });

  it("derives speech hints from the questionnaire", () => {
    const hints = buildHints(sampleQuestionnaire());
    expect(hints).toContain("Sam");
    expect(hints).toContain("former");
    expect(hints).not.toMatch(/^the /);
  });
});

describe("session token", () => {
  it("round-trips and rejects tampering or expiry", () => {
    const token = makeSessionToken("secret-secret-secret", { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 2 });
    expect(verifySessionToken("secret-secret-secret", token)).toMatchObject({ contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 2 });
    expect(verifySessionToken("other-secret-other", token)).toBeNull();
    const [body, sig] = token.split(".");
    expect(verifySessionToken("secret-secret-secret", `${body}x.${sig}`)).toBeNull();
    const expired = makeSessionToken("secret-secret-secret", { contactId: "C1", phone: "+15550001111", firstName: "Jordan", attempt: 1 }, -10);
    expect(verifySessionToken("secret-secret-secret", expired)).toBeNull();
  });
});
