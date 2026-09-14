import { describe, expect, it } from "vitest";
import { parseQuestionnaire } from "../src/screening/loader.js";
import { flattenQuestions } from "../src/screening/schema.js";
import { sampleQuestionnaire } from "./helpers.js";

describe("questionnaire schema", () => {
  it("loads the sample questionnaire and flattens follow-ups in order", () => {
    const q = sampleQuestionnaire();
    const ids = flattenQuestions(q).map((x) => x.id);
    expect(ids).toEqual(["age", "diagnosed_insomnia", "sleep_medication", "sleep_medication_name", "pregnant_or_nursing", "can_attend_visits", "smoker", "best_contact_time"]);
    expect(q.settings.stop_on_disqualify).toBe(false);
  });

  it("rejects duplicate ids and choice questions without options", () => {
    const base = `
study: {name: s, organization: o, description_short: d, callback_number_spoken: c, next_steps_if_eligible: n}
caller: {persona_name: Sam}
questions:
`;
    expect(() => parseQuestionnaire(base + `  - {id: a, type: yes_no, ask: x}\n  - {id: a, type: yes_no, ask: y}\n`)).toThrow(/duplicate/);
    expect(() => parseQuestionnaire(base + `  - {id: a, type: single_choice, ask: x}\n`)).toThrow(/needs options/);
    expect(() => parseQuestionnaire(base + `  - {id: Bad-Id, type: yes_no, ask: x}\n`)).toThrow(/snake_case/);
  });
});
