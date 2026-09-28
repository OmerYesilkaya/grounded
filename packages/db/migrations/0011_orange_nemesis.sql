ALTER TABLE "tracks" ADD COLUMN "goal" text;--> statement-breakpoint
-- Tracks from before had only a title, which was the learner's words.
UPDATE "tracks" SET "goal" = "title";--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "goal" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "title_pending" boolean DEFAULT false NOT NULL;
