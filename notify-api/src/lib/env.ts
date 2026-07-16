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
  // ─── Email channel (T2, specs/006-user-invitations, ADR-0011) ──────────────
  // EMAIL_ENABLED gates whether the `email` channel actually calls Resend.
  // Default OFF: test/local runs never need a real Resend key — with it off,
  // the channel stubs the send and still records an EmailDelivery row
  // (status "sent", a synthetic id) so callers/tests observe the same shape.
  //
  // NOTE: deliberately NOT z.coerce.boolean() — that coerces via Boolean(str),
  // so the literal string "false" (any non-empty string) would parse to
  // `true` and silently enable real Resend sends. Only the literal string
  // "true" (case-insensitive) is truthy; anything else (including unset,
  // "false", "0") is false.
  EMAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === "true"),
  // Required only when EMAIL_ENABLED is true (enforced below, not here) —
  // optional at the schema level so test/local can leave them unset.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  // ─── System-to-system auth (T3, specs/006-user-invitations, ADR-0011;
  // reused by T3, specs/007-refund-service, ADR-0017 for a second internal
  // caller/route) ──────────────────────────────────────────────────────────
  // Shared secret checked by internalTokenMiddleware against the
  // `X-Internal-Token` header on POST /system/emails AND POST
  // /system/notifications ONLY — never accepted on any jwtMiddleware-protected
  // route, and jwtMiddleware never accepts this value (the two auth
  // mechanisms are mutually exclusive by route, not layered, per ADR-0011).
  // Required unconditionally — neither /system/* route has a meaningful
  // "disabled" mode the way EMAIL_ENABLED does. A short/weak value materially
  // weakens the entire trust boundary (ADR-0011 Risk, widened by ADR-0017:
  // "leaked token = arbitrary email AND arbitrary in-app/SSE push"), so a
  // minimum length is enforced here rather than left to operational
  // discipline alone.
  NOTIFY_INTERNAL_TOKEN: z
    .string()
    .min(32, "NOTIFY_INTERNAL_TOKEN must be at least 32 characters"),
}).superRefine((v, ctx) => {
  // Cross-field: EMAIL_ENABLED=true means real sends are attempted, so the
  // Resend credentials become mandatory (they stay optional at rest so
  // test/local can run with the channel stubbed, per ADR-0011/T2).
  if (v.EMAIL_ENABLED) {
    if (!v.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required when EMAIL_ENABLED=true",
      });
    }
    if (!v.RESEND_FROM) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_FROM"],
        message: "RESEND_FROM is required when EMAIL_ENABLED=true",
      });
    }
  }
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
