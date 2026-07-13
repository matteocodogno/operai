import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
  AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
  // Suite-wide JWT audience value (ADR-0010). Must match the `audience` claim
  // stamped by the auth service's jwt plugin. A token missing this claim, or
  // carrying a different value, is rejected with 401 by jwtMiddleware.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  // Per-estimate content size cap (bytes). Default 1 MiB. Configurable per environment.
  MAX_ESTIMATE_BYTES: z.coerce.number().int().positive().default(1048576),
  // Raw request-body size cap for the bulk-import endpoint (bytes).
  // Default: min(MAX_ESTIMATE_BYTES × 200 + 64 KiB envelope, 32 MiB hard ceiling).
  // 32 MiB is chosen because this is an internal/behind-auth service; the ceiling
  // prevents a single unbounded upload even if all 200 elements are legitimately
  // near-max, while remaining a comfortable DoS bound for an authenticated endpoint.
  // Override this env var only if you intentionally change MAX_ESTIMATE_BYTES above.
  MAX_IMPORT_REQUEST_BYTES: z.coerce.number().int().positive().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
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
