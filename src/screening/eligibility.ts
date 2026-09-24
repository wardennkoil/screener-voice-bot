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

/** Body mass index from the configured height (inches) and weight (pounds) answers, to one decimal; undefined until both are known. */
export function computeBmi(questionnaire: Questionnaire, answers: ReadonlyMap<string, AnswerValue>): number | undefined {
  const cfg = questionnaire.bmi;
  if (!cfg) return undefined;
  const inches = answers.get(cfg.height_question);
  const pounds = answers.get(cfg.weight_question);
  if (typeof inches !== "number" || typeof pounds !== "number" || inches <= 0) return undefined;
  return Math.round(((703 * pounds) / (inches * inches)) * 10) / 10;
}

/** "pass", "fail", or "missing" (not decidable yet: a height/weight or condition answer is still to come). */
function bmiVerdict(questionnaire: Questionnaire, answers: ReadonlyMap<string, AnswerValue>): "pass" | "fail" | "missing" {
  const cfg = questionnaire.bmi!;
  const bmi = computeBmi(questionnaire, answers);
  if (bmi === undefined) return "missing";
  if (bmi >= cfg.min) return "pass";
  if (cfg.min_with_condition === undefined || bmi < cfg.min_with_condition) return "fail";
  const conditions = cfg.condition_questions.map((id) => answers.get(id));
  if (conditions.some((v) => v === true)) return "pass";
  // Only a full set of "no" answers rules them out; otherwise wait for the rest.
  return conditions.every((v) => v === false) ? "fail" : "missing";
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
  if (questionnaire.bmi) {
    const verdict = bmiVerdict(questionnaire, answers);
    if (verdict === "fail") failed.push("bmi");
    else if (verdict === "missing") missing.push("bmi");
  }
  if (failed.length > 0) return { status: "ineligible", failed, missing };
  if (missing.length > 0) return { status: "undetermined", failed, missing };
  return { status: "eligible", failed, missing };
}
