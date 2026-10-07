CREATE TYPE "public"."job_review" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
-- Hand-edited: rename in place so existing admins keep their accounts (drizzle-kit would drop and recreate the type).
ALTER TYPE "public"."user_role" RENAME VALUE 'admin' TO 'super_admin';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'company';--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review" "job_review";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_company_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobs_review_idx" ON "jobs" USING btree ("review");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_role" CHECK (("users"."role"::text = 'company') = ("users"."company_id" is not null));
