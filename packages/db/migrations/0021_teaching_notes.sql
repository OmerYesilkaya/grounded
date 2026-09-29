CREATE TABLE "learner_profile_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_learner" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_refreshes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learner_profile_notes" ADD CONSTRAINT "learner_profile_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_refreshes" ADD CONSTRAINT "profile_refreshes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_refreshes" ADD CONSTRAINT "profile_refreshes_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learner_profile_notes_user" ON "learner_profile_notes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "profile_refreshes_user" ON "profile_refreshes" USING btree ("user_id","created_at");