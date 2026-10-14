CREATE TYPE "public"."candidate_auth_method" AS ENUM('google', 'password', 'apply');--> statement-breakpoint
CREATE TYPE "public"."candidate_event_kind" AS ENUM('signed_up', 'signed_in', 'signed_out', 'email_confirmed', 'password_reset', 'applied', 'subscribed');--> statement-breakpoint
CREATE TYPE "public"."candidate_token_kind" AS ENUM('confirm_email', 'reset_password');--> statement-breakpoint
ALTER TYPE "public"."automation_trigger" ADD VALUE 'candidate_signed_up';--> statement-breakpoint
CREATE TABLE "candidate_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" "candidate_event_kind" NOT NULL,
	"method" "candidate_auth_method",
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" "candidate_token_kind" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_deliveries" ALTER COLUMN "subscriber_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD COLUMN "candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "signup_method" "candidate_auth_method" DEFAULT 'apply' NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "account_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "sign_in_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_events" ADD CONSTRAINT "candidate_events_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_events" ADD CONSTRAINT "candidate_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_sessions" ADD CONSTRAINT "candidate_sessions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tokens" ADD CONSTRAINT "candidate_tokens_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_events_candidate_idx" ON "candidate_events" USING btree ("candidate_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "candidate_events_kind_idx" ON "candidate_events" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "candidate_sessions_candidate_idx" ON "candidate_sessions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "candidate_tokens_candidate_idx" ON "candidate_tokens" USING btree ("candidate_id","kind");--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidates_account_created_idx" ON "candidates" USING btree ("account_created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_once_candidate" UNIQUE("automation_id","candidate_id");--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_google_sub_unique" UNIQUE("google_sub");--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_one_recipient" CHECK (num_nonnulls("automation_deliveries"."subscriber_id", "automation_deliveries"."candidate_id") = 1);