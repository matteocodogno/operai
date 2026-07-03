import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
  AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
  // Per-estimate content size cap (bytes). Default 1 MiB. Configurable per environment.
  MAX_ESTIMATE_BYTES: z.coerce.number().int().positive().default(1048576),
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
