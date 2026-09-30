CREATE TABLE "model_calls" (
	"usage_event_id" uuid PRIMARY KEY NOT NULL,
	"track_id" uuid,
	"session_id" uuid,
	"prompt" jsonb NOT NULL,
	"response_format" jsonb,
	"tools" jsonb,
	"settings" jsonb NOT NULL,
	"reply" jsonb,
	"error" jsonb,
	"verdict" jsonb
);
--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_session" ON "model_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "model_calls_track" ON "model_calls" USING btree ("track_id");