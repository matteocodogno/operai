/**
 * POST /authz/app-access-check — the third-party app-access ELIGIBILITY
 * DECISION endpoint (T2, specs/013-estimate-sharing — refs AC-1.1, AC-1.2;
 * plan.md "The third-party lookup (AC-1.1/AC-1.2) — the hard problem";
 * ADR-0035).
 *
 * Answers, for a caller who already holds `(appId,"access")` themselves:
 * "is this email address an active Operai user who holds `appId` app
 * access?" — but answers it as a DECISION, never a FACT. The endpoint is
 * directly reachable by any end user holding their own Bearer JWT (no CORS
 * protection against a non-browser client), so if it distinguished "no such
 * user" from "user exists, no access" it would be an enumeration oracle for
 * anyone technical enough to bypass the UI. Both negative causes therefore
 * collapse to the SAME body at the source:
 *
 *   200 → { eligible: true, userId }
 *   200 → { eligible: false }   ── no-such-user, soft-deleted target, AND
 *                                  user-exists-but-lacks-access are ALL this
 *                                  exact body. No other field, ever.
 *
 * Three non-negotiable properties (plan.md, this task's `done when`):
 *
 *   1. The `eligible:false` body has exactly one key on every negative path.
 *   2. The work path is EQUALISED: the email probe is a single parameterised
 *      `lower(email) = $1 AND "deletedAt" IS NULL LIMIT 1` query against T1's
 *      functional index (`user_email_lower_idx`) — folding "no such user"
 *      and "soft-deleted" into the SAME zero-row result, so those two causes
 *      are literally the same query outcome, not just similarly-timed ones.
 *      `resolveEffectivePermissions` then runs on EVERY path — for a real
 *      hit, against the resolved target id; for a miss, against a fixed
 *      non-existent SENTINEL id, with the result discarded — so both branches
 *      pay for exactly one probe + one resolver call. NEVER Prisma
 *      `mode:"insensitive"` (emits ILIKE, cannot use the functional index,
 *      would seq-scan and reintroduce a timing delta).
 *   3. A response-time floor (`APP_ACCESS_CHECK_FLOOR_MS`) is applied to
 *      EVERY `eligible:false` response, regardless of cause. The success path
 *      is never floored (positive/negative is allowed to be observable; only
 *      the two negative causes must be indistinguishable from each other).
 *
 * Caller gate (who may ask): the caller must themselves hold `(appId,
 * "access")` — resolved via the existing `resolveEffectivePermissions`, no
 * new catalog permission — AND must not be soft-deleted (ADR-0012's residual-
 * JWT window means a just-deleted caller's token can still verify). Either
 * failure → 403 `app_access_required`. Only someone who can use `appId`
 * themselves may ask about `appId` eligibility for someone else.
 *
 * `POST`, never `GET`: the probed email must never enter a URL, a query
 * string, an access log, or a `Referer` header (requestLogger.ts logs
 * method+path only — no body — so this holds structurally too).
 *
 * Rate limiting: `APP_ACCESS_CHECK_RATE_LIMIT` attempts per
 * `APP_ACCESS_CHECK_RATE_WINDOW_MS` per caller `sub` (T1's
 * `createSlidingWindowRateLimiter`) — this is the suite's first rate limiter,
 * and this endpoint is the directly-callable surface behind `estimai-api`'s
 * own tighter per-add limit (plan.md "Rate limiting").
 *
 * Evaluation order: 401 (bearerJwtMiddleware) → 400 (malformed appId/email —
 * says nothing about accounts) → 403 (caller gate) → 429 (rate limit) →
 * the equalised-work lookup + floor → 200.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect } from "effect";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { createSlidingWindowRateLimiter } from "../lib/rateLimiter";
import { resolveEffectivePermissions } from "./resolver";
import { bearerJwtMiddleware, type ResolveAuthVariables } from "./resolveAuth.middleware";

const ACCESS_ACTION = "access";

// A fixed, syntactically-valid-but-never-real id used SOLELY to give the
// no-such-user/soft-deleted branch the same resolver query shape as the
// real-hit branch (plan.md "Timing identity" point 1). It is never looked up
// against the `user` table — `resolveEffectivePermissions` only ever queries
// `permission_rule`/`role` tables filtered by this id, which simply match
// nothing.
const APP_ACCESS_CHECK_SENTINEL_USER_ID = "app-access-check-sentinel-000000000000";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AppAccessCheckRequestSchema = z.object({
  appId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, "appId must match ^[a-z0-9-]{1,64}$"),
  email: z.string().trim().max(320).email(),
});

// Two DISTINCT literal shapes, not one object with an optional `userId` —
// the eligible:false branch below constructs a plain `{ eligible: false }`
// object with no `userId` key at all (not even `undefined`), so there is
// nothing for a future careless edit to accidentally leak onto it via this
// schema's typing.
const EligibleResponseSchema = z.union([
  z.object({ eligible: z.literal(true), userId: z.string() }),
  z.object({ eligible: z.literal(false) }),
]);

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

const ProblemJsonWithCodeSchema = ProblemJsonSchema.extend({
  code: z.string(),
});

// ─── Route ────────────────────────────────────────────────────────────────────

const postAppAccessCheckRoute = createRoute({
  method: "post",
  path: "/authz/app-access-check",
  tags: ["Authorization"],
  summary: "Check whether an email address belongs to an eligible app user (decision, not a fact)",
  description:
    "Returns eligible:true/userId or eligible:false — the SAME body, " +
    "status, and (quantised) timing for no-such-user, soft-deleted-target, " +
    "and lacks-app-access. POST so the probed email never reaches a URL. " +
    "Caller must hold (appId,\"access\") themselves and must not be " +
    "soft-deleted.",
  request: {
    body: {
      content: { "application/json": { schema: AppAccessCheckRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: EligibleResponseSchema } },
      description: "Eligibility decision — never distinguishes WHY a negative result occurred",
    },
    400: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Malformed appId or email syntax",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Missing, invalid, expired, or wrong-issuer/audience Bearer token",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Caller lacks (appId,\"access\") or is soft-deleted",
    },
    429: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Caller exceeded the rate limit",
    },
  },
});

// A dedicated OpenAPIHono instance with a Bearer-JWT-gated defaultHook so a
// malformed body surfaces as Problem JSON (matches catalog.routes.ts /
// audit.routes.ts's established pattern in this service).
export const appAccessCheckRouter = new OpenAPIHono<{
  Variables: ResolveAuthVariables;
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

appAccessCheckRouter.use("/authz/app-access-check", bearerJwtMiddleware);

// The suite's FIRST rate limiter (plan.md R7) — module-scope singleton so
// every request against this single process shares one sliding-window map,
// keyed by caller `sub`.
const appAccessCheckLimiter = createSlidingWindowRateLimiter({
  limit: env.APP_ACCESS_CHECK_RATE_LIMIT,
  windowMs: env.APP_ACCESS_CHECK_RATE_WINDOW_MS,
});

appAccessCheckRouter.openapi(postAppAccessCheckRoute, async (c) => {
  const start = Date.now();
  const callerId = c.get("callerId");
  const { appId, email } = c.req.valid("json");

  // ── 403: caller gate — must hold (appId,"access") AND not be soft-deleted.
  const [callerRow, callerPermissions] = await Promise.all([
    db.user.findUnique({ where: { id: callerId }, select: { deletedAt: true } }),
    Effect.runPromise(resolveEffectivePermissions(callerId)),
  ]);

  const callerHoldsAppAccess = callerPermissions.some(
    (permission) => permission.resource === appId && permission.action === ACCESS_ACTION,
  );

  if (!callerRow || callerRow.deletedAt !== null || !callerHoldsAppAccess) {
    return c.json(
      {
        type: "https://httpstatuses.com/403",
        title: "Forbidden",
        status: 403,
        detail: `You must hold access to '${appId}' yourself to check another user's eligibility.`,
        instance: c.req.path,
        code: "app_access_required",
      },
      403,
    );
  }

  // ── 429: rate limit, per caller sub.
  const rateLimitResult = appAccessCheckLimiter.consume(callerId);
  if (!rateLimitResult.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1000));
    c.header("Retry-After", String(retryAfterSeconds));
    return c.json(
      {
        type: "https://httpstatuses.com/429",
        title: "Too Many Requests",
        status: 429,
        detail: "Too many app-access-check attempts. Try again later.",
        instance: c.req.path,
        code: "rate_limited",
      },
      429,
    );
  }

  // ── The equalised-work eligibility lookup (plan.md "Timing identity").
  // Parameterised `lower(email) = $1` against the T1 functional index —
  // deliberately NOT Prisma's `mode:"insensitive"` (emits ILIKE, cannot use
  // that index). `deletedAt IS NULL` is folded into the SAME query, so
  // "no such user" and "soft-deleted user" are the identical zero-row
  // result — not merely similarly timed, but the same query outcome.
  const normalizedEmail = email.trim().toLowerCase();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user"
    WHERE lower(email) = ${normalizedEmail} AND "deletedAt" IS NULL
    LIMIT 1
  `;

  let eligible = false;
  let userId: string | undefined;

  if (rows.length === 0) {
    // No such active user. Still pay for a resolver call, against a fixed
    // sentinel id, so this branch's total work matches the hit branch below
    // (one probe + one resolveEffectivePermissions call either way). Result
    // discarded — it is never used for anything.
    await Effect.runPromise(resolveEffectivePermissions(APP_ACCESS_CHECK_SENTINEL_USER_ID));
  } else {
    const targetId = rows[0]!.id;
    const targetPermissions = await Effect.runPromise(resolveEffectivePermissions(targetId));
    const targetHoldsAppAccess = targetPermissions.some(
      (permission) => permission.resource === appId && permission.action === ACCESS_ACTION,
    );
    if (targetHoldsAppAccess) {
      eligible = true;
      userId = targetId;
    }
  }

  if (!eligible) {
    // Response-time floor — every eligible:false response, regardless of
    // which of the two causes produced it, takes at least this long. The
    // success path below is never floored.
    const elapsedMs = Date.now() - start;
    const remainingMs = env.APP_ACCESS_CHECK_FLOOR_MS - elapsedMs;
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }
    // Exactly one key. No `userId`, not even `undefined`.
    return c.json({ eligible: false as const }, 200);
  }

  return c.json({ eligible: true as const, userId: userId! }, 200);
});
