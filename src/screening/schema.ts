import { z } from "zod";

/**
 * Questionnaire configuration schema (config/questionnaire.yaml).
 *
 * Questions are guidance for the conversational model, not verbatim scripts:
 * the model phrases them naturally in context. The server owns validation,
 * ordering, follow-ups, and eligibility.
 */

export const QuestionTypeSchema = z.enum([
  "yes_no",
  "integer",
  "number",
  "single_choice",
  "multi_choice",
  "free_text",
  "date",
]);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

const ScalarSchema = z.union([z.boolean(), z.string(), z.number()]);

/** A rule is satisfied only when every listed condition holds. */
export const RuleSchema = z
  .strictObject({
    equals: ScalarSchema.optional(),
    not_equals: ScalarSchema.optional(),
    in: z.array(z.string()).min(1).optional(),
    not_in: z.array(z.string()).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, { message: "A rule needs at least one condition" });
export type Rule = z.infer<typeof RuleSchema>;

const QuestionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "question ids must be snake_case (letters, digits, underscores)");

const BaseQuestionSchema = z.strictObject({
  id: QuestionIdSchema,
  type: QuestionTypeSchema,
  /** What to find out, written for the model (e.g. "How old they are"). */
  ask: z.string().min(1),
  /** Optional short label used in logs and notes. */
  label: z.string().optional(),
  /** Allowed values for single_choice / multi_choice. */
  options: z.array(z.string().min(1)).min(2).optional(),
  /** Unit hint for numeric questions (e.g. "years"). */
  unit: z.string().optional(),
  /** Plausibility bounds for numeric answers; out-of-range answers are rejected and re-asked. */
  valid: z.strictObject({ min: z.number().optional(), max: z.number().optional() }).optional(),
  /** Required questions must be answered (or explicitly skipped) before the screening is complete. */
  required: z.boolean().default(true),
  /** Eligibility rule evaluated server-side against the normalized answer. */
  eligible_if: RuleSchema.optional(),
  /** Marks a delicate topic; the model is told to ask gently and accept a decline. */
  sensitive: z.boolean().default(false),
});

const FollowUpSchema = z.strictObject({
  /** Rule on the parent's normalized answer that makes the follow-up applicable. */
  when: RuleSchema,
  question: BaseQuestionSchema,
});

export const QuestionSchema = BaseQuestionSchema.extend({
  follow_up_if: FollowUpSchema.optional(),
}).superRefine((q, ctx) => {
  const needsOptions = q.type === "single_choice" || q.type === "multi_choice";
  if (needsOptions && !q.options) {
    ctx.addIssue({ code: "custom", message: `question "${q.id}" of type ${q.type} needs options` });
  }
  if (!needsOptions && q.options) {
    ctx.addIssue({ code: "custom", message: `question "${q.id}" of type ${q.type} must not have options` });
  }
  const fu = q.follow_up_if?.question;
  if (fu) {
    const fuNeedsOptions = fu.type === "single_choice" || fu.type === "multi_choice";
    if (fuNeedsOptions && !fu.options) {
      ctx.addIssue({ code: "custom", message: `follow-up "${fu.id}" of type ${fu.type} needs options` });
    }
  }
});
export type Question = z.infer<typeof QuestionSchema>;
export type BaseQuestion = z.infer<typeof BaseQuestionSchema>;

export const QuestionnaireSchema = z
  .strictObject({
    study: z.strictObject({
      /** Spoken name, e.g. "the Restful Nights sleep study". */
      name: z.string().min(1),
      /** Spoken organization, e.g. "the Meridian Sleep Research Center". */
      organization: z.string().min(1),
      /** One spoken sentence fragment describing the study. */
      description_short: z.string().min(1),
      /** Callback number written the way it should be spoken, digits as words. */
      callback_number_spoken: z.string().min(1),
      /** What happens next for eligible people, as a spoken phrase. */
      next_steps_if_eligible: z.string().min(1),
    }),
    caller: z.strictObject({
      persona_name: z.string().min(1),
      /** Say up front that the caller is an automated assistant. When false the caller still answers truthfully if asked. */
      ai_disclosure: z.boolean().default(true),
    }),
    settings: z
      .strictObject({
        /** Stop asking once an answer rules the person out (reveals the criterion; default false). */
        stop_on_disqualify: z.boolean().default(false),
        /** Tell an ineligible person which answer ruled them out (default false). */
        reveal_reason_when_ineligible: z.boolean().default(false),
        /** Hard cap on call length; the model is asked to wrap up before this. */
        max_call_minutes: z.number().int().min(2).max(60).default(15),
        /** Also store the person's own words per answer in the CSV (<id>__verbatim columns). */
        store_verbatim: z.boolean().default(true),
      })
      .default({ stop_on_disqualify: false, reveal_reason_when_ineligible: false, max_call_minutes: 15, store_verbatim: true }),
    questions: z.array(QuestionSchema).min(1),
    /** Only "all_rules" is supported today: eligible iff every eligible_if rule passes. */
    eligibility: z.literal("all_rules").default("all_rules"),
  })
  .superRefine((q, ctx) => {
    const ids = new Set<string>();
    const all = q.questions.flatMap((x) => (x.follow_up_if ? [x, x.follow_up_if.question] : [x]));
    for (const x of all) {
      if (ids.has(x.id)) ctx.addIssue({ code: "custom", message: `duplicate question id "${x.id}"` });
      ids.add(x.id);
    }
  });
export type Questionnaire = z.infer<typeof QuestionnaireSchema>;

/** A question as it appears in the asking order, with its follow-up relationship resolved. */
export interface FlatQuestion extends BaseQuestion {
  parentId?: string;
  parentRule?: Rule;
}

export function flattenQuestions(q: Questionnaire): FlatQuestion[] {
  const out: FlatQuestion[] = [];
  for (const question of q.questions) {
    const { follow_up_if, ...base } = question;
    out.push(base);
    if (follow_up_if) {
      out.push({ ...follow_up_if.question, parentId: base.id, parentRule: follow_up_if.when });
    }
  }
  return out;
}
