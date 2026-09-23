import { flattenQuestions, type Questionnaire } from "../screening/schema.js";
import type { Transcript } from "../storage/transcripts.js";

/** A transcript turn split into what was said and any bracketed phone-system note glued in front of it. */
export interface DisplayTurn {
  index: number;
  role: "person" | "assistant" | "system";
  text: string;
  at: string;
  /** Seconds since the call started. */
  offsetS: number;
  note?: string;
  heard?: string;
  interrupted?: boolean;
}

export interface QuestionCoverage {
  id: string;
  /** Position in the questionnaire's planned order (1-based). */
  plannedPosition: number;
  /** Position in which the question was first recorded (1-based); later corrections keep it. */
  actualPosition?: number;
  /** Recorded after a question that was planned to come later. */
  outOfOrder: boolean;
  status: "answered" | "skipped" | "not_reached";
  value?: unknown;
  verbatim?: string;
  skipReason?: string;
  followUp: boolean;
  sensitive: boolean;
}

export interface LatencyStats {
  samples: number;
  p50Ms?: number;
  p90Ms?: number;
  maxMs?: number;
}

/** Everything measurable about a call without asking a model. */
export interface CallStats {
  durationS: number;
  personTurns: number;
  assistantTurns: number;
  personWords: number;
  assistantWords: number;
  /** Share of spoken words that were the person's (0-1). */
  personTalkShare: number;
  interruptions: number;
  silenceNudges: number;
  toolCalls: number;
  toolErrors: Array<{ at: string; name: string; error: string }>;
  flags: string[];
  latency: LatencyStats;
  coverage: QuestionCoverage[];
  /** Answers recorded, including optional questions and follow-ups. */
  answered: number;
  /** Required top-level questions answered; pairs with `required`. */
  requiredAnswered: number;
  required: number;
  /** Answers recorded in a different order than planned. */
  outOfOrder: number;
  /** Id of the last question the call reached, useful for drop-off. */
  lastQuestionReached?: string;
  identity?: string;
  consent?: boolean;
}

const NOTE_PREFIX = /^((?:\[[^\]]*\]\s*)+)([\s\S]*)$/;

export function displayTurns(t: Transcript): DisplayTurn[] {
  const start = Date.parse(t.startedAt);
  return t.turns.map((turn, index) => {
    const base: DisplayTurn = { index, role: turn.role, text: turn.text, at: turn.at, offsetS: Math.max(0, Math.round((Date.parse(turn.at) - start) / 100) / 10) };
    if (turn.heard !== undefined) base.heard = turn.heard;
    if (turn.interrupted) base.interrupted = true;
    if (turn.role === "person") {
      const m = NOTE_PREFIX.exec(turn.text);
      if (m && m[2]!.trim()) {
        base.note = m[1]!.trim();
        base.text = m[2]!.trim();
      }
    }
    return base;
  });
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

interface ToolResult {
  ok?: boolean;
  error?: string;
}

export function computeStats(t: Transcript, q: Questionnaire): CallStats {
  const turns = displayTurns(t);
  const person = turns.filter((x) => x.role === "person");
  const assistant = turns.filter((x) => x.role === "assistant");
  // An interrupted assistant turn only counts the words that were actually heard.
  const personWords = person.reduce((n, x) => n + words(x.text), 0);
  const assistantWords = assistant.reduce((n, x) => n + words(x.interrupted ? (x.heard ?? "") : x.text), 0);
  const end = t.endedAt ?? t.turns.at(-1)?.at ?? t.startedAt;

  const firstTokens = t.metrics.map((m) => m.firstTokenMs).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);

  const flat = flattenQuestions(q);
  const coverage = new Map<string, QuestionCoverage>(
    flat.map((x, i) => [x.id, { id: x.id, plannedPosition: i + 1, status: "not_reached", outOfOrder: false, followUp: Boolean(x.parentId), sensitive: x.sensitive }]),
  );
  const toolErrors: CallStats["toolErrors"] = [];
  const flags: string[] = [];
  let identity: string | undefined;
  let consent: boolean | undefined;
  let lastQuestionReached: string | undefined;
  let order = 0;
  for (const call of t.toolCalls) {
    const result = (call.result ?? {}) as ToolResult & { next_question?: { id?: string } };
    const args = (call.args ?? {}) as Record<string, unknown>;
    if (result.ok === false) {
      toolErrors.push({ at: call.at, name: call.name, error: result.error ?? "error" });
      continue;
    }
    if (result.next_question?.id) lastQuestionReached = result.next_question.id;
    switch (call.name) {
      case "confirm_identity":
        identity = String(args.result ?? "");
        break;
      case "record_consent":
        consent = args.proceed === true;
        break;
      case "record_answer":
      case "skip_question": {
        const c = coverage.get(String(args.question_id ?? ""));
        if (!c) break;
        // A correction or an answer after a skip replaces the value but keeps the original position.
        c.actualPosition ??= ++order;
        if (call.name === "record_answer") {
          c.status = "answered";
          c.value = args.value;
          c.verbatim = typeof args.verbatim === "string" ? args.verbatim : undefined;
          c.skipReason = undefined;
        } else {
          c.status = "skipped";
          c.skipReason = String(args.reason ?? "");
        }
        break;
      }
      case "flag_for_human":
        if (typeof args.note === "string") flags.push(args.note);
        break;
    }
  }
  const list = [...coverage.values()];
  const done = list.filter((c) => c.actualPosition !== undefined).sort((a, b) => a.actualPosition! - b.actualPosition!);
  // The longest run recorded in planned order followed the plan; whatever falls outside it was asked out of order.
  // Ties keep the later-planned question, so the one that jumped ahead is the one flagged.
  const runLength = done.map(() => 1);
  const prev = done.map(() => -1);
  let best = -1;
  for (let i = 0; i < done.length; i++) {
    for (let j = 0; j < i; j++) {
      if (done[j]!.plannedPosition < done[i]!.plannedPosition && runLength[j]! + 1 >= runLength[i]!) {
        runLength[i] = runLength[j]! + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || runLength[i]! >= runLength[best]!) best = i;
  }
  const inOrder = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]!) inOrder.add(i);
  done.forEach((c, i) => (c.outOfOrder = !inOrder.has(i)));
  const outOfOrder = done.length - inOrder.size;
  const requiredIds = new Set(flat.filter((x) => x.required && !x.parentId).map((x) => x.id));

  return {
    durationS: Math.max(0, Math.round((Date.parse(end) - Date.parse(t.startedAt)) / 1000)),
    personTurns: person.length,
    assistantTurns: assistant.length,
    personWords,
    assistantWords,
    personTalkShare: personWords + assistantWords ? Math.round((personWords / (personWords + assistantWords)) * 100) / 100 : 0,
    interruptions: assistant.filter((x) => x.interrupted).length,
    silenceNudges: turns.filter((x) => x.role === "system" && /^\[(silence|still no reply|no reply)/i.test(x.text)).length,
    toolCalls: t.toolCalls.length,
    toolErrors,
    flags,
    latency: { samples: firstTokens.length, p50Ms: percentile(firstTokens, 50), p90Ms: percentile(firstTokens, 90), maxMs: firstTokens.at(-1) },
    coverage: list,
    answered: list.filter((c) => c.status === "answered").length,
    requiredAnswered: list.filter((c) => c.status === "answered" && requiredIds.has(c.id)).length,
    required: requiredIds.size,
    outOfOrder,
    lastQuestionReached,
    identity,
    consent,
  };
}
