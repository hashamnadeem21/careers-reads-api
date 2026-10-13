CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."newsletter_status" AS ENUM('draft', 'sending', 'sent');--> statement-breakpoint
CREATE TABLE "newsletter_deliveries" (
	"newsletter_id" integer NOT NULL,
	"subscriber_id" integer NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "newsletter_deliveries_newsletter_id_subscriber_id_pk" PRIMARY KEY("newsletter_id","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "newsletters" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" "newsletter_status" DEFAULT 'draft' NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "unsubscribe_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_deliveries_status_idx" ON "newsletter_deliveries" USING btree ("newsletter_id","status");--> statement-breakpoint
CREATE INDEX "newsletters_created_idx" ON "newsletters" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_unsubscribe_token_unique" UNIQUE("unsubscribe_token");