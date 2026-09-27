import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { createLanguageModel } from "@grounded/providers";
import { z } from "zod";
import { createModelCaller } from "../engine/model-call.js";
import { importCallLimitsFor, importTrack } from "./import-track.js";
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

try {
  const outcome = await importTrack({
    db,
    models: createModelCaller({
      db,
      vault,
      createLanguageModel,
      limitsFor: importCallLimitsFor,
    }),
    // pnpm runs the script from apps/api; a relative path means the caller's directory.
    folder: resolve(process.env.INIT_CWD ?? process.cwd(), folder),
    email: values.email,
    write: values.write,
    ...(values.title ? { title: values.title } : {}),
  });
  console.log(formatOutcome(outcome));
  process.exitCode = outcome.status === "ok" ? 0 : 1;
} catch (error) {
  console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await close();
}
