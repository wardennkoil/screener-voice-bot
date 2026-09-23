import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmAdapter } from "../conversation/llm.js";
import { userStep } from "../conversation/llm.js";
import { buildSystemPrompt } from "../conversation/prompt.js";
import type { FunctionToolDecl } from "../conversation/tools.js";
import type { Questionnaire } from "../screening/schema.js";
import type { Transcript } from "../storage/transcripts.js";
import { computeStats, displayTurns, type CallStats } from "./stats.js";

export const DEVIATION_KINDS = [
  "person_question",
  "off_topic",
  "confusion",
  "hesitation_or_objection",
  "answer_changed",
  "bot_off_script",
  "bot_reordered_or_skipped",
  "bot_error",
  "technical_issue",
  "other",
] as const;

const score = (min: number, max: number) => z.coerce.number().transform((v) => Math.min(max, Math.max(min, v)));
const oneOf = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) => z.enum(values).catch(fallback);

/** What the model returns. Lenient on purpose: a slightly off field degrades to a default instead of losing the analysis. */
export const CallAnalysisSchema = z.object({
  summary: z.string().catch(""),
  sentiment: z
    .object({
      label: oneOf(["positive", "neutral", "negative", "mixed"], "neutral"),
      score: score(-1, 1).catch(0),
      trajectory: oneOf(["improving", "stable", "declining", "mixed"], "stable"),
      explanation: z.string().catch(""),
    })
    .catch({ label: "neutral", score: 0, trajectory: "stable", explanation: "" }),
  turn_sentiment: z
    .array(z.object({ turn: z.coerce.number().int(), score: score(-1, 1), emotion: z.string().catch("") }).catch({ turn: -1, score: 0, emotion: "" }))
    .catch([]),
  deviations: z
    .array(
      z.object({
        turn: z.coerce.number().int().catch(-1),
        kind: oneOf(DEVIATION_KINDS, "other"),
        severity: oneOf(["low", "medium", "high"], "low"),
        description: z.string().catch(""),
        handling: oneOf(["well", "adequate", "poor"], "adequate"),
        suggestion: z.string().catch(""),
      }),
    )
    .catch([]),
  adherence: z.object({ score: score(0, 100).catch(0), explanation: z.string().catch("") }).catch({ score: 0, explanation: "" }),
  bot_quality: z
    .object({
      naturalness: score(1, 5).catch(3),
      empathy: score(1, 5).catch(3),
      clarity: score(1, 5).catch(3),
      efficiency: score(1, 5).catch(3),
      issues: z.array(z.object({ turn: z.coerce.number().int().catch(-1), issue: z.string().catch("") })).catch([]),
    })
    .catch({ naturalness: 3, empathy: 3, clarity: 3, efficiency: 3, issues: [] }),
  data_quality: z
    .array(
      z.object({
        question_id: z.string().catch(""),
        confidence: oneOf(["high", "medium", "low"], "medium"),
        concern: z.string().catch(""),
      }),
    )
    .catch([]),
  engagement: oneOf(["high", "medium", "low"], "medium"),
  ai_suspicion: z.object({ detected: z.boolean().catch(false), evidence: z.string().catch("") }).catch({ detected: false, evidence: "" }),
  key_moments: z.array(z.object({ turn: z.coerce.number().int().catch(-1), note: z.string().catch("") })).catch([]),
  recommendations: z.array(z.string()).catch([]),
});
export type CallAnalysis = z.infer<typeof CallAnalysisSchema>;

export interface StoredAnalysis {
  callSid: string;
  model: string;
  createdAt: string;
  /** Hash of the transcript the analysis was made from; a changed transcript makes it stale. */
  transcriptHash: string;
  analysis: CallAnalysis;
}

const turnRef = { type: "integer", description: "Turn number from the transcript, e.g. 7 for [#7]." };

export const SUBMIT_ANALYSIS_TOOL: FunctionToolDecl = {
  type: "function",
  name: "submit_analysis",
  description: "Submit the finished analysis of the call. Call it exactly once.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Three to five sentences: what happened, how it ended, anything the study team must know." },
      sentiment: {
        type: "object",
        description: "The person's overall sentiment across the call (not the bot's).",
        properties: {
          label: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },
          score: { type: "number", description: "-1 very negative to 1 very positive" },
          trajectory: { type: "string", enum: ["improving", "stable", "declining", "mixed"] },
          explanation: { type: "string" },
        },
        required: ["label", "score", "trajectory", "explanation"],
      },
      turn_sentiment: {
        type: "array",
        description: "One entry for EVERY PERSON turn, in order.",
        items: {
          type: "object",
          properties: { turn: turnRef, score: { type: "number", description: "-1 to 1" }, emotion: { type: "string", description: "One word, e.g. calm, engaged, hesitant, confused, annoyed, anxious, amused, rushed" } },
          required: ["turn", "score", "emotion"],
        },
      },
      deviations: {
        type: "array",
        description: "Every moment the conversation departed from the planned flow, by either side. Empty if none.",
        items: {
          type: "object",
          properties: {
            turn: turnRef,
            kind: {
              type: "string",
              enum: [...DEVIATION_KINDS],
              description:
                "person_question: the person asked something; off_topic: tangent; confusion: misunderstood the question; hesitation_or_objection: reluctance, privacy worry, pushback; answer_changed: contradicted or revised an earlier answer; bot_off_script: the bot said something the plan does not allow (medical advice, hinting eligibility, inventing facts); bot_reordered_or_skipped: asked out of order, skipped or merged questions; bot_error: wrong recording, repeated itself, ignored what was said; technical_issue: tool errors, cut-offs, long silences caused by the system; other: anything else that departs from the plan.",
            },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            description: { type: "string", description: "What happened, one or two sentences, quoting briefly." },
            handling: { type: "string", enum: ["well", "adequate", "poor"], description: "How well the bot handled it." },
            suggestion: { type: "string", description: "Concrete change to the prompt, questionnaire, or system that would help. Empty if handled well." },
          },
          required: ["turn", "kind", "severity", "description", "handling", "suggestion"],
        },
      },
      adherence: {
        type: "object",
        description: "How closely the call followed the plan (0-100), counting only the bot's own choices; the person steering elsewhere is not the bot's fault if it steered back well.",
        properties: { score: { type: "number" }, explanation: { type: "string" } },
        required: ["score", "explanation"],
      },
      bot_quality: {
        type: "object",
        description: "Rate the bot 1-5 on each axis, as a demanding call-center QA reviewer would.",
        properties: {
          naturalness: { type: "number" },
          empathy: { type: "number" },
          clarity: { type: "number" },
          efficiency: { type: "number" },
          issues: { type: "array", items: { type: "object", properties: { turn: turnRef, issue: { type: "string" } }, required: ["turn", "issue"] } },
        },
        required: ["naturalness", "empathy", "clarity", "efficiency", "issues"],
      },
      data_quality: {
        type: "array",
        description: "One entry per recorded answer whose value may not faithfully reflect what the person said (ambiguous, contradicted, past vs present, hedged). Omit answers that are clearly right.",
        items: {
          type: "object",
          properties: { question_id: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, concern: { type: "string" } },
          required: ["question_id", "confidence", "concern"],
        },
      },
      engagement: { type: "string", enum: ["high", "medium", "low"] },
      ai_suspicion: {
        type: "object",
        description: "Did the person seem to notice or ask whether they were talking to a machine?",
        properties: { detected: { type: "boolean" }, evidence: { type: "string" } },
        required: ["detected", "evidence"],
      },
      key_moments: { type: "array", description: "Up to five turns worth jumping to.", items: { type: "object", properties: { turn: turnRef, note: { type: "string" } }, required: ["turn", "note"] } },
      recommendations: { type: "array", description: "Up to five prioritized, concrete improvements for the script, prompt, or system.", items: { type: "string" } },
    },
    required: ["summary", "sentiment", "turn_sentiment", "deviations", "adherence", "bot_quality", "data_quality", "engagement", "ai_suspicion", "key_moments", "recommendations"],
  },
};

const ANALYST_SYSTEM = `You are a senior QA analyst for a clinical-trial recruitment call center. You review transcripts of phone screening calls made by an automated voice agent and write precise, evidence-based assessments for the study team.

Rules:
- Base every claim on the transcript; refer to turns by their number.
- Sentiment is always the PERSON's, not the bot's. Speech-to-text artifacts ("uh", missing punctuation) are not negative sentiment.
- Lines marked SYSTEM are phone-system notes to the bot (silence timers, call connected). TOOL lines show what the bot recorded and what the server replied; an "error" there is a real system error.
- A "deviation" is any departure from the planned flow described in the plan below. Normal acknowledgments and natural rephrasing are not deviations.
- Pay special attention to recorded answers that do not match what the person actually said.
- Be concise and specific. Call submit_analysis once with the result; do not reply with text.`;

/** JSON with object keys sorted at every level, so a Postgres jsonb round trip (which reorders keys) hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function transcriptHash(t: Transcript): string {
  return createHash("sha256").update(canonicalJson({ turns: t.turns, toolCalls: t.toolCalls })).digest("hex").slice(0, 16);
}

/** The hash analyses saved before canonical hashing used (key order as written to the file). */
function legacyTranscriptHash(t: Transcript): string {
  return createHash("sha256").update(JSON.stringify({ turns: t.turns, toolCalls: t.toolCalls })).digest("hex").slice(0, 16);
}

/** Whether a stored analysis was made from this exact transcript (the only staleness rule; use it everywhere). */
export function isAnalysisCurrent(stored: Pick<StoredAnalysis, "transcriptHash">, t: Transcript): boolean {
  return stored.transcriptHash === transcriptHash(t) || stored.transcriptHash === legacyTranscriptHash(t);
}

function short(value: unknown, max = 220): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Numbered transcript with tool calls interleaved by time, as the analyst model reads it. */
export function renderTranscriptForAnalysis(t: Transcript): string {
  const turns = displayTurns(t);
  const tools = [...t.toolCalls];
  const lines: string[] = [];
  const flushToolsBefore = (at: string | undefined): void => {
    while (tools.length && (at === undefined || tools[0]!.at <= at)) {
      const c = tools.shift()!;
      const r = (c.result ?? {}) as { ok?: boolean; error?: string; message?: string };
      const outcome = r.ok === false ? `error: ${short(r.error)}` : `ok${r.message ? `: ${short(r.message, 120)}` : ""}`;
      lines.push(`      TOOL ${c.name}(${short(c.args, 200)}) -> ${outcome}`);
    }
  };
  for (const turn of turns) {
    flushToolsBefore(turn.at);
    const who = turn.role === "person" ? "PERSON" : turn.role === "assistant" ? "BOT" : "SYSTEM";
    const note = turn.note ? ` ${turn.note}` : "";
    const cut = turn.interrupted ? ` (interrupted; the person heard only: "${turn.heard ?? ""}")` : "";
    lines.push(`[#${turn.index}] +${turn.offsetS}s ${who}:${note} ${turn.text}${cut}`);
  }
  flushToolsBefore(undefined);
  return lines.join("\n");
}

function statsDigest(s: CallStats): string {
  return [
    `duration ${s.durationS}s; person turns ${s.personTurns}; bot turns ${s.assistantTurns}; person share of words ${Math.round(s.personTalkShare * 100)}%`,
    `interruptions ${s.interruptions}; silence nudges ${s.silenceNudges}; tool errors ${s.toolErrors.length}; answers recorded out of planned order ${s.outOfOrder}`,
    `reply latency (first token) p50 ${s.latency.p50Ms ?? "-"}ms, p90 ${s.latency.p90Ms ?? "-"}ms`,
    `questions: ${s.coverage.map((c) => `${c.id}=${c.status === "answered" ? JSON.stringify(c.value) : c.status}`).join(", ")}`,
  ].join("\n");
}

export interface AnalyzeOptions {
  /** Whether calls were made with RECORD_CALLS on; the bot's plan then includes the recording notice. */
  recordingEnabled?: boolean;
  signal?: AbortSignal;
}

export function buildAnalysisPrompt(t: Transcript, q: Questionnaire, opts: AnalyzeOptions = {}): string {
  const plan = buildSystemPrompt(q, { firstName: "the person", recordingEnabled: opts.recordingEnabled ?? false });
  return `# The plan (the exact instructions the bot was given)
<plan>
${plan}
</plan>

# Measured facts
${statsDigest(computeStats(t, q))}
Final outcome: ${t.outcome ?? "unknown"}; eligible: ${t.eligible ?? "unknown"}${t.notes.length ? `; notes: ${t.notes.join(" | ")}` : ""}

# Transcript
${renderTranscriptForAnalysis(t)}

Analyze this call and call submit_analysis.`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Runs the analyst model over one transcript. Throws when the model returns nothing usable. */
export async function analyzeCall(t: Transcript, q: Questionnaire, llm: LlmAdapter, opts: AnalyzeOptions = {}): Promise<CallAnalysis> {
  const result = await llm.run(
    { system: ANALYST_SYSTEM, history: [userStep(buildAnalysisPrompt(t, q, opts))], tools: [SUBMIT_ANALYSIS_TOOL], signal: opts.signal ?? new AbortController().signal },
    { onText: () => {} },
  );
  const raw = result.toolCalls.find((c) => c.name === SUBMIT_ANALYSIS_TOOL.name)?.args ?? extractJson(result.text);
  if (!raw || typeof raw !== "object") throw new Error(`The analysis model returned no analysis${result.text ? `: ${result.text.slice(0, 200)}` : ""}`);
  // Every field has a lenient fallback, so an empty or cut-off tool call would otherwise parse as a blank "analysis".
  const { summary, sentiment } = raw as { summary?: unknown; sentiment?: unknown };
  if (typeof summary !== "string" || !summary.trim() || !sentiment || typeof sentiment !== "object") {
    throw new Error("The analysis model returned an incomplete analysis (output cut off or malformed); re-analyze to retry");
  }
  const parsed = CallAnalysisSchema.parse(raw);
  const personTurns = new Set(t.turns.flatMap((turn, i) => (turn.role === "person" ? [i] : [])));
  parsed.turn_sentiment = parsed.turn_sentiment.filter((s) => personTurns.has(s.turn)).sort((a, b) => a.turn - b.turn);
  return parsed;
}
