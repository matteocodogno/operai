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
  // refund-api is the suite's first *authorization*-enforcing resource server
  // (ADR-0014) built on top of this identity layer — capability/condition
  // enforcement is layered in by T6, not this bootstrap.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  PORT: z.coerce.number().int().positive().default(8082),
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
