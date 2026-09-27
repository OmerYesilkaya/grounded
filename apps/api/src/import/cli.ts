import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { createLanguageModel } from "@grounded/providers";
import { z } from "zod";
import { createModelCaller } from "../engine/model-call.js";
import { importCallLimitsFor, importTrack, type ReviewedConversion } from "./import-track.js";
import { formatOutcome } from "./report.js";

const USAGE =
  "usage: pnpm import-track <path-to-track-folder> --email <learner email> [--title <title>] [--write]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    title: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const [folder] = positionals;
if (!folder || !values.email || positionals.length > 1) {
  console.error(USAGE);
  process.exit(1);
}

const env = z
  .object({
    DATABASE_URL: z.url(),
    KEY_VAULT_MASTER_KEYS: z.string().min(1),
    KEY_VAULT_ACTIVE_KID: z.string().min(1),
  })
  .parse(process.env);
const { db, close } = createDb(env.DATABASE_URL);
const vault = createKeyVault({
  masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
  activeKid: env.KEY_VAULT_ACTIVE_KID,
});

// pnpm runs the script from apps/api; a relative path means the caller's directory.
const callerDir = process.env.INIT_CWD ?? process.cwd();
const trackFolder = resolve(callerDir, folder);
// The dry run's result, kept for the write (learner data: .imports/ is git-ignored).
const reviewedPath = join(callerDir, ".imports", `${basename(trackFolder)}.json`);

async function readReviewed(): Promise<ReviewedConversion | undefined> {
  try {
    return JSON.parse(await readFile(reviewedPath, "utf8")) as ReviewedConversion;
  } catch {
    return undefined;
  }
}

try {
  const reviewed = values.write ? await readReviewed() : undefined;
  const outcome = await importTrack({
    db,
    models: createModelCaller({
      db,
      vault,
      createLanguageModel,
      limitsFor: importCallLimitsFor,
    }),
    folder: trackFolder,
    email: values.email,
    write: values.write,
    ...(reviewed ? { reviewed } : {}),
    ...(values.title ? { title: values.title } : {}),
  });
  console.log(formatOutcome(outcome));
  if (outcome.status === "ok" && !values.write) {
    await mkdir(dirname(reviewedPath), { recursive: true });
    await writeFile(reviewedPath, JSON.stringify(outcome.conversion, null, 2));
    console.log(
      `\nSaved for --write: ${reviewedPath}\n--write applies exactly this, without calling the model again.`,
    );
  }
  process.exitCode = outcome.status === "ok" ? 0 : 1;
} catch (error) {
  console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await close();
}
