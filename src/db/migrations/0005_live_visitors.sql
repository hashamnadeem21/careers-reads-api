CREATE TABLE "live_visitors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "live_visitors_last_seen_idx" ON "live_visitors" USING btree ("last_seen");