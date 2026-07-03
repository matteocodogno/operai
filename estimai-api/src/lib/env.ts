import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  // T3 adds AUTH_JWKS_URL and AUTH_ISSUER here (optional for T1 skeleton).
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().url().optional(),
  // T5 adds MAX_ESTIMATE_BYTES here (optional for T1 skeleton).
  MAX_ESTIMATE_BYTES: z.coerce.number().int().positive().optional(),
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
