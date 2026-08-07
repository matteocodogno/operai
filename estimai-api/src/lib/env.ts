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

  // ─── Estimate sharing outbound clients (T5, specs/013-estimate-sharing) ───
  //
  // Base URL of the `auth` service, used ONLY to call the Bearer-FORWARDED
  // (never a service credential) `POST /authz/app-access-check` (eligibility
  // decision, fails CLOSED on error — plan.md "Why estimai-api does NOT
  // become an authorization-enforcing resource server") and
  // `POST /authz/users/identities` (display-identity resolution, fails SOFT
  // to `status:"unknown"` — src/lib/authClient.ts). Distinct concept from
  // AUTH_ISSUER/AUTH_JWKS_URL (JWT claim-verification values, not necessarily
  // dereferenceable as an HTTP base), mirrors refund-api's AUTH_BASE_URL.
  AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),

  // ─── notify-api internal call (T5/T10, ADR-0017, ADR-0040) ────────────────
  //
  // estimai-api becomes the THIRD holder of this shared secret (plan.md
  // "Notifications (US-7) — the third internal caller"). MUST be
  // byte-for-byte identical to auth's / refund-api's / notify-api's own
  // NOTIFY_INTERNAL_TOKEN. Best-effort — src/lib/notify.ts NEVER throws.
  NOTIFY_INTERNAL_TOKEN: z
    .string()
    .min(32, "NOTIFY_INTERNAL_TOKEN must be at least 32 characters"),
  // notify-api's base URL for this internal call. Production (Railway):
  // notify-api's PRIVATE-networking address, NOT its public domain — this
  // call should never traverse the public internet (mirrors refund-api's
  // NOTIFY_INTERNAL_URL posture).
  NOTIFY_INTERNAL_URL: z
    .string()
    .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),

  // ─── Third-party lookup timing/rate-limit knobs (plan.md "The third-party
  // lookup", AC-1.2) ──────────────────────────────────────────────────────
  //
  // Response-time floor applied to the WHOLE generic-rejection response of
  // `POST /estimates/{id}/collaborators` (both AC-1.2 causes), covering the
  // round trip to `auth`'s own floor. Default 300ms.
  SHARE_LOOKUP_FLOOR_MS: z.coerce.number().int().nonnegative().default(300),
  // In-process sliding-window rate limit for `POST /estimates/{id}/collaborators`,
  // counted on EVERY attempt (success, duplicate, self, and generic rejection
  // alike). Defaults: 20 attempts / 10 minutes per caller `sub`.
  SHARE_ADD_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  SHARE_ADD_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600000),
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
