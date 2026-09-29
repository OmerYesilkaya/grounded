CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"anchor" jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_in_session" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"comment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"blocks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"status" text DEFAULT 'reviewing' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_assignment_id_unique" UNIQUE("assignment_id")
);
--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_resolved_in_session_learning_sessions_id_fk" FOREIGN KEY ("resolved_in_session") REFERENCES "public"."learning_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_comment_id_review_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."review_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_review" ON "review_comments" USING btree ("review_id","position");--> statement-breakpoint
CREATE INDEX "review_messages_comment" ON "review_messages" USING btree ("comment_id","created_at");