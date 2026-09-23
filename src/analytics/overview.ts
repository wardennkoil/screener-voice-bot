import { flattenQuestions, type Questionnaire } from "../screening/schema.js";
import type { Transcript } from "../storage/transcripts.js";
import { transcriptHash, type StoredAnalysis } from "./analyze.js";
import { computeStats, displayTurns, type CallStats } from "./stats.js";

export interface CallSummary {
  sid: string;
  startedAt: string;
  durationS: number;
  outcome: string;
  eligible: string;
  answered: number;
  required: number;
  interruptions: number;
  toolErrors: number;
  firstPersonLine?: string;
  analysis?: {
    stale: boolean;
    sentimentLabel: string;
    sentimentScore: number;
    deviations: number;
    highSeverity: number;
    adherence: number;
    dataConcerns: number;
    summary: string;
  };
}

export interface AttentionItem {
  sid: string;
  startedAt: string;
  reasons: string[];
}

export interface Overview {
  calls: number;
  analyzed: number;
  outcomes: Record<string, number>;
  eligible: Record<string, number>;
  avgDurationS: number;
  medianLatencyMs?: number;
  avgAnswered: number;
  required: number;
  avgSentiment?: number;
  sentimentLabels: Record<string, number>;
  avgAdherence?: number;
  /** Per planned question: how many calls reached it and how many recorded an answer. */
  funnel: Array<{ id: string; reached: number; answered: number }>;
  deviationKinds: Array<{ kind: string; count: number; high: number }>;
  dataConcerns: Array<{ questionId: string; count: number; examples: Array<{ sid: string; concern: string }> }>;
  recommendations: Array<{ sid: string; text: string }>;
  attention: AttentionItem[];
}

export interface CallBundle {
  sid: string;
  transcript: Transcript;
  stats: CallStats;
  analysis?: StoredAnalysis;
}

export function bundle(sid: string, t: Transcript, q: Questionnaire, analysis?: StoredAnalysis): CallBundle {
  return { sid, transcript: t, stats: computeStats(t, q), analysis };
}

export function summarize(b: CallBundle): CallSummary {
  const { transcript: t, stats: s, analysis } = b;
  const firstPerson = displayTurns(t).find((x) => x.role === "person")?.text;
  const out: CallSummary = {
    sid: b.sid,
    startedAt: t.startedAt,
    durationS: s.durationS,
    outcome: t.outcome ?? "unknown",
    eligible: t.eligible ?? "undetermined",
    answered: s.requiredAnswered,
    required: s.required,
    interruptions: s.interruptions,
    toolErrors: s.toolErrors.length,
    firstPersonLine: firstPerson?.slice(0, 80),
  };
  if (analysis) {
    const a = analysis.analysis;
    out.analysis = {
      stale: analysis.transcriptHash !== transcriptHash(t),
      sentimentLabel: a.sentiment.label,
      sentimentScore: a.sentiment.score,
      deviations: a.deviations.length,
      highSeverity: a.deviations.filter((d) => d.severity === "high").length,
      adherence: a.adherence.score,
      dataConcerns: a.data_quality.filter((d) => d.confidence !== "high").length,
      summary: a.summary,
    };
  }
  return out;
}

const count = (rec: Record<string, number>, key: string): void => {
  rec[key] = (rec[key] ?? 0) + 1;
};

const mean = (xs: number[]): number | undefined => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : undefined);

export function buildOverview(bundles: CallBundle[], q: Questionnaire): Overview {
  const outcomes: Record<string, number> = {};
  const eligible: Record<string, number> = {};
  const sentimentLabels: Record<string, number> = {};
  const planned = flattenQuestions(q);
  const plannedIndex = new Map(planned.map((x, i) => [x.id, i]));
  const funnel = planned.map((x) => ({ id: x.id, reached: 0, answered: 0 }));
  const kinds = new Map<string, { count: number; high: number }>();
  const concerns = new Map<string, Array<{ sid: string; concern: string }>>();
  const recommendations: Overview["recommendations"] = [];
  const attention: AttentionItem[] = [];
  const latencies: number[] = [];
  const sentiments: number[] = [];
  const adherence: number[] = [];
  let analyzed = 0;

  for (const b of bundles) {
    const { transcript: t, stats: s } = b;
    count(outcomes, t.outcome ?? "unknown");
    count(eligible, t.eligible ?? "undetermined");
    if (s.latency.p50Ms !== undefined) latencies.push(s.latency.p50Ms);

    // A question counts as reached when it was answered/skipped or was the next one the call was on.
    let furthest = -1;
    for (const c of s.coverage) {
      const i = plannedIndex.get(c.id)!;
      if (c.status !== "not_reached") {
        furthest = Math.max(furthest, i);
        if (c.status === "answered") funnel[i]!.answered++;
      }
    }
    if (s.lastQuestionReached !== undefined) furthest = Math.max(furthest, plannedIndex.get(s.lastQuestionReached) ?? -1);
    const coverage = new Map(s.coverage.map((c) => [c.id, c]));
    for (let i = 0; i <= furthest; i++) {
      // A conditional follow-up the call passed without touching simply did not apply; it is not a drop-off.
      const id = planned[i]!.id;
      if (planned[i]!.parentId && coverage.get(id)?.status === "not_reached" && s.lastQuestionReached !== id) continue;
      funnel[i]!.reached++;
    }

    const reasons: string[] = [];
    if (s.toolErrors.length) reasons.push(`${s.toolErrors.length} tool error${s.toolErrors.length > 1 ? "s" : ""}`);
    if (s.flags.length) reasons.push("flagged for a human");

    if (b.analysis) {
      analyzed++;
      const a = b.analysis.analysis;
      sentiments.push(a.sentiment.score);
      count(sentimentLabels, a.sentiment.label);
      adherence.push(a.adherence.score);
      for (const d of a.deviations) {
        const k = kinds.get(d.kind) ?? { count: 0, high: 0 };
        k.count++;
        if (d.severity === "high") k.high++;
        kinds.set(d.kind, k);
      }
      for (const d of a.data_quality) {
        if (d.confidence === "high") continue;
        const list = concerns.get(d.question_id) ?? [];
        list.push({ sid: b.sid, concern: d.concern });
        concerns.set(d.question_id, list);
      }
      for (const r of a.recommendations.slice(0, 3)) recommendations.push({ sid: b.sid, text: r });
      const high = a.deviations.filter((d) => d.severity === "high").length;
      if (high) reasons.push(`${high} high-severity deviation${high > 1 ? "s" : ""}`);
      const lowConf = a.data_quality.filter((d) => d.confidence === "low").length;
      if (lowConf) reasons.push(`${lowConf} doubtful answer${lowConf > 1 ? "s" : ""}`);
      if (a.sentiment.label === "negative") reasons.push("negative sentiment");
    }
    if (reasons.length) attention.push({ sid: b.sid, startedAt: t.startedAt, reasons });
  }

  const sortedLat = latencies.sort((a, b) => a - b);
  return {
    calls: bundles.length,
    analyzed,
    outcomes,
    eligible,
    avgDurationS: Math.round(mean(bundles.map((b) => b.stats.durationS)) ?? 0),
    medianLatencyMs: sortedLat.length ? sortedLat[Math.floor(sortedLat.length / 2)] : undefined,
    avgAnswered: mean(bundles.map((b) => b.stats.requiredAnswered)) ?? 0,
    required: bundles[0]?.stats.required ?? planned.filter((x) => x.required && !x.parentId).length,
    avgSentiment: mean(sentiments),
    sentimentLabels,
    avgAdherence: adherence.length ? Math.round(mean(adherence)!) : undefined,
    funnel,
    deviationKinds: [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.count - a.count),
    dataConcerns: [...concerns.entries()]
      .map(([questionId, examples]) => ({ questionId, count: examples.length, examples: examples.slice(0, 5) }))
      .sort((a, b) => b.count - a.count),
    recommendations: recommendations.slice(0, 30),
    attention: attention.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  };
}
