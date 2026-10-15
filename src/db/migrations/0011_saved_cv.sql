ALTER TABLE "candidates" ADD COLUMN "cv_file_id" uuid;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_cv_file_id_private_files_id_fk" FOREIGN KEY ("cv_file_id") REFERENCES "public"."private_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- People who applied before saved CVs existed start with the CV from their latest application.
UPDATE "candidates" AS c SET "cv_file_id" = latest."resume_file_id"
FROM (
  SELECT DISTINCT ON ("candidate_id") "candidate_id", "resume_file_id"
  FROM "applications"
  ORDER BY "candidate_id", "created_at" DESC
) AS latest
WHERE latest."candidate_id" = c."id" AND c."cv_file_id" IS NULL;
