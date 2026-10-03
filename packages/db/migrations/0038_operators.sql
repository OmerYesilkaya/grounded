ALTER TABLE "allowlist" ADD COLUMN "operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Learners already signed up are numbered in the order they first signed in.
ALTER TABLE "users" ADD COLUMN "learner_number" integer;--> statement-breakpoint
UPDATE "users" SET "learner_number" = numbered.n
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "users") AS numbered
  WHERE "users"."id" = numbered."id";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "learner_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "learner_number" ADD GENERATED ALWAYS AS IDENTITY (sequence name "users_learner_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval('"users_learner_number_seq"', (SELECT coalesce(max("learner_number"), 0) + 1 FROM "users"), false);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_learner_number_unique" UNIQUE("learner_number");
