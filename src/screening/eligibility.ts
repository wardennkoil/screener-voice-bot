import type { FlatQuestion, Questionnaire, Rule } from "./schema.js";
import { flattenQuestions } from "./schema.js";
import type { AnswerValue } from "./validate.js";

/** Every condition in a rule must hold. */
export function ruleMatches(rule: Rule, value: AnswerValue | undefined): boolean {
  if (value === undefined) return false;
  const values = Array.isArray(value) ? value : [value];
  const asNumber = typeof value === "number" ? value : undefined;

  if (rule.equals !== undefined) {
    if (Array.isArray(value)) {
      if (!values.some((v) => v === rule.equals)) return false;
    } else if (value !== rule.equals) return false;
  }
  if (rule.not_equals !== undefined) {
    if (Array.isArray(value)) {
      if (values.some((v) => v === rule.not_equals)) return false;
    } else if (value === rule.not_equals) return false;
  }
  if (rule.in !== undefined) {
    if (!values.some((v) => typeof v === "string" && rule.in!.includes(v))) return false;
  }
  if (rule.not_in !== undefined) {
    if (values.some((v) => typeof v === "string" && rule.not_in!.includes(v))) return false;
  }
  if (rule.min !== undefined) {
    if (asNumber === undefined || asNumber < rule.min) return false;
  }
  if (rule.max !== undefined) {
    if (asNumber === undefined || asNumber > rule.max) return false;
  }
  return true;
}

export type EligibilityStatus = "eligible" | "ineligible" | "undetermined";

export interface EligibilityResult {
  status: EligibilityStatus;
  /** Ids of questions whose rule failed. */
  failed: string[];
  /** Ids of rule-bearing, applicable questions that have no answer yet. */
  missing: string[];
}

/** Whether a question applies given the answers so far (follow-ups depend on their parent). */
export function isApplicable(q: FlatQuestion, answers: ReadonlyMap<string, AnswerValue>): boolean {
  if (!q.parentId || !q.parentRule) return true;
  return ruleMatches(q.parentRule, answers.get(q.parentId));
}

export function evaluateEligibility(
  questionnaire: Questionnaire,
  answers: ReadonlyMap<string, AnswerValue>,
  skipped: ReadonlySet<string> = new Set(),
): EligibilityResult {
  const failed: string[] = [];
  const missing: string[] = [];
  for (const q of flattenQuestions(questionnaire)) {
    if (!q.eligible_if || !isApplicable(q, answers)) continue;
    const value = answers.get(q.id);
    if (value === undefined) {
      // A skipped rule-bearing question can never be confirmed eligible.
      missing.push(q.id);
      continue;
    }
    if (!ruleMatches(q.eligible_if, value)) failed.push(q.id);
  }
  void skipped;
  if (failed.length > 0) return { status: "ineligible", failed, missing };
  if (missing.length > 0) return { status: "undetermined", failed, missing };
  return { status: "eligible", failed, missing };
}
