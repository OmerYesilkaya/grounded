CREATE TABLE "aside_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aside_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"blocks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"tangent" text,
	"saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aside_messages" ADD CONSTRAINT "aside_messages_aside_id_asides_id_fk" FOREIGN KEY ("aside_id") REFERENCES "public"."asides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asides" ADD CONSTRAINT "asides_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aside_messages_aside" ON "aside_messages" USING btree ("aside_id","created_at");--> statement-breakpoint
CREATE INDEX "asides_session" ON "asides" USING btree ("session_id","created_at");