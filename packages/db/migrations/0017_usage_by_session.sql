ALTER TABLE "usage_events" ADD COLUMN "track_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_events_session" ON "usage_events" USING btree ("session_id");