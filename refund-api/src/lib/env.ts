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
  // ─── authzMiddleware (T6, specs/007-refund-service, ADR-0014) ─────────────
  // Base URL of the `auth` service, used ONLY to call the Bearer-forwarded
  // `GET /authz/resolve` (T1) so refund-api can resolve the caller's own
  // effective refund permissions + entity/jobTitle locally-cached
  // (sub, perm_epoch), 30s TTL backstop. Distinct from AUTH_ISSUER (a JWT
  // claim-verification value, not necessarily dereferenceable as an HTTP
  // base — they happen to coincide in this suite's current deployment, but
  // the two concerns are kept separate here on purpose). This is a NEW env
  // var not present in T4's bootstrap `.env.example` — T19 (devops) must add
  // it there (and to `.envrc`/1Password) alongside the existing
  // AUTH_JWKS_URL/AUTH_ISSUER values; see the refund-api backend-dev T5/T6
  // report for the exact value to provision (mirrors AUTH_ISSUER's value in
  // every environment shipped so far: http://localhost:3001 locally).
  AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
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
