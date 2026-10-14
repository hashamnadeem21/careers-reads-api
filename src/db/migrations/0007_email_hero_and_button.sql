ALTER TABLE "email_automations" ADD COLUMN "hero_image" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_automations" ADD COLUMN "cta_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_automations" ADD COLUMN "cta_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "hero_image" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "cta_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "cta_url" text DEFAULT '' NOT NULL;