-- The learner chooses a password on their first sign-in (design §4.3), kept as a scrypt hash; wrong
-- ones are counted and lock sign-in for a while. None yet means they sign in with their invite code.
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sign_in_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;