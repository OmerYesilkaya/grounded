import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

/**
 * Grounded on Railway (design §4.2): Postgres and two services built from the root Dockerfile, the
 * API (which also serves the web app) and the worker. Preview with `railway config plan`, apply with
 * `railway config apply`. Secrets stay on Railway: `preserve()` keeps each value without writing it
 * here.
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
  const secrets = {
    DATABASE_URL: preserve(),
    KEY_VAULT_MASTER_KEYS: preserve(),
    KEY_VAULT_ACTIVE_KID: preserve(),
    BETTER_AUTH_SECRET: preserve(),
  };

  const db = postgres("Postgres", { region: "sfo" });
  db.networking = { privateNetworkEndpoint: "postgres" };
  const dbVolume = volume("postgres-volume", {
    region: "sfo",
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
    env: {
      ...secrets,
      APP_URL: preserve(),
      RESEND_API_KEY: preserve(),
      EMAIL_FROM: preserve(),
    },
  });

  const worker = service("@grounded/worker", {
    source: repo,
    build,
    start: "node --import tsx src/worker.ts",
    preDeploy: [],
    replicas: { sfo: 1 },
    // Time for running generations to finish before a redeploy stops the old worker.
    deploy: { drainingSeconds: 300, overlapSeconds: 0 },
    networking: { privateNetworkEndpoint: "groundedworker" },
    env: secrets,
  });

  return project("grounded", { resources: [db, dbVolume, api, worker] });
});
