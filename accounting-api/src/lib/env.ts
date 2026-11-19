import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// accounting-api (specs/20261119-accounting) is an authorization-enforcing resource server
// (ADR 20260716-refund-api-authorization-enforcing-resource-server) that also serves one narrow service read to
// refund-api (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…). It calls
// no other service but `auth` (`GET /authz/resolve`) and, on demand, the one fixed BAZG host,
// so there is no service credential of its own here and no other *_INTERNAL_URL.
//
// Every variable is required except the three with a default (PORT, NODE_ENV, ACCOUNTING_FX_SOURCE).
// A missing or malformed one exits 1 naming the variable, never its value (secrets live in this
// environment): SERVICE_AUDIENCE in particular is required, because without it no `/system/*` caller
// could be told from a stranger and the service must not start half-configured.

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // CORS: the shell's origin only (the accounting remote runs inside the shell). `*` would
    // reflect any origin with credentials, so it is refused outright.
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
    // ─── Identity (JWKS resource server, ADR 20260703-jwt-resource-server-remote-jwks) ─────────────────
    AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
    AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
    // Suite-wide JWT audience (ADR 20260713-jwt-audience-claim-enforcement). A token missing the claim, or
    // carrying a different value, is rejected with 401.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // Base URL of the `auth` service, used ONLY for the Bearer-forwarded `GET /authz/resolve`
    // (ADR 20260716-refund-api-authorization-enforcing-resource-server). Distinct from AUTH_ISSUER, a claim value.
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    PORT: z.coerce.number().int().positive().default(8089),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // ─── Service credentials accepted on /system/* (ADR 20261006-scoped-service-jwt-fourth-notify-caller) ───
    // The `aud` of the scoped service JWTs `auth` mints (`POST /system/service-token`): byte-identical to
    // auth's, and different from AUTH_AUDIENCE so a user JWT is never a system credential.
    SERVICE_AUDIENCE: z.string().min(1, "SERVICE_AUDIENCE is required"),
    // ─── Monthly exchange rates (ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-…) ───────────
    // Where `src/rates/` gets the federal monthly average rates: `bazg` (default) calls the one fixed BAZG
    // host on demand, `off` never makes an outbound call and records every attempt as `disabled` (offline
    // dev, e2e: rates are typed by hand). Not a URL on purpose: the host is a constant in the source module,
    // so no configuration can turn the fetch into a request to somewhere else (SSRF guard). Any other value
    // fails startup.
    ACCOUNTING_FX_SOURCE: z.enum(["bazg", "off"]).default("bazg"),
  })
  .superRefine((val, ctx) => {
    if (val.SERVICE_AUDIENCE === val.AUTH_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SERVICE_AUDIENCE"],
        message:
          "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR 20261006-scoped-service-jwt-fourth-notify-caller)",
      });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(z.flattenError(result.error).fieldErrors)) {
    // Messages only — never echo a value (secrets live in this environment).
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
