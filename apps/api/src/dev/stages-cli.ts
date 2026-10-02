import { parseArgs } from "node:util";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createEmbedded, createFreshDatabase } from "../embedded.js";
import { seedStages, STAGES, stageModels, type StageKey } from "./stages.js";

/*
 * `pnpm stages`: a database of its own, next to the development one (its name plus "_stages"),
 * made afresh with a track stopped at each stage of homework, arc exams and the final (stages.ts),
 * for one learner. The development server is then pointed at it to look at them. Running it again
 * starts the database over.
 */

const usage = `usage: pnpm stages [--email <email>] [--password <password>] [--only <stage>,…]

Stages: ${STAGES.map((s) => s.key).join(", ")}`;

const { values } = parseArgs({
  options: {
    email: { type: "string", default: "learner@example.com" },
    password: { type: "string", default: "stages-password" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const only = values.only?.split(",").map((s) => s.trim()) as StageKey[] | undefined;
const unknown = only?.filter((key) => !STAGES.some((s) => s.key === key)) ?? [];
if (unknown.length) {
  console.error(`unknown stage: ${unknown.join(", ")}\n\n${usage}`);
  process.exit(1);
}

const serverUrl = process.env.DATABASE_URL;
const masterKeys = process.env.KEY_VAULT_MASTER_KEYS;
const activeKid = process.env.KEY_VAULT_ACTIVE_KID;
if (!serverUrl || !masterKeys || !activeKid)
  throw new Error(
    "DATABASE_URL, KEY_VAULT_MASTER_KEYS and KEY_VAULT_ACTIVE_KID must be set (.env)",
  );

const database = await createFreshDatabase(serverUrl, "stages");
const models = stageModels();
const backend = createEmbedded({
  databaseUrl: database.url,
  models: models.access,
  // The development server's vault, so it can open the placeholder key the learner is given.
  vault: createKeyVault({ masterKeys: parseMasterKeys(masterKeys), activeKid }),
});
try {
  await backend.startWorker();
  console.log(`seeding ${database.url}`);
  const seeded = await seedStages(backend, models, {
    email: values.email,
    password: values.password,
    ...(only ? { only } : {}),
  });
  const web = process.env.APP_URL ?? "http://localhost:5173";
  console.log(`
Sign in as ${values.email} with the password ${values.password}.
${seeded.map((s) => `\n  ${s.title}\n    ${web}${s.path}`).join("")}

Point the development server at it (the web app as usual, \`pnpm dev:web\`):

  DATABASE_URL=${database.url} pnpm dev:api

To go on from a stage (hand in the homework, answer the teach-back…) without spending credit, run
the worker on it with the canned replies:

  DATABASE_URL=${database.url} DEMO_MODELS=true pnpm dev:worker
`);
} finally {
  await backend.stop();
  await database.keep();
}
