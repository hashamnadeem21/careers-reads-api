CREATE TYPE "public"."application_event_kind" AS ENUM('status_changed', 'note', 'cv_viewed');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('new', 'reviewed', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."question_kind" AS ENUM('short_text', 'long_text', 'yes_no', 'single_choice', 'multi_choice', 'number', 'url');--> statement-breakpoint
CREATE TABLE "application_answers" (
	"application_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"question_id" uuid,
	"kind" "question_kind" NOT NULL,
	"label" text NOT NULL,
	"value" jsonb,
	CONSTRAINT "application_answers_application_id_position_pk" PRIMARY KEY("application_id","position")
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "application_event_kind" NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"company_id" uuid,
	"candidate_id" uuid NOT NULL,
	"resume_file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"location" text,
	"linkedin_url" text,
	"cover_letter" text,
	"status" "application_status" DEFAULT 'new' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"notify_attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_once_per_job" UNIQUE("job_id","candidate_id")
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_email_unique" UNIQUE("email"),
	CONSTRAINT "candidates_email_lowercase" CHECK ("candidates"."email" = lower("candidates"."email"))
);
--> statement-breakpoint
CREATE TABLE "job_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" "question_kind" NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "onsite_apply_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "onsite_apply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_question_id_job_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."job_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_file_id_private_files_id_fk" FOREIGN KEY ("resume_file_id") REFERENCES "public"."private_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_questions" ADD CONSTRAINT "job_questions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_answers_question_idx" ON "application_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "application_events_application_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_company_idx" ON "applications" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_job_idx" ON "applications" USING btree ("job_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_candidate_idx" ON "applications" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "applications_resume_idx" ON "applications" USING btree ("resume_file_id");--> statement-breakpoint
CREATE INDEX "applications_unnotified_idx" ON "applications" USING btree ("created_at") WHERE "applications"."notified_at" is null;--> statement-breakpoint
CREATE INDEX "job_questions_job_idx" ON "job_questions" USING btree ("job_id","position");--> statement-breakpoint
CREATE INDEX "private_files_created_idx" ON "private_files" USING btree ("created_at");
