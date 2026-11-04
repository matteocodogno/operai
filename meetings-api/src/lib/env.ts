import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// T10 carries only the resource-server set (plan.md § Environment). T11 grows
// this into the full schema (bucket, notify, AI providers, residency checks).

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1, "ALLOWED_ORIGINS is required")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    )
    .refine((origins) => origins.length > 0, "ALLOWED_ORIGINS is empty")
    .refine((origins) => origins.every((o) => o !== "*"), "ALLOWED_ORIGINS must not contain a wildcard"),
  // ─── Identity (JWKS resource server, ADR-0005/0010) ───────────────────────
  AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
  AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
  // Suite-wide JWT audience (ADR-0010): a token without it, or with another value, is a 401.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  // Base URL of `auth`: GET /authz/resolve (ADR-0014), POST /authz/users/identities (ADR-0039).
  AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
  PORT: z.coerce.number().int().positive().default(8085),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment variables, fix before starting:");
  for (const [key, messages] of Object.entries(result.error.flatten().fieldErrors)) {
    // Messages only: never echo a value (secrets live in this environment).
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
