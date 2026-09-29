ALTER TABLE "assignments" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "subsumed_by" uuid;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_subsumed_by_assignments_id_fk" FOREIGN KEY ("subsumed_by") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;