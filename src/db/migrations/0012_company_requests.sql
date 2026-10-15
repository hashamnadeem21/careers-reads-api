CREATE TYPE "public"."company_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "company_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"website" text,
	"industry" text NOT NULL,
	"company_size" text NOT NULL,
	"location" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_role" text NOT NULL,
	"hiring_plans" text,
	"status" "company_request_status" DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_requests_email_lowercase" CHECK ("company_requests"."contact_email" = lower("company_requests"."contact_email"))
);
--> statement-breakpoint
ALTER TABLE "company_requests" ADD CONSTRAINT "company_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_requests" ADD CONSTRAINT "company_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_requests_status_idx" ON "company_requests" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "company_requests_one_pending" ON "company_requests" USING btree ("contact_email") WHERE "company_requests"."status" = 'pending';