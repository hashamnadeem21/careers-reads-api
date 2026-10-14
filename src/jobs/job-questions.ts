import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { jobQuestions } from "../db/schema.js";
import type { FormQuestion, Question } from "../shared/jobs/questions.js";

/** A job's questions in order, as the form (admin or website) shows them. */
export async function loadQuestions(db: Database | Tx, jobId: string): Promise<FormQuestion[]> {
  const rows = await db
    .select()
    .from(jobQuestions)
    .where(eq(jobQuestions.jobId, jobId))
    .orderBy(asc(jobQuestions.position));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    ...(r.helpText && { helpText: r.helpText }),
    options: r.options,
    required: r.required,
  }));
}

/**
 * Makes the job's questions exactly `questions`, in that order. Questions sent with the id of
 * one of this job's questions are updated in place (so answers stay linked to them); unknown ids
 * are treated as new questions, and questions left out are deleted (past answers keep their text).
 */
export async function syncQuestions(tx: Tx, jobId: string, questions: Question[]): Promise<void> {
  const existing = await tx.select({ id: jobQuestions.id }).from(jobQuestions).where(eq(jobQuestions.jobId, jobId));
  const owned = new Set(existing.map((r) => r.id));
  const kept = questions.map((q) => q.id).filter((id): id is string => !!id && owned.has(id));

  await tx
    .delete(jobQuestions)
    .where(and(eq(jobQuestions.jobId, jobId), kept.length ? notInArray(jobQuestions.id, kept) : undefined));

  for (const [position, q] of questions.entries()) {
    const values = {
      position,
      kind: q.kind,
      label: q.label,
      helpText: q.helpText ?? null,
      options: q.options,
      required: q.required,
    };
    if (q.id && owned.has(q.id)) {
      await tx
        .update(jobQuestions)
        .set(values)
        .where(and(eq(jobQuestions.id, q.id), eq(jobQuestions.jobId, jobId)));
    } else {
      await tx.insert(jobQuestions).values({ ...values, jobId });
    }
  }
}

/** Copies one job's questions to another (duplicating a job). */
export async function copyQuestions(db: Database | Tx, fromJobId: string, toJobId: string): Promise<void> {
  const rows = await db.select().from(jobQuestions).where(eq(jobQuestions.jobId, fromJobId));
  if (rows.length)
    await db
      .insert(jobQuestions)
      .values(rows.map(({ id: _id, jobId: _jobId, ...rest }) => ({ ...rest, jobId: toJobId })));
}
