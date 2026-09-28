import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.url(),
    KEY_VAULT_MASTER_KEYS: z.string().min(1),
    KEY_VAULT_ACTIVE_KID: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    /** Where the web app is served; the API is reached through it at /api. */
    APP_URL: z.url().default("http://localhost:5173"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(8787),
    /** Production: the built web app, served by the API on the same origin. Vite serves it otherwise. */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /** Magic links go by email when set; to the console otherwise. */
    RESEND_API_KEY: z.string().min(1).optional(),
    /** Until a domain is verified in Resend, only onboarding@resend.dev works (to your own address). */
    EMAIL_FROM: z.string().default("Grounded <onboarding@resend.dev>"),
    ALLOW_UNGATED_MODELS: z.enum(["true", "false"]).default("false"),
    /** Development only: canned responses instead of real model calls. */
    DEMO_MODELS: z.enum(["true", "false"]).default("false"),
    /**
     * Learners' files (design §4.5): an S3-compatible bucket when FILES_BUCKET is set (on Railway,
     * references to the bucket's BUCKET, ENDPOINT, REGION, ACCESS_KEY_ID and SECRET_ACCESS_KEY);
     * otherwise, outside production, the folder FILES_DIR.
     */
    FILES_BUCKET: z.string().min(1).optional(),
    FILES_ENDPOINT: z.url().optional(),
    FILES_REGION: z.string().min(1).default("auto"),
    FILES_ACCESS_KEY_ID: z.string().min(1).optional(),
    FILES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    FILES_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
    /** Default: `.files` at the repo root. */
    FILES_DIR: z.string().min(1).optional(),
  })
  .refine(
    (env) =>
      !env.FILES_BUCKET ||
      (env.FILES_ENDPOINT && env.FILES_ACCESS_KEY_ID && env.FILES_SECRET_ACCESS_KEY),
    { path: ["FILES_ENDPOINT, FILES_ACCESS_KEY_ID, FILES_SECRET_ACCESS_KEY"] },
  )
  // A container's disk doesn't outlive a deploy, so production keeps files in a bucket.
  .refine((env) => env.NODE_ENV !== "production" || env.FILES_BUCKET, { path: ["FILES_BUCKET"] });

export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}. See .env.example.`);
  }
  return result.data;
}
