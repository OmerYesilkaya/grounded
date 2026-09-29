ALTER TABLE "learning_sessions" ADD COLUMN "review_summary" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "taken_up_in" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_taken_up_in_learning_sessions_id_fk" FOREIGN KEY ("taken_up_in") REFERENCES "public"."learning_sessions"("id") ON DELETE set null ON UPDATE no action;