import { describe, expect, it } from "vitest";
import { ScreeningState } from "../src/screening/state.js";
import { sampleQuestionnaire } from "./helpers.js";

/** The sleep fixture plus an other-studies question for people who are ruled out. */
function withOtherStudies(stopOnDisqualify: boolean) {
  const q = sampleQuestionnaire();
  q.settings.stop_on_disqualify = stopOnDisqualify;
  q.questions.splice(1, 0, { id: "open_to_other_studies", type: "yes_no", ask: "Whether they want to hear about other studies", ask_when: "ineligible", required: true, sensitive: false });
  return q;
}

describe("ScreeningState", () => {
  it("walks the questions in order and surfaces follow-ups only when they apply", () => {
    const s = new ScreeningState(sampleQuestionnaire());
    expect(s.nextQuestion()?.id).toBe("age");
    expect(s.recordAnswer("age", "42", "I'm forty-two").next_question?.id).toBe("diagnosed_insomnia");
    s.recordAnswer("diagnosed_insomnia", true);
    const r = s.recordAnswer("sleep_medication", "yes");
    expect(r.ok).toBe(true);
    expect(r.next_question?.id).toBe("sleep_medication_name");
    expect(r.next_question?.guidance).toMatch(/Optional/);
    s.recordAnswer("sleep_medication", "no");
    expect(s.nextQuestion()?.id).toBe("pregnant_or_nursing");
  });

  it("rejects bad values with guidance and keeps the question pending", () => {
    const s = new ScreeningState(sampleQuestionnaire());
    const r = s.recordAnswer("age", 7);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/plausible/);
    expect(r.next_question?.id).toBe("age");
    expect(s.recordAnswer("nope", 1).ok).toBe(false);
  });

  it("completes when required questions are answered or skipped and reports the outcome", () => {
    const s = new ScreeningState(sampleQuestionnaire());
    s.recordAnswer("age", 30);
    s.recordAnswer("diagnosed_insomnia", true);
    s.recordAnswer("sleep_medication", false);
    s.recordAnswer("pregnant_or_nursing", false);
    s.recordAnswer("can_attend_visits", true);
    expect(s.isScreeningComplete()).toBe(false);
    const r = s.skipQuestion("smoker", "declined");
    expect(r.screening_complete).toBe(true);
    expect(r.outcome).toBe("eligible");
    expect(r.next_question?.id).toBe("best_contact_time");
    expect(s.remaining()).toBe(1);
  });

  it("asks the ineligible-only question after the regular ones when screening continues past a disqualifying answer", () => {
    // Placed second in the file on purpose: it still waits until every regular question is done.
    const s = new ScreeningState(withOtherStudies(false));
    expect(s.recordAnswer("age", 80).next_question?.id).toBe("diagnosed_insomnia");
    for (const [id, value] of [["diagnosed_insomnia", true], ["sleep_medication", false], ["pregnant_or_nursing", false], ["can_attend_visits", true], ["smoker", "never"]] as const) s.recordAnswer(id, value);
    expect(s.nextQuestion()?.id).toBe("best_contact_time");
    const last = s.recordAnswer("best_contact_time", "evenings");
    expect(last).toMatchObject({ screening_complete: false, next_question: { id: "open_to_other_studies" } });
    expect(s.skipQuestion("open_to_other_studies", "did not want to say")).toMatchObject({ screening_complete: true, outcome: "ineligible", next_question: null });
  });

  it("never asks the ineligible-only question of someone who qualifies or is still undetermined", () => {
    const s = new ScreeningState(withOtherStudies(true));
    for (const [id, value] of [["age", 40], ["diagnosed_insomnia", true], ["sleep_medication", false], ["pregnant_or_nursing", false], ["can_attend_visits", true], ["smoker", "never"]] as const) {
      expect(s.recordAnswer(id, value).next_question?.id).not.toBe("open_to_other_studies");
    }
    expect(s.isScreeningComplete()).toBe(true);
    expect(s.recordAnswer("open_to_other_studies", true)).toMatchObject({ ok: false, message: expect.stringMatching(/does not apply/) });
  });

  it("with stop_on_disqualify, ruling someone out leaves only the ineligible-only question", () => {
    const s = new ScreeningState(withOtherStudies(true));
    expect(s.recordAnswer("age", 80)).toMatchObject({ screening_complete: false, next_question: { id: "open_to_other_studies" }, remaining: 1 });
    expect(s.recordAnswer("open_to_other_studies", false)).toMatchObject({ screening_complete: true, outcome: "ineligible", remaining: 0 });
  });

  it("stops early when stop_on_disqualify is on", () => {
    const q = sampleQuestionnaire();
    q.settings.stop_on_disqualify = true;
    const s = new ScreeningState(q);
    const r = s.recordAnswer("age", 80);
    expect(r.screening_complete).toBe(true);
    expect(r.outcome).toBe("ineligible");
    expect(r.next_question).toBeNull();
  });
});
