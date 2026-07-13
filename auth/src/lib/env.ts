import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3001"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  JWT_PRIVATE_KEY: z.string().min(1, "JWT_PRIVATE_KEY is required"),
  JWT_PUBLIC_KEY: z.string().min(1, "JWT_PUBLIC_KEY is required"),
  // ─── JWT audience (ADR-0010, specs/005-notification-center T8) ────────────
  // Stamped as the `aud` claim on every JWT this service mints (jwt plugin's
  // `definePayload`, auth.config.ts) so resource servers can reject tokens
  // scoped to a different audience. v1 is a single suite-wide value shared
  // by every current resource server (estimai-api, notify-api) — NOT yet a
  // per-service value (see ADR-0010 "Consequences"). Whatever value is set
  // here MUST exactly match the `AUTH_AUDIENCE` each resource server verifies
  // against, or every request will fail closed once T9 turns on verification.
  // Not a secret — a config identifier — but still sourced from env, never
  // hardcoded, so every environment (local/preview/production) can share the
  // one true value without a code change.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  // Post-login fallback destination used when `redirect` is absent or fails
  // origin validation (AC-1.3). Must be the EstimAI home absolute URL.
  UI_HOME_URL: z.string().url("UI_HOME_URL must be a valid absolute URL"),
  // ─── Bootstrap admin (spec 004, T11 — AC-6.1) ───────────────────────────────
  // The ONLY account granted the `admin` role automatically, on its first
  // sign-in, with no manual DB edit. Matched against the verified OAuth
  // `user.email` in `databaseHooks.user.create.after` (auth.config.ts) —
  // never against anything a client can send in a request. Optional: an
  // environment with no bootstrap admin configured simply seeds no admin
  // automatically (an operator must grant it by hand via direct DB access,
  // since there is no `/admin/*` route usable without an existing admin).
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .email("BOOTSTRAP_ADMIN_EMAIL must be a valid email address")
    .optional(),
  // ─── notify-api internal email channel (specs/006-user-invitations, T6) ───
  // The base URL + shared service token used to call notify-api's internal,
  // NON-user-JWT endpoint `POST /system/emails` (plan.md "auth → notify-api
  // internal email send"; ADR candidate — service-to-service trust). Header
  // `X-Internal-Token: <NOTIFY_INTERNAL_TOKEN>`. NOT a per-user JWT/JWKS path
  // — a leaked token lets an attacker send arbitrary email over wellD's
  // Resend domain (plan.md risk R2), so this MUST stay internal-network-only
  // in production (Railway private networking).
  NOTIFY_INTERNAL_URL: z
    .string()
    .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
  NOTIFY_INTERNAL_TOKEN: z
    .string()
    .min(1, "NOTIFY_INTERNAL_TOKEN is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // ─── Test-auth gate ──────────────────────────────────────────────────────────
  // Enables the dev/test-only session-mint endpoint (POST /test-auth/session).
  // MUST NEVER be set in production. Only effective when NODE_ENV !== 'production'.
  // Accepted values: "true" / "1" / "yes" (case-insensitive) = enabled.
  // Any other value (including absent) = disabled.
  ENABLE_TEST_AUTH: z
    .string()
    .optional()
    .transform((v) =>
      v !== undefined && /^(true|1|yes)$/i.test(v) ? true : false,
    ),
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
