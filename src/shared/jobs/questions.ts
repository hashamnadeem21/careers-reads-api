// Owned by blognest-api. The admin copies it (`npm run sync:shared`) and the website keeps its own copy; keep the rules in step.
import { z } from "zod";

/** Screening questions an employer can add to a job's application form on Career Reads. */
export const QUESTION_KINDS = [
  "short_text",
  "long_text",
  "yes_no",
  "single_choice",
  "multi_choice",
  "number",
  "url",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  yes_no: "Yes / No",
  single_choice: "One choice",
  multi_choice: "Several choices",
  number: "Number",
  url: "Link",
};

export const MAX_QUESTIONS = 15;
const isChoice = (kind: QuestionKind) => kind === "single_choice" || kind === "multi_choice";

export const questionSchema = z
  .object({
    /** Set when editing a question that already exists. */
    id: z.uuid().optional(),
    kind: z.enum(QUESTION_KINDS),
    label: z.string().trim().min(3, "Write the question").max(200, "Keep the question under 200 characters"),
    helpText: z
      .string()
      .trim()
      .max(300, "Keep the hint under 300 characters")
      .optional()
      .transform((v) => v || undefined),
    options: z.array(z.string().trim().max(100, "Keep each choice under 100 characters")).max(20).default([]),
    required: z.boolean().default(false),
  })
  .transform((q) => ({ ...q, options: isChoice(q.kind) ? q.options.filter(Boolean) : [] }))
  .superRefine((q, ctx) => {
    if (!isChoice(q.kind)) return;
    if (q.options.length < 2) ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least two choices" });
    if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length)
      ctx.addIssue({ code: "custom", path: ["options"], message: "Each choice must be different" });
  });

export type QuestionInput = z.input<typeof questionSchema>;
export type Question = z.output<typeof questionSchema>;

/** A question as the application form shows it. */
export interface FormQuestion {
  id: string;
  kind: QuestionKind;
  label: string;
  helpText?: string;
  options: string[];
  required: boolean;
}

export type AnswerValue = string | string[] | boolean | number | null;

const MAX_TEXT: Partial<Record<QuestionKind, number>> = { short_text: 300, long_text: 3000, url: 500 };

/** Checks one answer against its question. Returns the cleaned value, or an error to show under the field. */
export function checkAnswer(question: FormQuestion, raw: unknown): { value: AnswerValue } | { error: string } {
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0);
  if (empty) return question.required ? { error: "Please answer this question" } : { value: null };

  switch (question.kind) {
    case "short_text":
    case "long_text":
    case "url": {
      if (typeof raw !== "string") return { error: "Please answer this question" };
      const text = raw.trim();
      if (text.length > MAX_TEXT[question.kind]!) return { error: `Keep it under ${MAX_TEXT[question.kind]} characters` };
      if (question.kind === "url" && !z.url({ protocol: /^https?$/ }).safeParse(text).success)
        return { error: "Enter a full link, like https://…" };
      return { value: text };
    }
    case "yes_no":
      if (raw === true || raw === "yes" || raw === "true") return { value: true };
      if (raw === false || raw === "no" || raw === "false") return { value: false };
      return { error: "Choose yes or no" };
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) return { error: "Enter a number" };
      return { value: n };
    }
    case "single_choice":
      if (typeof raw !== "string" || !question.options.includes(raw)) return { error: "Choose one of the options" };
      return { value: raw };
    case "multi_choice": {
      const picked = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string");
      if (picked.length === 0 || picked.some((v) => !question.options.includes(v)))
        return { error: "Choose from the options" };
      // Keep the employer's order, once each.
      return { value: question.options.filter((o) => picked.includes(o)) };
    }
  }
}

/**
 * Checks every answer. `raw` is keyed by question id; answers to unknown questions are ignored.
 * Errors are keyed `answers.<question id>`.
 */
export function checkAnswers(
  questions: FormQuestion[],
  raw: Record<string, unknown>,
): { values: Map<string, AnswerValue>; errors: Record<string, string> } {
  const values = new Map<string, AnswerValue>();
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const result = checkAnswer(question, raw[question.id]);
    if ("error" in result) errors[`answers.${question.id}`] = result.error;
    else values.set(question.id, result.value);
  }
  return { values, errors };
}
