import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/conversation/prompt.js";
import { sampleQuestionnaire } from "./helpers.js";

describe("system prompt", () => {
  it("omits the automated-assistant opening when disclosure is off but keeps the honesty rule", () => {
    const q = sampleQuestionnaire();
    q.caller.ai_disclosure = false;
    const p = buildSystemPrompt(q, { firstName: "Jordan", recordingEnabled: false });
    expect(p).toContain("Sam from the study team");
    expect(p).toContain("applied for the Restful Nights sleep study");
    expect(p).not.toMatch(/who you are, that you are an automated assistant/);
    expect(p).toMatch(/never claim to be human/);
    expect(p).toMatch(/If asked whether you are a real person, say plainly that you are an automated assistant/);
  });

  it("includes the disclosure in the opening when it is on", () => {
    const q = sampleQuestionnaire();
    q.caller.ai_disclosure = true;
    const p = buildSystemPrompt(q, { firstName: "Jordan", recordingEnabled: true });
    expect(p).toMatch(/who you are, that you are an automated assistant, that the call is recorded for quality/);
  });
});
