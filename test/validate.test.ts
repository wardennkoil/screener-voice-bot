import { describe, expect, it } from "vitest";
import { formatAnswerForCsv, validateAnswer } from "../src/screening/validate.js";
import type { BaseQuestion } from "../src/screening/schema.js";

const q = (partial: Partial<BaseQuestion> & Pick<BaseQuestion, "id" | "type">): BaseQuestion => ({ ask: "x", required: true, sensitive: false, ...partial });

describe("validateAnswer", () => {
  it("normalizes yes/no", () => {
    const yn = q({ id: "a", type: "yes_no" });
    expect(validateAnswer(yn, true)).toEqual({ ok: true, value: true });
    expect(validateAnswer(yn, "Nope")).toEqual({ ok: true, value: false });
    expect(validateAnswer(yn, "maybe").ok).toBe(false);
  });

  it("checks numeric plausibility and rounds integers", () => {
    const age = q({ id: "age", type: "integer", valid: { min: 16, max: 110 }, unit: "years" });
    expect(validateAnswer(age, "42")).toEqual({ ok: true, value: 42 });
    expect(validateAnswer(age, 41.6)).toEqual({ ok: true, value: 42 });
    const bad = validateAnswer(age, 7);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/plausible range/);
  });

  it("matches choices case-insensitively and lists options on failure", () => {
    const c = q({ id: "s", type: "single_choice", options: ["never", "former", "current"] });
    expect(validateAnswer(c, "Former")).toEqual({ ok: true, value: "former" });
    const bad = validateAnswer(c, "sometimes");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/never, former, current/);
    const m = q({ id: "m", type: "multi_choice", options: ["a", "b", "c"] });
    expect(validateAnswer(m, "A, c")).toEqual({ ok: true, value: ["a", "c"] });
  });

  it("validates dates and free text", () => {
    expect(validateAnswer(q({ id: "d", type: "date" }), "2026-02-30").ok).toBe(false);
    expect(validateAnswer(q({ id: "d", type: "date" }), "2026-02-28")).toEqual({ ok: true, value: "2026-02-28" });
    expect(validateAnswer(q({ id: "t", type: "free_text" }), "  mornings   work best ")).toEqual({ ok: true, value: "mornings work best" });
    expect(validateAnswer(q({ id: "t", type: "free_text" }), "   ").ok).toBe(false);
  });

  it("formats values for CSV", () => {
    expect(formatAnswerForCsv(true)).toBe("yes");
    expect(formatAnswerForCsv(["a", "b"])).toBe("a|b");
    expect(formatAnswerForCsv(undefined)).toBe("");
  });
});
