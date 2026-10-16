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
  // ─── System-to-system auth ──────────────────────────────────────────────────
  // TRANSITION ONLY (specs/016, ADR-0049). The legacy shared secret checked
  // against `X-Internal-Token` on POST /system/emails AND POST
  // /system/notifications (ADR-0011/0017/0040). Optional: while set, both
  // routes still accept it alongside a scoped service JWT; unset (or empty),
  // the header is never accepted, so retiring the token in production is
  // deleting this one variable. A short/weak value still materially weakens
  // the trust boundary, so a minimum length applies whenever it is set. The
  // variable and its middleware path leave the code in specs/016 T14.
  NOTIFY_INTERNAL_TOKEN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(32, "NOTIFY_INTERNAL_TOKEN must be at least 32 characters").optional(),
  ),
  // ─── Scoped service JWT (specs/015, ADR-0044; required since specs/016) ─────
  // `aud` that `auth` stamps on service tokens (POST /system/service-token and
  // its in-process self-mint). MUST differ from AUTH_AUDIENCE so a user JWT is
  // never a system credential and a service token is never a user credential
  // (enforced below; the process exits otherwise). Required: it is now the
  // only credential for both internal routes once the shared token is retired.
  SERVICE_AUDIENCE: z.string().min(1, "SERVICE_AUDIENCE is required"),
}).superRefine((v, ctx) => {
  if (v.SERVICE_AUDIENCE === v.AUTH_AUDIENCE) {
    ctx.addIssue({
      code: "custom",
      path: ["SERVICE_AUDIENCE"],
      message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR-0044)",
    });
  }
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
