CREATE TABLE "source_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"track_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"title" text NOT NULL,
	"page_start" integer,
	"pages" text,
	"text" text NOT NULL,
	"summary" text
);
--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "source_sections" jsonb;--> statement-breakpoint
ALTER TABLE "track_files" ADD COLUMN "role" text DEFAULT 'brought' NOT NULL;--> statement-breakpoint
ALTER TABLE "track_files" ADD COLUMN "transcripts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "source_map" jsonb;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_file_id_track_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."track_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_sections_n" ON "source_sections" USING btree ("track_id","n");