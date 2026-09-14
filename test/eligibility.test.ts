import { describe, expect, it } from "vitest";
import { evaluateEligibility, ruleMatches } from "../src/screening/eligibility.js";
import { sampleQuestionnaire } from "./helpers.js";

describe("ruleMatches", () => {
  it("evaluates every condition", () => {
    expect(ruleMatches({ min: 18, max: 65 }, 42)).toBe(true);
    expect(ruleMatches({ min: 18, max: 65 }, 70)).toBe(false);
    expect(ruleMatches({ equals: true }, true)).toBe(true);
    expect(ruleMatches({ equals: false }, undefined)).toBe(false);
    expect(ruleMatches({ in: ["a", "b"] }, "b")).toBe(true);
    expect(ruleMatches({ in: ["a", "b"] }, ["c", "a"])).toBe(true);
    expect(ruleMatches({ not_in: ["a"] }, ["c", "a"])).toBe(false);
  });
});

describe("evaluateEligibility", () => {
  const q = sampleQuestionnaire();
  const good = new Map<string, boolean | number | string>([
    ["age", 40],
    ["diagnosed_insomnia", true],
    ["sleep_medication", false],
    ["pregnant_or_nursing", false],
    ["can_attend_visits", true],
  ]);

  it("is eligible when every rule passes", () => {
    expect(evaluateEligibility(q, good)).toEqual({ status: "eligible", failed: [], missing: [] });
  });

  it("is ineligible as soon as one rule fails, even with gaps", () => {
    const m = new Map(good);
    m.set("age", 70);
    m.delete("can_attend_visits");
    const r = evaluateEligibility(q, m);
    expect(r.status).toBe("ineligible");
    expect(r.failed).toEqual(["age"]);
    expect(r.missing).toEqual(["can_attend_visits"]);
  });

  it("is undetermined while rule-bearing questions are unanswered", () => {
    const m = new Map(good);
    m.delete("pregnant_or_nursing");
    expect(evaluateEligibility(q, m).status).toBe("undetermined");
  });

  it("ignores follow-ups that do not apply", () => {
    expect(evaluateEligibility(q, good).missing).not.toContain("sleep_medication_name");
  });
});
