CREATE TYPE "public"."automation_delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger" AS ENUM('subscribed');--> statement-breakpoint
ALTER TYPE "public"."newsletter_status" ADD VALUE 'scheduled' BEFORE 'sending';--> statement-breakpoint
CREATE TABLE "automation_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"automation_id" integer NOT NULL,
	"subscriber_id" integer NOT NULL,
	"status" "automation_delivery_status" DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_deliveries_once" UNIQUE("automation_id","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "email_automations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"trigger" "automation_trigger" DEFAULT 'subscribed' NOT NULL,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "audience_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "audience_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_automation_id_email_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."email_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_automations" ADD CONSTRAINT "email_automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_deliveries_due_idx" ON "automation_deliveries" USING btree ("due_at") WHERE "automation_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "automation_deliveries_automation_idx" ON "automation_deliveries" USING btree ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "newsletters_status_scheduled_idx" ON "newsletters" USING btree ("status","scheduled_at");--> statement-breakpoint
-- A ready-to-edit welcome email, switched off until someone reviews it in the admin.
INSERT INTO "email_automations" ("name", "trigger", "delay_minutes", "subject", "preview_text", "body", "active")
VALUES (
	'Welcome email',
	'subscribed',
	0,
	'Welcome to Career Reads',
	'Thanks for subscribing. Here''s what to expect.',
	$body$## Welcome aboard!

Thanks for subscribing to Career Reads. You're now on the list for our newsletter.

**Here's what you'll get:**

- Hand-picked **jobs**, including remote roles
- Practical **career guides** on CVs, interviews and switching fields
- No spam, and you can unsubscribe in one click at any time

While you wait for the next issue, here are good places to start:

- [Browse the latest jobs](/jobs)
- [Read our career guides](/blog)

Got a question or a topic you'd like us to cover? Just reply to this email.

Talk soon,\
The Career Reads team$body$,
	false
);
