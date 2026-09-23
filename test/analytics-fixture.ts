import type { LlmAdapter, LlmRunParams } from "../src/conversation/llm.js";
import type { Transcript } from "../src/storage/transcripts.js";

const at = (s: number): string => new Date(Date.UTC(2026, 8, 16, 15, 31, 47) + s * 1000).toISOString();

/** A short version of a real laptop call: an interruption, answers out of order, and a tool error. */
export function sampleTranscript(callSid = "LOCAL-1"): Transcript {
  return {
    callSid,
    contactId: "local",
    phone: "+10000000000",
    startedAt: at(0),
    endedAt: at(60),
    outcome: "completed",
    eligible: "yes",
    turns: [
      { role: "person", text: "Hello?", at: at(2) },
      { role: "assistant", text: "Hi, is this Jordan?", at: at(3) },
      { role: "person", text: "Yeah. That's me.", at: at(7) },
      { role: "assistant", text: "Great. Do you have five minutes? How old are you?", at: at(9) },
      { role: "person", text: "Sure, I'm twenty two.", at: at(14) },
      { role: "assistant", text: "Okay, twenty-two. Has a doctor ever told you that you have insomnia?", at: at(16), interrupted: true, heard: "Okay, twenty-two." },
      { role: "person", text: '[The person interrupted after hearing: "Okay, twenty-two."]\nI had it as a kid, not anymore.', at: at(17) },
      { role: "system", text: "[silence: no reply for 7 seconds; give them a moment]", at: at(30) },
      { role: "assistant", text: "Thanks. Do you smoke?", at: at(33) },
      { role: "person", text: "Never.", at: at(40) },
    ],
    toolCalls: [
      { at: at(3), name: "confirm_identity", args: { result: "confirmed" }, result: { ok: true } },
      { at: at(9), name: "record_consent", args: { proceed: true }, result: { ok: true, next_question: { id: "age" } } },
      { at: at(16), name: "record_answer", args: { question_id: "age", value: 22, verbatim: "I'm twenty two." }, result: { ok: true, next_question: { id: "diagnosed_insomnia" } } },
      { at: at(33), name: "record_answer", args: { question_id: "smoker", value: "never" }, result: { ok: true } },
      { at: at(33), name: "record_answer", args: { question_id: "diagnosed_insomnia", value: true, verbatim: "I had it as a kid" }, result: { ok: true } },
      { at: at(41), name: "record_answer", args: { question_id: "best_contact_time", value: "Thursday" }, result: { ok: false, error: "Screening has not started." } },
      { at: at(41), name: "flag_for_human", args: { note: "tool state error" }, result: { ok: true } },
    ],
    metrics: [
      { promptAt: at(2), firstTokenMs: 800, toolCalls: 0 },
      { promptAt: at(7), firstTokenMs: 1200, toolCalls: 1 },
      { promptAt: at(14), firstTokenMs: 2500, toolCalls: 1 },
      { promptAt: at(30), toolCalls: 0 },
    ],
    relayEvents: [],
    notes: [],
  };
}

export const sampleAnalysisArgs = {
  summary: "Jordan completed the screening.",
  sentiment: { label: "positive", score: 0.4, trajectory: "stable", explanation: "Cooperative throughout." },
  turn_sentiment: [
    { turn: 0, score: 0.1, emotion: "calm" },
    { turn: 1, score: 0.9, emotion: "not a person turn" },
    { turn: 6, score: -0.1, emotion: "hesitant" },
  ],
  deviations: [
    { turn: 6, kind: "answer_changed", severity: "high", description: "Said the insomnia was in the past.", handling: "poor", suggestion: "Ask about the last three months." },
    { turn: 8, kind: "not_a_kind", severity: "extreme", description: "Odd", handling: "well", suggestion: "" },
  ],
  adherence: { score: 140, explanation: "Mostly on plan." },
  bot_quality: { naturalness: 4, empathy: 4, clarity: 5, efficiency: 3, issues: [] },
  data_quality: [{ question_id: "diagnosed_insomnia", confidence: "low", concern: "Past, not current." }],
  engagement: "high",
  ai_suspicion: { detected: false, evidence: "" },
  key_moments: [{ turn: 6, note: "Answer revised" }],
  recommendations: ["Clarify timeframe for insomnia."],
};

/** An analyst model stub that answers with a submit_analysis tool call and records what it was asked. */
export function stubAnalyst(args: unknown = sampleAnalysisArgs): LlmAdapter & { calls: LlmRunParams[] } {
  const calls: LlmRunParams[] = [];
  return {
    calls,
    async run(params) {
      calls.push(params);
      const call = { id: "c1", name: "submit_analysis", args: args as Record<string, unknown> };
      return { steps: [{ type: "function_call", id: "c1", name: call.name, arguments: call.args }], toolCalls: [call], text: "", aborted: false };
    },
  };
}
