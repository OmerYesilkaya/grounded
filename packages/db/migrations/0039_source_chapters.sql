CREATE TABLE "source_chapters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"track_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"title" text NOT NULL,
	"part" text,
	"page_start" integer,
	"pages" text,
	"characters" integer NOT NULL,
	"summary" text,
	"assumes" text
);
--> statement-breakpoint
CREATE TABLE "source_passages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"track_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"page_start" integer,
	"pages" text,
	"text" text NOT NULL
);
--> statement-breakpoint
DROP TABLE "source_sections" CASCADE;--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "source_chapters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD COLUMN "lesson_needed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "source_chapters" ADD CONSTRAINT "source_chapters_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chapters" ADD CONSTRAINT "source_chapters_file_id_track_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."track_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_passages" ADD CONSTRAINT "source_passages_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_passages" ADD CONSTRAINT "source_passages_chapter_id_source_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."source_chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_chapters_n" ON "source_chapters" USING btree ("track_id","n");--> statement-breakpoint
CREATE UNIQUE INDEX "source_passages_n" ON "source_passages" USING btree ("track_id","n");--> statement-breakpoint
CREATE INDEX "source_passages_chapter" ON "source_passages" USING btree ("chapter_id","n");--> statement-breakpoint
ALTER TABLE "learning_sessions" DROP COLUMN "source_sections";--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN "source_map";--> statement-breakpoint
-- A source read into sections before chapters existed (design §4.6, #66) is read again when the
-- learner says to: its transcribed pages are kept, so only the chapters' division and summaries
-- are paid for.
UPDATE "tracks" SET "source" = "source" || '{"status":"awaiting","summarized":0,"chapters":0,"assigned":null,"readThrough":0}'::jsonb - 'sections' WHERE "source" IS NOT NULL AND "source" ->> 'status' = 'ready';
