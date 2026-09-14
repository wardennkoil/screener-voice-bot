import { describe, expect, it } from "vitest";
import { ScreeningState } from "../src/screening/state.js";
import { sampleQuestionnaire } from "./helpers.js";

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
