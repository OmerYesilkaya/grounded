ALTER TABLE "usage_events" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "error_kind" text;