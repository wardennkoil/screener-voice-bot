import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/conversation/prompt.js";
import { ToolHandlers } from "../src/conversation/tools.js";
import { parseQuestionnaire } from "../src/screening/loader.js";
import { ScreeningState, type StepResult } from "../src/screening/state.js";
import { csvColumns } from "../src/storage/csv.js";
import { sampleQuestionnaire } from "./helpers.js";

/** The real config the server runs with (the sleep fixture covers the generic behaviour elsewhere). */
const weightStudy = () => parseQuestionnaire(readFileSync(new URL("../config/questionnaire.yaml", import.meta.url), "utf8"));

/** Sarah's answers from the recruiter script. */
const SARAH: Array<[string, unknown]> = [
  ["still_interested", true],
  ["height_inches", 65],
  ["weight_lbs", 205],
  ["weight_change_3mo", false],
  ["high_blood_pressure", true],
  ["bp_medication", "amlodipine"],
  ["diabetes", "no"],
  ["weight_loss_meds_3mo", false],
  ["weight_loss_surgery", false],
  ["pancreatitis_or_mtc", false],
  ["pregnancy", false],
  ["other_study", false],
  ["can_attend_visits", true],
  ["screening_visit", "Tuesday October 6 at 8:30 AM"],
];

function record(state: ScreeningState, answers: Array<[string, unknown]>): StepResult {
  let last!: StepResult;
  for (const [id, value] of answers) {
    last = state.recordAnswer(id, value);
    expect(last.ok, `${id}: ${last.message}`).toBe(true);
  }
  return last;
}

describe("weight management questionnaire", () => {
  it("qualifies Sarah from the script, with a BMI of 34.1", () => {
    const s = new ScreeningState(weightStudy());
    const last = record(s, SARAH);
    expect(last.screening_complete).toBe(true);
    expect(last.outcome).toBe("eligible");
    expect(s.bmi()).toBe(34.1);
  });

  it("ends the screening the moment an answer rules them out", () => {
    const s = new ScreeningState(weightStudy());
    record(s, [["still_interested", true], ["height_inches", 68], ["weight_lbs", 240], ["weight_change_3mo", false], ["high_blood_pressure", false], ["diabetes", "no"]]);
    const step = s.recordAnswer("weight_loss_meds_3mo", true);
    expect(step).toMatchObject({ ok: true, screening_complete: true, outcome: "ineligible", next_question: null });
  });

  it("ends right away when they lose interest after hearing about the placebo", () => {
    const s = new ScreeningState(weightStudy());
    expect(s.recordAnswer("still_interested", false)).toMatchObject({ screening_complete: true, outcome: "ineligible" });
  });

  it("stops right after weight when the BMI is too low for any route in", () => {
    const s = new ScreeningState(weightStudy());
    record(s, [["still_interested", true], ["height_inches", 70]]);
    const step = s.recordAnswer("weight_lbs", 150); // BMI 21.5
    expect(step).toMatchObject({ screening_complete: true, outcome: "ineligible" });
    expect(s.eligibility().failed).toEqual(["bmi"]);
  });

  it("keeps going on a BMI between 27 and 30 until high blood pressure settles it", () => {
    const withBp = new ScreeningState(weightStudy());
    const afterWeight = record(withBp, [["still_interested", true], ["height_inches", 66], ["weight_lbs", 170]]); // BMI 27.4
    expect(afterWeight.screening_complete).toBe(false);
    expect(afterWeight.next_question?.id).toBe("weight_change_3mo");
    record(withBp, [["weight_change_3mo", false], ["high_blood_pressure", true]]);
    expect(withBp.eligibility().failed).not.toContain("bmi");
    expect(withBp.eligibility().missing).not.toContain("bmi");

    const withoutBp = new ScreeningState(weightStudy());
    record(withoutBp, [["still_interested", true], ["height_inches", 66], ["weight_lbs", 170], ["weight_change_3mo", false]]);
    expect(withoutBp.recordAnswer("high_blood_pressure", false)).toMatchObject({ screening_complete: true, outcome: "ineligible" });
  });

  it("accepts prediabetes and rules out diabetes", () => {
    const upTo = SARAH.slice(0, SARAH.findIndex(([id]) => id === "diabetes"));
    const pre = new ScreeningState(weightStudy());
    record(pre, upTo);
    expect(pre.recordAnswer("diabetes", "prediabetes").screening_complete).toBe(false);
    const dia = new ScreeningState(weightStudy());
    record(dia, upTo);
    expect(dia.recordAnswer("diabetes", "diabetes")).toMatchObject({ screening_complete: true, outcome: "ineligible" });
  });

  it("asks for their availability when none of the offered slots works", () => {
    const s = new ScreeningState(weightStudy());
    const step = record(s, [...SARAH.slice(0, -1), ["screening_visit", "none of these"]]);
    expect(step.screening_complete).toBe(false);
    expect(step.next_question?.id).toBe("visit_availability");
    expect(s.recordAnswer("visit_availability", "Friday mornings")).toMatchObject({ screening_complete: true, outcome: "eligible" });
  });

  it("puts the computed BMI right after weight in the results", () => {
    const cols = csvColumns(weightStudy());
    expect(cols.slice(cols.indexOf("weight_lbs"), cols.indexOf("weight_lbs") + 2)).toEqual(["weight_lbs", "bmi"]);
    expect(csvColumns(sampleQuestionnaire())).not.toContain("bmi");
  });

  it("walks the model through the script's call flow", () => {
    const prompt = buildSystemPrompt(weightStudy(), { firstName: "Sarah", recordingEnabled: false });
    expect(prompt).toContain("You are Maria");
    expect(prompt).toContain("they filled out a form on our website about the weight management research study");
    expect(prompt).toContain("still a good time to talk for about ten minutes");
    expect(prompt).toContain("Everything you share stays confidential");
    expect(prompt).toContain("elecoglipron");
    expect(prompt).toContain("- The study medication and the study tests are at no cost.");
    expect(prompt).toContain("A tool result can end the screening early");
    expect(prompt).toContain("You are calling Sarah.");
  });
});

describe("rejects a bmi block that does not fit the questions", () => {
  const base = readFileSync(new URL("../config/questionnaire.yaml", import.meta.url), "utf8");
  it("unknown ids", () => {
    expect(() => parseQuestionnaire(base.replace("height_question: height_inches", "height_question: height_cm"))).toThrow(/height_question "height_cm" is not a question id/);
  });
  it("wrong question types", () => {
    expect(() => parseQuestionnaire(base.replace("condition_questions: [high_blood_pressure]", "condition_questions: [diabetes]"))).toThrow(/must be a yes_no question/);
  });
});

describe("recording after the screening completed", () => {
  function started(q = weightStudy()) {
    const state = new ScreeningState(q);
    const tools = new ToolHandlers(state, q, { recordingEnabled: false });
    tools.handle("confirm_identity", { result: "confirmed" });
    tools.handle("record_consent", { proceed: true });
    return { state, tools };
  }

  it("takes an optional last answer instead of refusing it", () => {
    const q = sampleQuestionnaire();
    const { tools } = started(q);
    for (const [id, value] of [["age", 42], ["diagnosed_insomnia", true], ["sleep_medication", false], ["pregnant_or_nursing", false], ["can_attend_visits", true], ["smoker", "never"]] as const) {
      expect(tools.handle("record_answer", { question_id: id, value }).isError).toBeFalsy();
    }
    const late = tools.handle("record_answer", { question_id: "best_contact_time", value: "evenings" });
    expect(late.isError).toBeFalsy();
    expect(late.payload).toMatchObject({ ok: true, screening_complete: true });
  });

  it("lets a correction reopen an early stop, and refuses answers once the call is ending", () => {
    const { state, tools } = started();
    for (const [id, value] of SARAH.slice(0, 7)) tools.handle("record_answer", { question_id: id, value });
    const stop = tools.handle("record_answer", { question_id: "weight_loss_meds_3mo", value: true });
    expect(stop.payload).toMatchObject({ screening_complete: true, outcome: "ineligible" });
    expect(state.stage).toBe("closing");

    const fixed = tools.handle("record_answer", { question_id: "weight_loss_meds_3mo", value: false, verbatim: "Actually I stopped five months ago" });
    expect(fixed.payload).toMatchObject({ ok: true, next_question: { id: "weight_loss_surgery" } });
    expect(state.stage).toBe("screening");

    tools.handle("end_call", { reason: "completed" });
    expect(tools.handle("record_answer", { question_id: "weight_loss_surgery", value: false }).isError).toBe(true);
  });

  it("holds consent back until the consent statement has been given", () => {
    const q = weightStudy();
    const tools = new ToolHandlers(new ScreeningState(q), q, { recordingEnabled: false });
    const res = tools.handle("confirm_identity", { result: "confirmed" });
    expect(String(res.payload.message)).toContain("good time to talk for about ten minutes");
    expect(String(res.payload.message)).toContain("do not call record_consent yet");
  });

  it("still refuses answers before consent", () => {
    const q = weightStudy();
    const state = new ScreeningState(q);
    const tools = new ToolHandlers(state, q, { recordingEnabled: false });
    tools.handle("confirm_identity", { result: "wrong_person" });
    expect(tools.handle("record_answer", { question_id: "still_interested", value: true }).isError).toBe(true);
  });
});
