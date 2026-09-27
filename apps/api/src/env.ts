import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  KEY_VAULT_MASTER_KEYS: z.string().min(1),
  KEY_VAULT_ACTIVE_KID: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Where the web app is served; the API is reached through it at /api. */
  APP_URL: z.url().default("http://localhost:5173"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8787),
  /** Magic links go by email when set; to the console otherwise. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Until a domain is verified in Resend, only onboarding@resend.dev works (to your own address). */
  EMAIL_FROM: z.string().default("Grounded <onboarding@resend.dev>"),
  ALLOW_UNGATED_MODELS: z.enum(["true", "false"]).default("false"),
  /** Development only: canned responses instead of real model calls. */
  DEMO_MODELS: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}. See .env.example.`);
  }
  return result.data;
}
