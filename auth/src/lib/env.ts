import { z } from "zod";
import { parseServiceClients } from "../system/serviceClients";
import { parseAllowedDomains, reservedTestDomains } from "../signup/allowedDomains";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3001"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  JWT_PRIVATE_KEY: z.string().min(1, "JWT_PRIVATE_KEY is required"),
  JWT_PUBLIC_KEY: z.string().min(1, "JWT_PUBLIC_KEY is required"),
  // ─── JWT audience (ADR 20260713-jwt-audience-claim-enforcement, specs/20260713-notification-center T8) ────────────
  // Stamped as the `aud` claim on every JWT this service mints (jwt plugin's
  // `definePayload`, auth.config.ts) so resource servers can reject tokens
  // scoped to a different audience. v1 is a single suite-wide value shared
  // by every current resource server (estimai-api, notify-api) — NOT yet a
  // per-service value (see ADR 20260713-jwt-audience-claim-enforcement "Consequences"). Whatever value is set
  // here MUST exactly match the `AUTH_AUDIENCE` each resource server verifies
  // against, or every request will fail closed once T9 turns on verification.
  // Not a secret — a config identifier — but still sourced from env, never
  // hardcoded, so every environment (local/preview/production) can share the
  // one true value without a code change.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim())),
  // Post-login fallback destination used when `redirect` is absent or fails
  // origin validation (AC-1.3). Must be the EstimAI home absolute URL.
  UI_HOME_URL: z.string().url("UI_HOME_URL must be a valid absolute URL"),
  // ─── Bootstrap admin (spec 004, T11 — AC-6.1) ───────────────────────────────
  // The ONLY account granted the `admin` role automatically, on its first
  // sign-in, with no manual DB edit. Matched against the verified OAuth
  // `user.email` in `databaseHooks.user.create.after` (auth.config.ts) —
  // never against anything a client can send in a request. Optional: an
  // environment with no bootstrap admin configured simply seeds no admin
  // automatically (an operator must grant it by hand via direct DB access,
  // since there is no `/admin/*` route usable without an existing admin).
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .email("BOOTSTRAP_ADMIN_EMAIL must be a valid email address")
    .optional(),
  // ─── Sign-up gate (specs/20261105-signup-gate, ADR 20261105-access-only-by-invitation-waiting-list) ─────────────────────────────────────
  // Only these domains may join the waiting list or be invited. Deployment
  // configuration, not an admin setting. Required: missing or malformed exits.
  ALLOWED_SIGNUP_DOMAINS: z.string().transform((value, ctx) => {
    try {
      return parseAllowedDomains(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ALLOWED_SIGNUP_DOMAINS ${error instanceof Error ? error.message : "is invalid"}`,
      });
      return z.NEVER;
    }
  }),
  // ─── notify-api internal email channel (specs/20260713-user-invitations, T6) ───
  // The base URL of notify-api's internal, NON-user-JWT endpoint
  // `POST /system/emails`. Authentication is `auth`'s own service JWT, minted
  // in process (specs/20261013-notify-service-credentials, ADR 20261013-auth-mints-own-service-credential-in-process/0049) — there is no shared token any more.
  NOTIFY_INTERNAL_URL: z
    .string()
    .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
  // ─── App-access eligibility check (specs/20260807-estimate-sharing, T1/T2) ───────
  // `POST /authz/app-access-check` is a decision endpoint directly callable by
  // any end user holding their own JWT (plan.md "The catch, and how it is
  // resolved") — it must never let a caller distinguish "no such user" from
  // "user exists, no app access" by response time. FLOOR is the minimum
  // wall-clock time every `eligible:false` response takes regardless of which
  // negative cause produced it (`await sleep(max(0, floor - elapsed))`); the
  // success path is not floored. RATE_LIMIT/_WINDOW_MS bound the suite's
  // FIRST rate limiter (plan.md "Rate limiting") — 40 attempts per caller
  // `sub` per window, sliding-window in-process (rateLimiter.ts), since this
  // is the directly-callable surface behind estimai-api's own 20/10min limit.
  APP_ACCESS_CHECK_FLOOR_MS: z.coerce.number().int().nonnegative().default(150),
  APP_ACCESS_CHECK_RATE_LIMIT: z.coerce.number().int().positive().default(40),
  APP_ACCESS_CHECK_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600000),
  // ─── Identities rate limit (specs/20260807-estimate-sharing, T27) ────────────────
  // `POST /authz/users/identities` (T3) shipped WITHOUT rate limiting — a
  // documented drift against plan.md's API contract, which lists `429 +
  // Retry-After` for this route, because neither plan.md nor T1 provisioned a
  // limit/window for it (T1 only introduced APP_ACCESS_CHECK_* above). T27
  // closes that gap by reusing T1's `createSlidingWindowRateLimiter`
  // (rateLimiter.ts) with its OWN limit/window, keyed by caller `sub` exactly
  // like APP_ACCESS_CHECK_RATE_LIMIT/_WINDOW_MS above. 120/10min sits far
  // above real usage (roughly one batched call per list render) while still
  // bounding the 100-id-per-call fan-out. Unlike APP_ACCESS_CHECK_*, this
  // route gets NO response-time floor — it resolves ids the caller already
  // holds and leaks no existence signal (ADR 20260807-live-identity-resolution-by-id-fail-soft), so there is nothing to
  // equalise; a floor here would only slow every list render.
  IDENTITIES_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  IDENTITIES_RATE_WINDOW_MS: z.coerce.number().int().positive().default(600000),
  // ─── Service tokens (specs/20261006-hardware-inventory, T4; ADR 20261006-scoped-service-jwt-fourth-notify-caller) ────────────
  // `POST /system/service-token` mints a short-lived RS256 JWT for a SERVICE
  // principal (today: `inventory-api` -> notify-api's `/system/notifications`).
  //
  // SERVICE_AUDIENCE is the `aud` stamped on those tokens. It MUST differ from
  // AUTH_AUDIENCE (checked below, startup exits otherwise): that distinctness
  // is what makes a service token useless on every user route and a user JWT
  // useless on every system route. Whatever is set here must exactly match the
  // `SERVICE_AUDIENCE` notify-api verifies against.
  //
  // SERVICE_CLIENTS is a JSON object keyed by client id (format, limits and the
  // scope allowlist: src/system/serviceClients.ts). It carries SECRETS — keep it
  // in 1Password / the deploy environment only; it is never logged, and a parse
  // failure names the rule that failed, never a value.
  //
  // SERVICE_AUDIENCE is REQUIRED (specs/20261013-notify-service-credentials, ADR 20261013-auth-mints-own-service-credential-in-process): `auth` mints its own
  // `system:auth` credential with it, regardless of any configured client.
  // SERVICE_CLIENTS stays OPTIONAL: with no clients configured the endpoint
  // authenticates nobody (every call is the same 401).
  SERVICE_AUDIENCE: z
    .string({ error: (issue) => (issue.input === undefined ? "SERVICE_AUDIENCE is required" : undefined) })
    .min(1, "SERVICE_AUDIENCE must not be empty"),
  SERVICE_CLIENTS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const parsed = parseServiceClients(raw);
      if (!parsed.ok) {
        for (const message of parsed.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER;
      }
      return parsed.clients;
    }),
  // ─── Limits of the two /system endpoints (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service) ──────────
  // `POST /system/service-token` and `POST /system/users/contact` verify the
  // credential FIRST, then consult exactly one count: a valid credential is
  // counted against its own calling service, an invalid one against its source
  // address (one counter shared by both endpoints). See system/systemRateLimits.ts.
  // All optional; they share one window. A legitimate service mints about 3
  // tokens per 10 minutes, and notify-api does one lookup per email notice and
  // at most one per push recipient per 30 s, so the defaults are far above use.
  SERVICE_TOKEN_SERVICE_LIMIT: z.coerce.number().int().positive().default(300),
  USERS_CONTACT_SERVICE_LIMIT: z.coerce.number().int().positive().default(600),
  SYSTEM_INVALID_CREDENTIAL_LIMIT: z.coerce.number().int().positive().default(20),
  SYSTEM_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  // SERVICE_TOKEN_RATE_LIMIT / SERVICE_TOKEN_RATE_WINDOW_MS (one address-keyed bucket for the whole
  // suite, the D-1 starvation) are RETIRED: not read, see RETIRED_SYSTEM_RATE_VARS below.
  // ─── User directory (specs/20261006-hardware-inventory, T5; ADR 20261006-user-directory-endpoint-capability-gated) ────────────
  // `GET /authz/users/directory` returns the roster of active users to holders
  // of the inventory `asset:manage` permission. Unlike app-access-check there
  // is no negative to equalise, so there is no response-time floor: the controls
  // are WHO may ask (the capability gate) and HOW OFTEN (this limit, keyed by
  // caller `sub`, counted on every attempt). The UI fetches the list once per
  // assign dialog / filter, so 60 per 10 minutes is far above real use.
  DIRECTORY_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  DIRECTORY_RATE_WINDOW_MS: z.coerce.number().int().positive().default(600000),
  // ─── Legal-entity registry throttle (specs/20261117-legal-entities, T52; plan G9, security review F3) ────────────
  // Counted per user id, after authorisation and before the body is read. Save and restore share
  // LEGAL_ENTITY_WRITE_RATE_LIMIT; the dry-run check (T55) has its own LEGAL_ENTITY_CHECK_RATE_LIMIT. The window
  // is one for both. In-memory per replica like every limiter here (N replicas = N x the limit); a compose e2e
  // stack sets a high limit so its many saves are not throttled.
  LEGAL_ENTITY_WRITE_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LEGAL_ENTITY_CHECK_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  LEGAL_ENTITY_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  // ─── Legal-entity notice, outside mailbox (specs/20261117-legal-entities, T58; US-9 AC-9.10; plan G3/G4) ────────
  // One address outside the suite that gets the notice of a protected change by email only (both entities), so that
  // removing people from roles cannot silence it. Optional: unset (or blank, as `VAR=` leaves it) = no outside
  // recipient and nothing else changes. Read when the version is stored (is there an outside row?) and again when the
  // notice is sent; the address itself is never written to the database or the audit log. A malformed value stops
  // startup naming the variable, never the value.
  LEGAL_ENTITY_NOTICE_EMAIL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().email("LEGAL_ENTITY_NOTICE_EMAIL must be a valid email address").optional(),
  ),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // ─── Test-auth gate ──────────────────────────────────────────────────────────
  // Enables the dev/test-only session-mint endpoint (POST /test-auth/session).
  // MUST NEVER be set in production. Only effective when NODE_ENV !== 'production'.
  // Accepted values: "true" / "1" / "yes" (case-insensitive) = enabled.
  // Any other value (including absent) = disabled.
  ENABLE_TEST_AUTH: z
    .string()
    .optional()
    .transform((v) =>
      v !== undefined && /^(true|1|yes)$/i.test(v) ? true : false,
    ),
}).superRefine((value, ctx) => {
  // ADR 20261006-scoped-service-jwt-fourth-notify-caller point 2: a service token must never be accepted on a user route,
  // so its audience must differ from the user audience. Fail at startup.
  if (value.SERVICE_AUDIENCE === value.AUTH_AUDIENCE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_AUDIENCE"],
      message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR 20261006-scoped-service-jwt-fourth-notify-caller)",
    });
  }
  // specs/20261105-signup-gate plan.md amendment 2026-11-05: a reserved test domain (operai.test, …) is
  // local/e2e configuration only; allowing one in production would let anyone who can
  // register such an address past the gate.
  // T14: also refused unless the test-auth gate is on, so the allowance is as narrow as test-auth itself.
  if (value.NODE_ENV === "production" || !value.ENABLE_TEST_AUTH) {
    const reserved = reservedTestDomains(value.ALLOWED_SIGNUP_DOMAINS);
    if (reserved.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALLOWED_SIGNUP_DOMAINS"],
        message: `must not contain a reserved test domain unless ENABLE_TEST_AUTH is true outside production (${reserved.join(", ")})`,
      });
    }
  }
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(
    z.flattenError(result.error).fieldErrors,
  )) {
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

// Retired by specs/20261111-push-notifications US-7 (ADR 20261112-system-endpoints-limited-per-verified-service). Ignored, never reused under a new meaning: an override sized for
// the old per-address rule (20, or the runbook's 60) would silently cap a service below its allowance.
// A warning rather than a refusal: an unknown variable stopping `auth` is a deploy-order hazard (ADR 20261108-crm-pushes-deal-links-to-estimai).
// Names only, never a value.
const RETIRED_SYSTEM_RATE_VARS = ["SERVICE_TOKEN_RATE_LIMIT", "SERVICE_TOKEN_RATE_WINDOW_MS"] as const;
const retiredPresent = RETIRED_SYSTEM_RATE_VARS.filter((name) => process.env[name] !== undefined);
if (retiredPresent.length > 0) {
  console.warn(
    `[env] ${retiredPresent.join(", ")} ignored: retired by the per-service system limits ` +
      "(SERVICE_TOKEN_SERVICE_LIMIT, USERS_CONTACT_SERVICE_LIMIT, SYSTEM_INVALID_CREDENTIAL_LIMIT, SYSTEM_RATE_WINDOW_MS). Delete them.",
  );
}

export const env = result.data;
export type Env = typeof env;
