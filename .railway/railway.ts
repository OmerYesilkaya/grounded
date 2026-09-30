import {
  bucket,
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  ref,
  service,
  volume,
} from "railway/iac";

/**
 * Grounded on Railway (design §4.2): Postgres and two services built from the root Dockerfile, the
 * API (which also serves the web app) and the worker, and a bucket for learners' files (design
 * §4.5). Preview with `railway config plan`, apply with `railway config apply --yes`. Secrets stay
 * on Railway: `preserve()` keeps each value without writing it here.
 */
export default defineRailway(() => {
  // Deploy a commit only after CI passes on it.
  const repo = github("OmerYesilkaya/grounded", { checkSuites: true });
  // Every service builds the one image; any change can affect either, so no watch patterns.
  const build = {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile",
    buildEnvironment: "V3",
    buildCommand: null,
    watchPatterns: null,
  } as const;
  const db = postgres("Postgres", { region: "ams" });
  db.networking = { privateNetworkEndpoint: "postgres" };
  // Learners' files (design §4.5): both services read them, by reference to the bucket's own
  // credentials, so a credentials reset on Railway reaches them.
  const files = bucket("@grounded/bucket", { region: "ams" });
  const common = {
    // A reference, so it follows the database; it resolves only on a service, not as a shared variable.
    DATABASE_URL: db.env.DATABASE_URL,
    KEY_VAULT_MASTER_KEYS: preserve(),
    KEY_VAULT_ACTIVE_KID: preserve(),
    AUTH_SECRET: preserve(),
    FILES_BUCKET: ref(files, "BUCKET"),
    FILES_ENDPOINT: ref(files, "ENDPOINT"),
    FILES_REGION: ref(files, "REGION"),
    FILES_ACCESS_KEY_ID: ref(files, "ACCESS_KEY_ID"),
    FILES_SECRET_ACCESS_KEY: ref(files, "SECRET_ACCESS_KEY"),
  };
  const dbVolume = volume("postgres-volume", {
    region: "ams",
    sizeMB: 500,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  const api = service("@grounded/api", {
    source: repo,
    build,
    start: "node --import tsx src/server.ts",
    // Migrations run once per deploy, before the new API starts.
    preDeploy: "pnpm --filter @grounded/db migrate",
    healthcheck: "/healthz",
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "groundedapi" },
    env: { ...common, APP_URL: preserve() },
  });

  const worker = service("@grounded/worker", {
    source: repo,
    build,
    start: "node --import tsx src/worker.ts",
    preDeploy: [],
    replicas: { "europe-west4-drams3a": 1 },
    // Time for running generations to finish before a redeploy stops the old worker.
    deploy: { drainingSeconds: 300, overlapSeconds: 0 },
    networking: { privateNetworkEndpoint: "groundedworker" },
    env: common,
  });

  return project("grounded", { resources: [db, dbVolume, files, api, worker] });
});
