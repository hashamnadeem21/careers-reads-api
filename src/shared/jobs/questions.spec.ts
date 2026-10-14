import { checkAnswer, checkAnswers, type FormQuestion, questionSchema } from "./questions.js";

const q = (over: Partial<FormQuestion>): FormQuestion => ({
  id: "q1",
  kind: "short_text",
  label: "Why us?",
  options: [],
  required: false,
  ...over,
});

describe("questionSchema", () => {
  it("drops choices from questions that don't use them", () => {
    const parsed = questionSchema.parse({ kind: "yes_no", label: "Can you start in May?", options: ["a", "b"] });
    expect(parsed).toEqual({ kind: "yes_no", label: "Can you start in May?", options: [], required: false });
  });

  it("needs two different choices for choice questions", () => {
    expect(questionSchema.safeParse({ kind: "single_choice", label: "Shift?", options: ["Day", ""] }).success).toBe(
      false,
    );
    expect(questionSchema.safeParse({ kind: "multi_choice", label: "Tools?", options: ["Go", "go"] }).success).toBe(
      false,
    );
    expect(questionSchema.parse({ kind: "single_choice", label: "Shift?", options: ["Day", "Night", ""] }).options).toEqual(
      ["Day", "Night"],
    );
  });
});

describe("checkAnswer", () => {
  it("lets optional questions be skipped and requires the rest", () => {
    expect(checkAnswer(q({}), "  ")).toEqual({ value: null });
    expect(checkAnswer(q({ required: true }), "")).toEqual({ error: "Please answer this question" });
    expect(checkAnswer(q({ kind: "multi_choice", options: ["a", "b"], required: true }), [])).toEqual({
      error: "Please answer this question",
    });
  });

  it("cleans each kind of answer", () => {
    expect(checkAnswer(q({ kind: "yes_no" }), "yes")).toEqual({ value: true });
    expect(checkAnswer(q({ kind: "yes_no" }), false)).toEqual({ value: false });
    expect(checkAnswer(q({ kind: "number" }), " 4.5 ")).toEqual({ value: 4.5 });
    expect(checkAnswer(q({ kind: "number" }), "four")).toEqual({ error: "Enter a number" });
    expect(checkAnswer(q({ kind: "url" }), "javascript:alert(1)")).toEqual({ error: "Enter a full link, like https://…" });
    expect(checkAnswer(q({ kind: "url" }), "https://github.com/me")).toEqual({ value: "https://github.com/me" });
    expect(checkAnswer(q({ kind: "single_choice", options: ["Day", "Night"] }), "Evening")).toEqual({
      error: "Choose one of the options",
    });
    expect(checkAnswer(q({ kind: "multi_choice", options: ["a", "b", "c"] }), ["c", "a", "a"])).toEqual({
      value: ["a", "c"],
    });
    expect(checkAnswer(q({ kind: "short_text" }), "x".repeat(301))).toEqual({ error: "Keep it under 300 characters" });
  });
});

describe("checkAnswers", () => {
  it("keys errors by question and ignores unknown answers", () => {
    const { values, errors } = checkAnswers([q({ id: "a", required: true }), q({ id: "b", kind: "yes_no" })], {
      b: "no",
      other: "ignored",
    });
    expect(errors).toEqual({ "answers.a": "Please answer this question" });
    expect([...values]).toEqual([["b", false]]);
  });
});
