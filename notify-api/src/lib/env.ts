import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
  AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
  // ADR-0010: notify-api is the suite's first real second JWKS resource server —
  // tokens are structurally cross-valid between estimai-api and notify-api unless
  // both verify a shared `aud` claim. Required, not optional: ADR-0010 fires the
  // deferred ADR-0005/ADR-0007 hardening trigger now rather than deferring again.
  // Value MUST exactly match the `AUTH_AUDIENCE` the `auth` service stamps.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  // SSE stream bound lifetime (seconds) — plan.md §API contracts: "Server closes
  // the stream at MAX_STREAM_DURATION (env, ~30 min) forcing a re-ticket."
  MAX_STREAM_DURATION: z.coerce.number().int().positive().default(1800),
  PORT: z.coerce.number().int().positive().default(8081),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(
    result.error.flatten().fieldErrors,
  )) {
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
