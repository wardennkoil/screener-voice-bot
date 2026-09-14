import type { BaseQuestion } from "./schema.js";

export type AnswerValue = boolean | number | string | string[];

export type ValidationResult =
  | { ok: true; value: AnswerValue }
  | { ok: false; error: string };

const YES = new Set(["yes", "y", "true", "yeah", "yep", "correct", "right", "sure", "i do", "i am", "i have"]);
const NO = new Set(["no", "n", "false", "nope", "nah", "i don't", "i do not", "i'm not", "i am not", "i haven't", "never"]);

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

function normalizeChoice(raw: string, options: string[]): string | undefined {
  const needle = raw.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === needle);
}

/**
 * Normalizes a raw value produced by the model into the canonical shape for a
 * question, or explains why it cannot be accepted. Error strings are written
 * for the model: they tell it what to clarify with the person.
 */
export function validateAnswer(question: BaseQuestion, raw: unknown): ValidationResult {
  switch (question.type) {
    case "yes_no": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (YES.has(s)) return { ok: true, value: true };
        if (NO.has(s)) return { ok: true, value: false };
      }
      return fail(`"${question.id}" needs a clear yes or no (true/false). Ask the person to confirm one way or the other.`);
    }

    case "integer":
    case "number": {
      let n: number | undefined;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string") {
        const cleaned = raw.replace(/[^0-9.\-]/g, "");
        if (cleaned.length > 0) n = Number(cleaned);
      }
      if (n === undefined || !Number.isFinite(n)) {
        return fail(`"${question.id}" needs a number${question.unit ? ` in ${question.unit}` : ""}. Ask for a specific figure.`);
      }
      if (question.type === "integer") {
        if (!Number.isInteger(n)) n = Math.round(n);
      }
      const { min, max } = question.valid ?? {};
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        return fail(
          `The value ${n} for "${question.id}" is outside the plausible range (${min ?? "-"} to ${max ?? "-"}${question.unit ? ` ${question.unit}` : ""}). You probably misheard; gently double-check with the person.`,
        );
      }
      return { ok: true, value: n };
    }

    case "single_choice": {
      const options = question.options ?? [];
      if (typeof raw !== "string") return fail(`"${question.id}" must be one of: ${options.join(", ")}.`);
      const match = normalizeChoice(raw, options);
      if (!match) return fail(`"${raw}" is not a valid option for "${question.id}". Map the answer to exactly one of: ${options.join(", ")}, or clarify with the person.`);
      return { ok: true, value: match };
    }

    case "multi_choice": {
      const options = question.options ?? [];
      const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;]/) : [];
      const matched: string[] = [];
      for (const item of items) {
        if (typeof item !== "string") continue;
        const m = normalizeChoice(item, options);
        if (!m) return fail(`"${item}" is not a valid option for "${question.id}". Use only: ${options.join(", ")}.`);
        if (!matched.includes(m)) matched.push(m);
      }
      if (matched.length === 0) return fail(`"${question.id}" needs at least one of: ${options.join(", ")}.`);
      return { ok: true, value: matched };
    }

    case "free_text": {
      if (typeof raw !== "string" || raw.trim().length === 0) return fail(`"${question.id}" needs a short text answer.`);
      return { ok: true, value: raw.trim().replace(/\s+/g, " ") };
    }

    case "date": {
      if (typeof raw !== "string") return fail(`"${question.id}" needs a date in YYYY-MM-DD form.`);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
      if (!m) return fail(`"${raw}" is not a date in YYYY-MM-DD form for "${question.id}". Convert what the person said, or ask for the exact date.`);
      const d = new Date(`${raw.trim()}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw.trim()) {
        return fail(`"${raw}" is not a real calendar date for "${question.id}".`);
      }
      return { ok: true, value: raw.trim() };
    }
  }
}

/** Renders a normalized value for the CSV. */
export function formatAnswerForCsv(value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join("|");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}
