import { describe, expect, it } from "vitest";
import { analyzeCall, buildAnalysisPrompt, CallAnalysisSchema, renderTranscriptForAnalysis, transcriptHash } from "../src/analytics/analyze.js";
import { buildOverview, bundle } from "../src/analytics/overview.js";
import { computeStats, displayTurns } from "../src/analytics/stats.js";
import type { LlmAdapter } from "../src/conversation/llm.js";
import { sampleAnalysisArgs, sampleTranscript, stubAnalyst } from "./analytics-fixture.js";
import { sampleQuestionnaire } from "./helpers.js";

const q = sampleQuestionnaire();

describe("call stats", () => {
  it("splits bracketed phone-system notes off person turns", () => {
    const turn = displayTurns(sampleTranscript())[6]!;
    expect(turn.note).toBe('[The person interrupted after hearing: "Okay, twenty-two."]');
    expect(turn.text).toBe("I had it as a kid, not anymore.");
    expect(turn.offsetS).toBe(17);
  });

  it("measures coverage, order, interruptions, silence, latency and tool errors", () => {
    const s = computeStats(sampleTranscript(), q);
    expect(s.durationS).toBe(60);
    expect(s.interruptions).toBe(1);
    expect(s.silenceNudges).toBe(1);
    // Interrupted turn counts only the heard words ("Okay, twenty-two." = 2 words).
    expect(s.assistantWords).toBe(4 + 10 + 2 + 4);
    expect(s.toolErrors).toEqual([{ at: expect.any(String), name: "record_answer", error: "Screening has not started." }]);
    expect(s.flags).toEqual(["tool state error"]);
    expect(s.latency).toEqual({ samples: 3, p50Ms: 1200, p90Ms: 2500, maxMs: 2500 });
    const byId = Object.fromEntries(s.coverage.map((c) => [c.id, c]));
    expect(byId.age).toMatchObject({ status: "answered", value: 22, plannedPosition: 1, actualPosition: 1 });
    expect(byId.smoker).toMatchObject({ status: "answered", actualPosition: 2 });
    expect(byId.diagnosed_insomnia).toMatchObject({ status: "answered", actualPosition: 3, plannedPosition: 2 });
    expect(byId.best_contact_time!.status).toBe("not_reached");
    expect(s.outOfOrder).toBe(1);
    expect(s.answered).toBe(3);
    expect(s.identity).toBe("confirmed");
    expect(s.consent).toBe(true);
  });
});

describe("call analysis", () => {
  it("gives the analyst the bot's plan, numbered turns and tool results", () => {
    const prompt = buildAnalysisPrompt(sampleTranscript(), q);
    expect(prompt).toContain("<plan>");
    expect(prompt).toContain("diagnosed_insomnia");
    expect(prompt).toContain("[#6] +17s PERSON:");
    expect(prompt).toContain('(interrupted; the person heard only: "Okay, twenty-two.")');
    expect(prompt).toContain("TOOL record_answer");
    expect(prompt).toContain("error: Screening has not started.");
    // Tool calls sit before the bot turn they were made in.
    const rendered = renderTranscriptForAnalysis(sampleTranscript()).split("\n");
    expect(rendered.findIndex((l) => l.includes("confirm_identity"))).toBeLessThan(rendered.findIndex((l) => l.startsWith("[#1]")));
  });

  it("parses the tool call, clamps and defaults bad fields, drops sentiment on non-person turns", async () => {
    const llm = stubAnalyst();
    const a = await analyzeCall(sampleTranscript(), q, llm);
    expect(llm.calls[0]!.tools.map((t) => t.name)).toEqual(["submit_analysis"]);
    expect(a.adherence.score).toBe(100);
    expect(a.turn_sentiment.map((s) => s.turn)).toEqual([0, 6]);
    expect(a.deviations[1]).toMatchObject({ kind: "off_topic", severity: "low" });
    expect(a.data_quality[0]!.question_id).toBe("diagnosed_insomnia");
  });

  it("falls back to JSON in plain text when the model skips the tool", async () => {
    const llm: LlmAdapter = {
      async run() {
        const text = "Here you go:\n" + JSON.stringify(sampleAnalysisArgs);
        return { steps: [], toolCalls: [], text, aborted: false };
      },
    };
    const a = await analyzeCall(sampleTranscript(), q, llm);
    expect(a.summary).toBe("Jordan completed the screening.");
  });

  it("fails loudly when there is nothing usable", async () => {
    const llm: LlmAdapter = { run: async () => ({ steps: [], toolCalls: [], text: "sorry", aborted: false }) };
    await expect(analyzeCall(sampleTranscript(), q, llm)).rejects.toThrow(/no analysis/);
  });

  it("changes the transcript hash when turns change", () => {
    const a = sampleTranscript();
    const b = sampleTranscript();
    b.turns.push({ role: "person", text: "bye", at: a.endedAt! });
    expect(transcriptHash(a)).not.toBe(transcriptHash(b));
  });
});

describe("overview", () => {
  it("aggregates outcomes, the question funnel, deviations and attention items", () => {
    const analysis = { callSid: "A", model: "m", createdAt: "", transcriptHash: "", analysis: CallAnalysisSchema.parse(sampleAnalysisArgs) };
    const short = sampleTranscript("B");
    short.turns = short.turns.slice(0, 2);
    short.toolCalls = [];
    short.outcome = "hung_up";
    short.eligible = "undetermined";
    const o = buildOverview([bundle("A", sampleTranscript("A"), q, analysis), bundle("B", short, q)], q);
    expect(o.calls).toBe(2);
    expect(o.analyzed).toBe(1);
    expect(o.outcomes).toEqual({ completed: 1, hung_up: 1 });
    const funnel = Object.fromEntries(o.funnel.map((f) => [f.id, f]));
    expect(funnel.age).toEqual({ id: "age", reached: 1, answered: 1 });
    expect(funnel.smoker!.reached).toBe(1);
    expect(o.deviationKinds[0]).toEqual({ kind: "answer_changed", count: 1, high: 1 });
    expect(o.dataConcerns[0]).toMatchObject({ questionId: "diagnosed_insomnia", count: 1 });
    expect(o.attention[0]!.reasons).toEqual(expect.arrayContaining(["1 tool error", "flagged for a human", "1 high-severity deviation", "1 doubtful answer"]));
  });
});
