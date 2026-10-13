import { z } from "zod";
import { parseServiceClients } from "../system/serviceClients";

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
  // ─── JWT audience (ADR-0010, specs/005-notification-center T8) ────────────
  // Stamped as the `aud` claim on every JWT this service mints (jwt plugin's
  // `definePayload`, auth.config.ts) so resource servers can reject tokens
  // scoped to a different audience. v1 is a single suite-wide value shared
  // by every current resource server (estimai-api, notify-api) — NOT yet a
  // per-service value (see ADR-0010 "Consequences"). Whatever value is set
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
  // ─── notify-api internal email channel (specs/006-user-invitations, T6) ───
  // The base URL + shared service token used to call notify-api's internal,
  // NON-user-JWT endpoint `POST /system/emails` (plan.md "auth → notify-api
  // internal email send"; ADR candidate — service-to-service trust). Header
  // `X-Internal-Token: <NOTIFY_INTERNAL_TOKEN>`. NOT a per-user JWT/JWKS path
  // — a leaked token lets an attacker send arbitrary email over wellD's
  // Resend domain (plan.md risk R2), so this MUST stay internal-network-only
  // in production (Railway private networking).
  NOTIFY_INTERNAL_URL: z
    .string()
    .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
  // Security-review fix #6 (specs/006-user-invitations, A05): mirror
  // notify-api's own `.min(32)` on this SAME shared secret — a weak/truncated
  // value must fail closed on either side of the trust boundary, not just
  // the receiving service's.
  NOTIFY_INTERNAL_TOKEN: z
    .string()
    .min(32, "NOTIFY_INTERNAL_TOKEN must be at least 32 characters"),
  // ─── App-access eligibility check (specs/013-estimate-sharing, T1/T2) ───────
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
  // ─── Identities rate limit (specs/013-estimate-sharing, T27) ────────────────
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
  // holds and leaks no existence signal (ADR-0039), so there is nothing to
  // equalise; a floor here would only slow every list render.
  IDENTITIES_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  IDENTITIES_RATE_WINDOW_MS: z.coerce.number().int().positive().default(600000),
  // ─── Service tokens (specs/015-hardware-inventory, T4; ADR-0044) ────────────
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
  // SERVICE_AUDIENCE is REQUIRED (specs/016, ADR-0048): `auth` mints its own
  // `system:auth` credential with it, regardless of any configured client.
  // SERVICE_CLIENTS stays OPTIONAL: with no clients configured the endpoint
  // authenticates nobody (every call is the same 401).
  SERVICE_AUDIENCE: z
    .string({ required_error: "SERVICE_AUDIENCE is required" })
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
  // Rate limit for the unauthenticated-by-design token endpoint, keyed by the
  // caller's network address (see system/serviceToken.routes.ts). A legitimate
  // client mints about one token per 4 minutes, so the default is generous
  // enough never to bite a healthy caller across restarts and instances.
  SERVICE_TOKEN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  SERVICE_TOKEN_RATE_WINDOW_MS: z.coerce.number().int().positive().default(600000),
  // ─── User directory (specs/015-hardware-inventory, T5; ADR-0047) ────────────
  // `GET /authz/users/directory` returns the roster of active users to holders
  // of the inventory `asset:manage` permission. Unlike app-access-check there
  // is no negative to equalise, so there is no response-time floor: the controls
  // are WHO may ask (the capability gate) and HOW OFTEN (this limit, keyed by
  // caller `sub`, counted on every attempt). The UI fetches the list once per
  // assign dialog / filter, so 60 per 10 minutes is far above real use.
  DIRECTORY_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  DIRECTORY_RATE_WINDOW_MS: z.coerce.number().int().positive().default(600000),
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
  // ADR-0044 point 2: a service token must never be accepted on a user route,
  // so its audience must differ from the user audience. Fail at startup.
  if (value.SERVICE_AUDIENCE === value.AUTH_AUDIENCE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_AUDIENCE"],
      message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR-0044)",
    });
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
