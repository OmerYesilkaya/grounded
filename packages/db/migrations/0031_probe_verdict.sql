ALTER TABLE "learning_sessions" ADD COLUMN "probe_verdict" jsonb;--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "probe_verdict_status" text;--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "probe_verdict_failure" text;--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "probe_verdict_at" timestamp with time zone;