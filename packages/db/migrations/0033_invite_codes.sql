-- Sign-in asks for an invite code beside the email (design §4.3); only its hash is kept. Rows from
-- before have none: they keep signed-in people in, and `pnpm cli invite` issues their code.
ALTER TABLE "allowlist" ADD COLUMN "code_hash" text;--> statement-breakpoint
ALTER TABLE "allowlist" ADD COLUMN "code_issued_at" timestamp with time zone;