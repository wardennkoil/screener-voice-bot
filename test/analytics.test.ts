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
    expect(byId.age).toMatchObject({ status: "answered", value: 22, plannedPosition: 1, actualPosition: 1, outOfOrder: false });
    // Smoker jumped ahead of insomnia; insomnia itself came in its planned place relative to age.
    expect(byId.smoker).toMatchObject({ status: "answered", actualPosition: 2, outOfOrder: true });
    expect(byId.diagnosed_insomnia).toMatchObject({ status: "answered", actualPosition: 3, plannedPosition: 2, outOfOrder: false });
    expect(byId.best_contact_time!.status).toBe("not_reached");
    expect(s.outOfOrder).toBe(1);
    expect(s.answered).toBe(3);
    expect(s.requiredAnswered).toBe(3);
    expect(s.identity).toBe("confirmed");
    expect(s.consent).toBe(true);
  });
});

describe("question order", () => {
  const record = (question_id: string, value: unknown, verbatim?: string, at = "2026-09-16T15:32:00.000Z") => ({ at, name: "record_answer", args: { question_id, value, ...(verbatim ? { verbatim } : {}) }, result: { ok: true } });

  it("does not flag questions after an inapplicable follow-up as reordered", () => {
    const t = sampleTranscript();
    t.toolCalls = [record("age", 30), record("diagnosed_insomnia", true), record("sleep_medication", false), record("pregnant_or_nursing", false), record("can_attend_visits", true)];
    const s = computeStats(t, q);
    expect(s.outOfOrder).toBe(0);
    expect(s.coverage.filter((c) => c.outOfOrder)).toEqual([]);
  });

  it("keeps a corrected answer in its original position with the new words", () => {
    const t = sampleTranscript();
    t.toolCalls = [record("age", 30, "thirty"), record("diagnosed_insomnia", true), record("age", 31)];
    const s = computeStats(t, q);
    const age = s.coverage.find((c) => c.id === "age")!;
    expect(age).toMatchObject({ value: 31, actualPosition: 1, outOfOrder: false });
    expect(age.verbatim).toBeUndefined();
    expect(s.outOfOrder).toBe(0);
  });

  it("counts only required questions against the required total", () => {
    const t = sampleTranscript();
    t.toolCalls = [record("age", 30), record("sleep_medication", true), record("sleep_medication_name", "melatonin"), record("best_contact_time", "evenings")];
    const s = computeStats(t, q);
    expect(s.answered).toBe(4);
    expect(s.requiredAnswered).toBe(2);
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
    expect(a.deviations[1]).toMatchObject({ kind: "other", severity: "low" });
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

  it("describes the recording notice in the plan when calls are recorded", () => {
    expect(buildAnalysisPrompt(sampleTranscript(), q, { recordingEnabled: true })).toContain("that the call is recorded for quality");
    expect(buildAnalysisPrompt(sampleTranscript(), q)).not.toContain("that the call is recorded for quality");
  });

  it("rejects an empty or cut-off tool call instead of saving a blank analysis", async () => {
    await expect(analyzeCall(sampleTranscript(), q, stubAnalyst({}))).rejects.toThrow(/incomplete analysis/);
    await expect(analyzeCall(sampleTranscript(), q, stubAnalyst({ summary: "  ", sentiment: {} }))).rejects.toThrow(/incomplete analysis/);
  });

  it("files unknown deviation kinds under other", async () => {
    const a = await analyzeCall(sampleTranscript(), q, stubAnalyst());
    expect(a.deviations[1]!.kind).toBe("other");
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
    // The medication follow-up never applied, so it is not counted as reached (no fake drop-off).
    expect(funnel.sleep_medication_name!.reached).toBe(0);
    expect(o.deviationKinds[0]).toEqual({ kind: "answer_changed", count: 1, high: 1 });
    expect(o.dataConcerns[0]).toMatchObject({ questionId: "diagnosed_insomnia", count: 1 });
    expect(o.attention[0]!.reasons).toEqual(expect.arrayContaining(["1 tool error", "flagged for a human", "1 high-severity deviation", "1 doubtful answer"]));
  });
});

describe("questions asked only when someone is ruled out", () => {
  const qx = sampleQuestionnaire();
  qx.questions.push({ id: "open_to_other_studies", type: "yes_no", ask: "Whether they want to hear about other studies", ask_when: "ineligible", required: true, sensitive: false });
  const answer = (question_id: string, value: unknown) => ({ at: "2026-09-16T15:32:00.000Z", name: "record_answer", args: { question_id, value }, result: { ok: true } });

  it("do not count as required and only show in the funnel when actually asked", () => {
    const ruledOut = { ...sampleTranscript("X"), toolCalls: [answer("age", 80), answer("open_to_other_studies", true)] };
    const s = computeStats(ruledOut, qx);
    expect(s.required).toBe(computeStats(sampleTranscript(), q).required);
    expect(s.requiredAnswered).toBe(1);
    expect(s.coverage.find((c) => c.id === "open_to_other_studies")).toMatchObject({ whenIneligible: true, status: "answered", outOfOrder: false });

    const qualified = { ...sampleTranscript("Y"), toolCalls: [answer("age", 40), answer("diagnosed_insomnia", true)] };
    const funnel = Object.fromEntries(buildOverview([bundle("X", ruledOut, qx), bundle("Y", qualified, qx)], qx).funnel.map((f) => [f.id, f.reached]));
    // Asking it at the end of the ruled-out call does not make that call look like it got through every question.
    expect(funnel).toMatchObject({ age: 2, diagnosed_insomnia: 1, sleep_medication: 0, open_to_other_studies: 1 });
  });
});
