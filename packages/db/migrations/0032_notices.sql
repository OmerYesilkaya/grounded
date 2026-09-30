-- What the app tells the learner is stored as a notice the web words (design §9.3). Failures stored
-- before are kept as the words they were (a JSON string), and shown as they are.
ALTER TABLE "learning_sessions" ALTER COLUMN "probe_verdict_failure" SET DATA TYPE jsonb USING to_jsonb("probe_verdict_failure");--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "failure" SET DATA TYPE jsonb USING to_jsonb("failure");--> statement-breakpoint
ALTER TABLE "aside_messages" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "check_messages" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "review_messages" ADD COLUMN "failure" jsonb;
