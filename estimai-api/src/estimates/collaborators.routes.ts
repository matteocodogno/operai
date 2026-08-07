/**
 * GET / POST /estimates/{id}/collaborators — the collaborator "add path"
 * (T8, specs/013-estimate-sharing — refs AC-1.1, AC-1.2, AC-1.3, AC-1.4,
 * AC-1.5, AC-5.4; plan.md "API contracts — estimai-api — new").
 *
 * ALSO — PATCH /estimates/{id}/collaborators/{collaboratorId},
 * DELETE /estimates/{id}/collaborators/{collaboratorId}, and
 * DELETE /estimates/{id}/collaborators/me — manage / revoke / leave (T9,
 * specs/013-estimate-sharing — refs AC-5.1, AC-5.2, AC-5.3, AC-6.1, AC-6.2).
 * See the dedicated "T9" section further down this file for that trio's
 * documentation (registration-order constraint, notification scope
 * boundary, next-request-only enforcement).
 *
 * Routes attach to the existing `estimatesRouter` (not a new router) per
 * plan.md's contract header — "all under the existing estimatesRouter,
 * jwtMiddleware + 2 MiB bodyLimit" — via an exported `registerCollaboratorRoutes(router)`
 * function that `index.ts` calls once, AFTER importing `estimatesRouter`
 * from `./estimates.routes` (so that router's `bodyLimit`/`jwtMiddleware`
 * `.use("*", …)` calls have already run — Hono composes middleware in
 * registration order regardless of which module made each call, so this
 * ordering is what makes the inherited chain apply to these routes too).
 *
 * DELIBERATELY a registration FUNCTION with INJECTABLE `auth`-client deps,
 * not a module-top-level side effect that imports and mutates a shared
 * singleton, and not a direct top-level import of `checkAppAccess`/
 * `resolveIdentities`: `bun test` runs every `*.test.ts` file in ONE process
 * with a SHARED module cache. `estimates.routes.ts`'s own test file
 * (`estimates.routes.test.ts`) already `mock.module()`s `@/auth/jwt.middleware`
 * and dynamically imports `./estimates.routes`, and separately relies on
 * `@/lib/authClient`'s REAL (unmocked) `resolveIdentities` failing soft
 * against a real network call (it asserts `owner.status === "unknown"` on
 * that basis). If this module captured either dependency via a module-level
 * import/singleton, whichever test file's mock (or lack thereof) happened to
 * bind FIRST — a filesystem-order-dependent race — would apply to every
 * other file's requests for the rest of the process, silently breaking one
 * side or the other. Taking the router AND the auth-client functions as
 * parameters (defaulting to the real `@/lib/authClient` exports in
 * production) gives `collaborators.routes.test.ts` a fully isolated app with
 * zero risk of cross-file interference — see that file's header.
 *
 * WHY PLAIN `.get()`/`.post()`, NOT `.openapi()`/`createRoute` (T11's scope):
 * a declarative `request.body` schema runs its 400 validation BEFORE the
 * handler body executes — but this endpoint's order is the opposite of
 * every other route in this service (PUT's is 401→400→428→413→404/403→409).
 * The plan's 9-step order below puts `resolveAccess` (404/403) and the rate
 * limiter BEFORE email-syntax validation (400), specifically so a stranger's
 * probe can be rejected before any body parsing or rate-budget consumption.
 * Manual `c.req.json()` + `safeParse` inside the handler is the only way to
 * honour that inversion.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE 9-STEP HANDLER ORDER (POST) — plan.md, verbatim, non-negotiable
 * ═══════════════════════════════════════════════════════════════════════
 *   1. resolveAccess → 404 / 403 (owner_only)
 *   2. rate limiter (counts EVERY attempt)                    → 429
 *   3. normalise email (trim + lower-case); syntax             → 400
 *   4. fast self-check against the caller's JWT `email` claim  → 422 self
 *   5. duplicate check on (estimateId, email)                  → 409
 *   6. auth POST /authz/app-access-check { appId:"estimai", email }
 *        throw/non-2xx → 503;  eligible:false → floored 422 generic
 *   7. definitive self-check: resolved userId === caller `sub` → 422 self
 *      (catches an alias address the fast check misses)
 *   8. INSERT; unique-violation on (estimateId,userId)         → 409 already_collaborator
 *      (an email-snapshot mismatch cannot create a duplicate grant)
 *   9. after commit, best-effort notify (AC-7.1)
 *
 * STEP 9 (T10, specs/013's notification wiring, deps: T8, T9): AFTER the
 * INSERT above commits, `deps.notifyCollaboratorGranted` (defaulting to
 * `src/lib/notify.ts`'s real export) fires once, best-effort — see
 * `bestEffortNotify`/`resolveEstimateNameForNotify` further down this file.
 * A notify failure (thrown, rejected, or a non-2xx from notify-api) is
 * caught and logged; it NEVER rolls back the grant or changes this
 * handler's 201 response — the collaborator sees the estimate in their
 * list on their next `GET /estimates` regardless of push delivery.
 *
 * THE GENERIC REJECTION (AC-1.2) — the security core of this endpoint: ONE
 * fixed status (422), ONE fixed code (`collaborator_not_eligible`), ONE
 * fixed non-interpolated detail string, for BOTH ineligibility causes
 * ("no such user" and "user exists but lacks EstimAI access" — `auth`
 * already collapses these into the same `{eligible:false}` body at the
 * source, ADR-0035). Floored to `SHARE_LOOKUP_FLOOR_MS`, timed from the very
 * top of the handler so the floor covers the whole round trip (duplicate
 * check + the `auth` call), matching `auth`'s own floor on its
 * `eligible:false` path. No other branch of this handler is floored.
 *
 * TWO SELF-CHECKS, NOT ONE: step 4 is a free, DB/auth-free comparison
 * against the JWT's own `email` claim (catches the common case instantly,
 * before any rate-limited work). Step 7 is the DEFINITIVE check, run only
 * after `auth` has resolved the submitted email to a `userId` — it catches
 * an alias address (a second verified email on the caller's own account)
 * that step 4's literal string comparison cannot see. Both map to the SAME
 * 422 `cannot_share_with_self` — the distinction is internal, not exposed.
 *
 * `grantedByUserId`/`userId` (the INSERT's identity columns) come ONLY from
 * the verified JWT `sub` (`callerId`) and `auth`'s `eligible:true` response
 * (`targetUserId`) — NEVER from the request body (OWASP A01/A04). The
 * request body supplies only `email` (used for the pre-auth duplicate probe
 * and the stored display snapshot) and `accessLevel`.
 *
 * `auth` unreachable (network failure or non-2xx from `checkAppAccess`,
 * which FAILS CLOSED — see authClient.ts) → 503
 * `authorization_service_unavailable`, and — critically — NO grant row is
 * ever created on that path (the INSERT is step 8, strictly after the
 * `auth` call in step 6; a thrown error there returns immediately).
 *
 * GET is owner-only (403 `owner_only` for a collaborator — the spec never
 * grants collaborators visibility of each other) and returns the GRANT's
 * `id`, never a `sub` — user ids are not put into URLs or list payloads
 * (plan.md).
 */

import { z } from "zod";
import { Effect } from "effect";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { JwtVariables } from "@/auth/jwt.middleware";
import { env } from "@/lib/env";
import {
  checkAppAccess as realCheckAppAccess,
  resolveIdentities as realResolveIdentities,
  type Identity as ResolvedIdentity,
} from "@/lib/authClient";
import {
  notifyCollaboratorGranted as realNotifyCollaboratorGranted,
  notifyCollaboratorRemoved as realNotifyCollaboratorRemoved,
} from "@/lib/notify";
import { createSlidingWindowRateLimiter } from "@/lib/rateLimiter";
import { resolveAccess } from "./access";
import {
  listCollaborators,
  findCollaboratorByEmail,
  insertCollaborator,
  findCollaboratorById,
  updateCollaboratorAccessLevel,
  deleteCollaboratorById,
  findCollaboratorByUserId,
  deleteCollaboratorByUserId,
  findEstimateName,
  AlreadyCollaboratorError,
} from "./collaborators.repo";
import {
  AddCollaboratorRequestSchema,
  UpdateCollaboratorRequestSchema,
  type Collaborator,
} from "./collaborators.schemas";

// ─── Constants ────────────────────────────────────────────────────────────────

// The `appId` this service asks `auth` about — matches the catalog id
// (`auth/src/authz/catalogs/estimai.ts`) and the value every EstimAI
// app-access grant is issued under.
const APP_ID = "estimai";

// AC-1.2 — the ONE fixed detail string for BOTH ineligibility causes. Never
// interpolated, never varied by cause — a "did you mean" or a cause-specific
// hint would silently defeat anti-enumeration.
const GENERIC_REJECTION_DETAIL =
  "That address can't be added as a collaborator. Collaborators must be " +
  "Operai users who already have EstimAI access.";

const SELF_ADD_DETAIL = "You cannot add yourself as a collaborator on your own estimate.";

const UNKNOWN_IDENTITY: ResolvedIdentity = { id: "", status: "unknown", name: null };

// A slightly stricter, dedicated syntax check for the normalised email
// (AddCollaboratorRequestSchema.email deliberately omits `.email()` — see
// this file's header on why syntax validation is deferred to step 3).
const EmailSyntaxSchema = z.string().max(320).email();

// ─── Problem JSON helpers (local — mirrors estimates.routes.ts's pattern) ────

// `code` is OPTIONAL and omitted by default so the "no relationship to this
// estimate" 404 (resolveAccess === null, used across GET/POST/PATCH/DELETE)
// stays byte-identical to AC-1.6's stranger 404 in estimates.routes.ts —
// neither carries a `code` field. T9's `DELETE .../collaborators/me` is the
// one call site that passes `code: "not_a_collaborator"` (plan.md), which is
// NOT compared against AC-1.6 anywhere, so widening its shape is safe.
const problemNotFound = (path: string, detail: string, code?: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  ...(code !== undefined ? { code } : {}),
  instance: path,
});

const problemForbidden = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  code,
  instance: path,
});

const problemBadRequest = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/400",
  title: "Bad Request",
  status: 400 as const,
  detail,
  code,
  instance: path,
});

const problemConflict = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/409",
  title: "Conflict",
  status: 409 as const,
  detail,
  code,
  instance: path,
});

const problemUnprocessable = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/422",
  title: "Unprocessable Entity",
  status: 422 as const,
  detail,
  code,
  instance: path,
});

const problemServiceUnavailable = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/503",
  title: "Service Unavailable",
  status: 503 as const,
  detail,
  code,
  instance: path,
});

const problemTooManyRequests = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/429",
  title: "Too Many Requests",
  status: 429 as const,
  detail,
  code,
  instance: path,
});

// ─── T10 — best-effort notify helpers ───────────────────────────────────────
//
// `notify.ts`'s exports already promise never to throw/reject (T5's doc
// comment) — this wrapper is deliberate DEFENSE IN DEPTH, mirroring
// `refund-api/src/review/decide.routes.ts`'s `notifyDecisionBestEffort`
// (the established pattern for this exact "outbound push AFTER a commit"
// shape in this monorepo): a test-injected `deps.notifyCollaboratorGranted`/
// `Removed` double COULD throw (T10's own done-when requires proving a
// throwing notify client still yields 201 with the grant persisted), and
// this `try/catch` is what makes that true regardless of what the real
// `notify.ts` promises. Never awaited by the caller for its result — only
// for ordering (it must run strictly after the DB write it reports on).

async function bestEffortNotify(
  notifyCall: () => Promise<void>,
  logContext: string,
): Promise<void> {
  try {
    await notifyCall();
  } catch (error) {
    console.error(
      `[collaborators] notify threw unexpectedly for ${logContext} — the change was NOT rolled back:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Resolves the estimate's current `name` for a post-commit notification body
 * (AC-7.1/AC-7.2). Best-effort itself — a `DatabaseError` or a (practically
 * unreachable, since the caller just wrote to this same row) vanished
 * estimate falls back to a generic placeholder rather than ever blocking or
 * failing the already-committed grant/removal response.
 */
async function resolveEstimateNameForNotify(estimateId: string): Promise<string> {
  const nameExit = await Effect.runPromiseExit(findEstimateName(estimateId));
  if (nameExit._tag === "Success" && nameExit.value !== null) {
    return nameExit.value;
  }
  console.error(
    `[collaborators] could not resolve estimate ${estimateId}'s name for a post-commit ` +
      "notification — falling back to a generic placeholder",
  );
  return "this estimate";
}

// ─── Display identity helper (ADR-0039 — fails SOFT, never gates access) ────

const toWireIdentity = (resolved: ResolvedIdentity): Collaborator["identity"] => ({
  status: resolved.status,
  name: resolved.name,
});

// ─── Timing floor (AC-1.2 — quantised to a fixed floor, mirrors auth's own
// APP_ACCESS_CHECK_FLOOR_MS mechanism in appAccessCheck.routes.ts) ──────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const floorSince = async (startedAt: number, floorMs: number): Promise<void> => {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await sleep(remaining);
  }
};

// ─── Rate limiter — module-scope singleton, keyed by caller `sub` ───────────
//
// SHARE_ADD_RATE_LIMIT attempts per SHARE_ADD_RATE_WINDOW_MS (plan.md
// "Rate limiting" — default 20/10min). Consulted at step 2, AFTER
// resolveAccess (step 1) so a stranger with no relationship to the estimate
// never consumes this budget, and counted unconditionally so every outcome
// downstream (success, duplicate, self, generic rejection) already counts —
// a limiter only consulted on failure would leave a valid-email prober
// unthrottled.
const addCollaboratorLimiter = createSlidingWindowRateLimiter({
  limit: env.SHARE_ADD_RATE_LIMIT,
  windowMs: env.SHARE_ADD_RATE_WINDOW_MS,
});

// ─── Injectable auth-client dependencies (see file header) ──────────────────

export interface CollaboratorRouteDeps {
  readonly checkAppAccess: typeof realCheckAppAccess;
  readonly resolveIdentities: typeof realResolveIdentities;
  // T10 — same injectability rationale as checkAppAccess/resolveIdentities
  // above (see file header): notify.ts calls `fetch` against an outbound
  // service exactly like authClient.ts does, so a test file that wants to
  // assert "called exactly once with X" (AC-7.1/7.2) or "never called"
  // (AC-7.3) needs a per-test double, not a shared module-cache singleton
  // another test file's `mock.module()` could silently win or lose against.
  readonly notifyCollaboratorGranted: typeof realNotifyCollaboratorGranted;
  readonly notifyCollaboratorRemoved: typeof realNotifyCollaboratorRemoved;
}

const defaultDeps: CollaboratorRouteDeps = {
  checkAppAccess: realCheckAppAccess,
  resolveIdentities: realResolveIdentities,
  notifyCollaboratorGranted: realNotifyCollaboratorGranted,
  notifyCollaboratorRemoved: realNotifyCollaboratorRemoved,
};

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Attaches `GET`/`POST /estimates/{id}/collaborators` to `router`. Called
 * exactly once in production (`index.ts`, on the real `estimatesRouter`,
 * AFTER its `bodyLimit`/`jwtMiddleware` are already registered, with the
 * default `deps` — the real `@/lib/authClient` functions) and once per test
 * run (`collaborators.routes.test.ts`, on an isolated router with
 * test-double `deps`) — see this file's header for why these are parameters
 * rather than module-level imports/singletons.
 */
export function registerCollaboratorRoutes(
  router: OpenAPIHono<{ Variables: JwtVariables }>,
  deps: CollaboratorRouteDeps = defaultDeps,
): void {
  const resolveOneIdentity = async (
    authHeader: string,
    userId: string,
  ): Promise<Collaborator["identity"]> => {
    const identities = await deps.resolveIdentities(authHeader, [userId]);
    return toWireIdentity(identities.get(userId) ?? UNKNOWN_IDENTITY);
  };

  // ─── GET /estimates/{id}/collaborators — owner-only list ──────────────────

  router.get("/estimates/:id/collaborators", async (c) => {
    const callerId = c.get("userId");
    const estimateId = c.req.param("id");
    const authHeader = c.req.header("Authorization") ?? "";
    const path = c.req.path;

    const accessExit = await Effect.runPromiseExit(resolveAccess(estimateId, callerId));
    if (accessExit._tag === "Failure") {
      throw new Error("Unexpected database failure resolving estimate access");
    }
    const resolved = accessExit.value;

    if (resolved === null) {
      return c.json(problemNotFound(path, `Estimate ${estimateId} not found`), 404);
    }
    if (resolved.level !== "owner") {
      return c.json(
        problemForbidden(path, "Only the owner can view this estimate's collaborators.", "owner_only"),
        403,
      );
    }

    const listExit = await Effect.runPromiseExit(listCollaborators(estimateId));
    if (listExit._tag === "Failure") {
      throw new Error("Unexpected database failure listing collaborators");
    }
    const rows = listExit.value;

    const userIds = Array.from(new Set(rows.map((row) => row.userId)));
    const identities =
      userIds.length > 0
        ? await deps.resolveIdentities(authHeader, userIds)
        : new Map<string, ResolvedIdentity>();

    const collaborators: Collaborator[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      accessLevel: row.accessLevel,
      createdAt: row.createdAt,
      identity: toWireIdentity(identities.get(row.userId) ?? UNKNOWN_IDENTITY),
    }));

    return c.json({ collaborators }, 200);
  });

  // ─── POST /estimates/{id}/collaborators — the add path (US-1) ─────────────

  router.post("/estimates/:id/collaborators", async (c) => {
    const requestStartedAt = Date.now();
    const path = c.req.path;
    const callerId = c.get("userId");
    const callerEmail = c.get("email");
    const estimateId = c.req.param("id");
    const authHeader = c.req.header("Authorization") ?? "";

    // ── Step 1: resolveAccess → 404 / 403 (owner_only). FIRST, before any
    // rate-limit or auth-call work, so a stranger can neither probe the
    // estimate's existence nor consume the rate budget.
    const accessExit = await Effect.runPromiseExit(resolveAccess(estimateId, callerId));
    if (accessExit._tag === "Failure") {
      throw new Error("Unexpected database failure resolving estimate access");
    }
    const resolved = accessExit.value;

    if (resolved === null) {
      return c.json(problemNotFound(path, `Estimate ${estimateId} not found`), 404);
    }
    if (resolved.level !== "owner") {
      return c.json(
        problemForbidden(path, "Only the owner can add collaborators.", "owner_only"),
        403,
      );
    }

    // ── Step 2: rate limiter — counts EVERY attempt from here on.
    const rateLimitResult = addCollaboratorLimiter.attempt(callerId);
    if (!rateLimitResult.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((rateLimitResult.retryAfterMs ?? 0) / 1000));
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        problemTooManyRequests(path, "Too many collaborator-add attempts. Try again later.", "rate_limited"),
        429,
      );
    }

    // ── Step 3: normalise email (trim + lower-case); syntax + accessLevel.
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(problemBadRequest(path, "Request body must be valid JSON.", "invalid_input"), 400);
    }

    const bodyResult = AddCollaboratorRequestSchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json(
        problemBadRequest(
          path,
          bodyResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          "invalid_input",
        ),
        400,
      );
    }

    const normalizedEmail = bodyResult.data.email.trim().toLowerCase();
    const emailSyntaxResult = EmailSyntaxSchema.safeParse(normalizedEmail);
    if (!emailSyntaxResult.success) {
      return c.json(problemBadRequest(path, "email must be a valid email address.", "invalid_input"), 400);
    }
    const accessLevel = bodyResult.data.accessLevel;

    // ── Step 4: fast self-check against the caller's JWT `email` claim — no
    // DB or auth call.
    if (normalizedEmail === callerEmail.trim().toLowerCase()) {
      return c.json(problemUnprocessable(path, SELF_ADD_DETAIL, "cannot_share_with_self"), 422);
    }

    // ── Step 5: duplicate check on (estimateId, email) — no auth round trip.
    const dupExit = await Effect.runPromiseExit(findCollaboratorByEmail(estimateId, normalizedEmail));
    if (dupExit._tag === "Failure") {
      throw new Error("Unexpected database failure checking for an existing collaborator");
    }
    const existing = dupExit.value;
    if (existing !== null) {
      return c.json(
        problemConflict(
          path,
          `${normalizedEmail} already has ${existing.accessLevel} access to this estimate. Use PATCH to change their level.`,
          "already_collaborator",
        ),
        409,
      );
    }

    // ── Step 6: auth POST /authz/app-access-check — FAILS CLOSED.
    let eligibility: Awaited<ReturnType<typeof deps.checkAppAccess>>;
    try {
      eligibility = await deps.checkAppAccess(authHeader, APP_ID, normalizedEmail);
    } catch (error) {
      console.error(
        "[collaborators] auth POST /authz/app-access-check unreachable — failing CLOSED, no grant created:",
        error instanceof Error ? error.message : error,
      );
      return c.json(
        problemServiceUnavailable(
          path,
          "Collaborator eligibility could not be verified right now. Please try again shortly.",
          "authorization_service_unavailable",
        ),
        503,
      );
    }

    if (!eligibility.eligible) {
      // THE GENERIC REJECTION (AC-1.2) — floored, fixed status/code/detail.
      await floorSince(requestStartedAt, env.SHARE_LOOKUP_FLOOR_MS);
      return c.json(problemUnprocessable(path, GENERIC_REJECTION_DETAIL, "collaborator_not_eligible"), 422);
    }

    const targetUserId = eligibility.userId;
    if (!targetUserId) {
      // Contractually unreachable (eligible:true always carries userId per
      // authClient.ts's AppAccessCheckResult / auth's own response schema) —
      // guarded defensively rather than asserted non-null, so a future
      // contract drift on either side surfaces as a 503, never an insert with
      // an undefined userId.
      throw new Error("auth returned eligible:true without a userId");
    }

    // ── Step 7: definitive self-check on the RESOLVED userId — catches an
    // alias address step 4's literal email-claim comparison cannot see.
    if (targetUserId === callerId) {
      return c.json(problemUnprocessable(path, SELF_ADD_DETAIL, "cannot_share_with_self"), 422);
    }

    // ── Step 8: INSERT. userId/grantedByUserId come ONLY from the verified
    // JWT and the auth response — NEVER the request body.
    const insertExit = await Effect.runPromiseExit(
      insertCollaborator({
        estimateId,
        userId: targetUserId,
        email: normalizedEmail,
        accessLevel,
        grantedByUserId: callerId,
      }),
    );

    if (insertExit._tag === "Failure") {
      const cause = insertExit.cause;
      if (cause._tag === "Fail" && cause.error instanceof AlreadyCollaboratorError) {
        // The stale-email-snapshot race (plan.md step 8): the pre-check at
        // step 5 missed it because the existing grant's stored email differs,
        // but both resolve to the same auth userId — the unique constraint on
        // (estimateId, userId) catches it here.
        return c.json(problemConflict(path, cause.error.message, "already_collaborator"), 409);
      }
      throw new Error("Unexpected database failure adding collaborator");
    }

    const created = insertExit.value;

    // ── Step 9: best-effort notify (AC-7.1), strictly AFTER the INSERT
    // above has committed — see this file's header and
    // bestEffortNotify/resolveEstimateNameForNotify. Never blocks or fails
    // this 201 response.
    const grantEstimateName = await resolveEstimateNameForNotify(estimateId);
    await bestEffortNotify(
      () =>
        deps.notifyCollaboratorGranted({
          recipientId: targetUserId,
          estimateId,
          estimateName: grantEstimateName,
          accessLevel,
        }),
      `estimate ${estimateId} (collaborator granted, recipient ${targetUserId})`,
    );

    const identity = await resolveOneIdentity(authHeader, targetUserId);

    return c.json(
      {
        id: created.id,
        email: created.email,
        accessLevel: created.accessLevel,
        createdAt: created.createdAt,
        identity,
      },
      201,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // T9 — manage / revoke / leave (specs/013-estimate-sharing, refs AC-5.1,
  // AC-5.2, AC-5.3, AC-6.1, AC-6.2; plan.md "API contracts — estimai-api —
  // new")
  // ═══════════════════════════════════════════════════════════════════════
  //
  // All three routes below are OWNER-GATED except `/me`. `/me` is registered
  // FIRST, before the two `{collaboratorId}` param routes — Hono's router
  // would otherwise match the literal path segment "me" as a VALUE for
  // `:collaboratorId` on `DELETE .../collaborators/{collaboratorId}`, since
  // both are registered for the same method (`DELETE`) on the same prefix.
  // (`PATCH` has no `/me` route at all, so no such collision exists for it —
  // the ordering constraint is specifically about `DELETE`.)
  //
  // ENFORCEMENT IS NEXT-REQUEST (AC-5.3) — a `PATCH` level change or a
  // `DELETE` takes effect the moment it commits, but there is deliberately
  // NO push/stream/live-kick mechanism for an already-open session; the
  // collaborator's CURRENT request (if one happens to be in flight) is
  // unaffected, and their NEXT request re-runs `resolveAccess`/
  // `findCollaboratorByUserId` fresh, which is what actually enforces it.
  // Nothing here subscribes to or emits any event.
  //
  // NO NOTIFICATION IS FIRED BY `PATCH` (AC-7.3 — a level change is
  // deliberately silent) OR BY `DELETE .../me` (AC-7.2 excludes self-leave).
  // The owner-initiated `DELETE .../collaborators/{collaboratorId}` DOES
  // carry a best-effort removal notification (T10, specs/013): AFTER the
  // DELETE below commits, `deps.notifyCollaboratorRemoved` fires once, with
  // NO `link` (plan.md: "the target would 404") — see
  // `bestEffortNotify`/`resolveEstimateNameForNotify` further up this file.

  // ─── DELETE /estimates/{id}/collaborators/me — leave (self, US-6, AC-6.1/6.2) ──

  router.delete("/estimates/:id/collaborators/me", async (c) => {
    const callerId = c.get("userId");
    const estimateId = c.req.param("id");
    const path = c.req.path;

    const ownGrantExit = await Effect.runPromiseExit(
      findCollaboratorByUserId(estimateId, callerId),
    );
    if (ownGrantExit._tag === "Failure") {
      throw new Error(
        "Unexpected database failure looking up the caller's own collaborator grant",
      );
    }

    // Covers three cases IDENTICALLY, by construction (no separate branch
    // needed): a genuine stranger, a collaborator on a DIFFERENT estimate,
    // and — the AC-6.2 case — the OWNER themselves. An owner never has an
    // `EstimateCollaborator` row of their own (AC-1.4), so they have no
    // grant to leave; they delete the estimate instead. This is NOT the
    // AC-1.6 "no relationship" 404 (no `resolveAccess` call happens here at
    // all, and this body intentionally carries a `code`) — it is scoped
    // narrowly to "does the caller hold a grant", which is all `/me` needs.
    if (ownGrantExit.value === null) {
      return c.json(
        problemNotFound(
          path,
          "You are not a collaborator on this estimate.",
          "not_a_collaborator",
        ),
        404,
      );
    }

    const deleteExit = await Effect.runPromiseExit(
      deleteCollaboratorByUserId(estimateId, callerId),
    );
    if (deleteExit._tag === "Failure") {
      throw new Error(
        "Unexpected database failure removing the caller's own collaborator grant",
      );
    }

    // NO notification — self-leave is explicitly excluded (AC-7.2).

    return new Response(null, { status: 204 });
  });

  // ─── PATCH /estimates/{id}/collaborators/{collaboratorId} — level change (owner only, AC-5.1) ──

  router.patch("/estimates/:id/collaborators/:collaboratorId", async (c) => {
    const callerId = c.get("userId");
    const estimateId = c.req.param("id");
    const collaboratorId = c.req.param("collaboratorId");
    const authHeader = c.req.header("Authorization") ?? "";
    const path = c.req.path;

    const accessExit = await Effect.runPromiseExit(resolveAccess(estimateId, callerId));
    if (accessExit._tag === "Failure") {
      throw new Error("Unexpected database failure resolving estimate access");
    }
    const resolved = accessExit.value;

    if (resolved === null) {
      return c.json(problemNotFound(path, `Estimate ${estimateId} not found`), 404);
    }
    if (resolved.level !== "owner") {
      return c.json(
        problemForbidden(
          path,
          "Only the owner can change a collaborator's access level.",
          "owner_only",
        ),
        403,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(problemBadRequest(path, "Request body must be valid JSON.", "invalid_input"), 400);
    }
    const bodyResult = UpdateCollaboratorRequestSchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json(
        problemBadRequest(
          path,
          bodyResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          "invalid_input",
        ),
        400,
      );
    }

    // AC-5.4 — a fabricated grant id (or one lifted from a DIFFERENT
    // estimate, including one shaped like the owner's own `sub`) → 404.
    // Scoped by BOTH `collaboratorId` AND `estimateId`.
    const existingExit = await Effect.runPromiseExit(
      findCollaboratorById(estimateId, collaboratorId),
    );
    if (existingExit._tag === "Failure") {
      throw new Error("Unexpected database failure looking up the collaborator grant");
    }
    if (existingExit.value === null) {
      return c.json(problemNotFound(path, `Collaborator grant ${collaboratorId} not found`), 404);
    }

    const updateExit = await Effect.runPromiseExit(
      updateCollaboratorAccessLevel(collaboratorId, bodyResult.data.accessLevel),
    );
    if (updateExit._tag === "Failure") {
      throw new Error("Unexpected database failure updating the collaborator's access level");
    }
    const updated = updateExit.value;

    // NO notification — level changes are deliberately silent (AC-7.3).
    // Takes effect on the collaborator's NEXT request — there is no live
    // disconnection mechanism (AC-5.3); see this section's header note.

    const identity = await resolveOneIdentity(authHeader, updated.userId);

    return c.json(
      {
        id: updated.id,
        email: updated.email,
        accessLevel: updated.accessLevel,
        createdAt: updated.createdAt,
        identity,
      },
      200,
    );
  });

  // ─── DELETE /estimates/{id}/collaborators/{collaboratorId} — revoke (owner only, AC-5.2) ──

  router.delete("/estimates/:id/collaborators/:collaboratorId", async (c) => {
    const callerId = c.get("userId");
    const estimateId = c.req.param("id");
    const collaboratorId = c.req.param("collaboratorId");
    const path = c.req.path;

    const accessExit = await Effect.runPromiseExit(resolveAccess(estimateId, callerId));
    if (accessExit._tag === "Failure") {
      throw new Error("Unexpected database failure resolving estimate access");
    }
    const resolved = accessExit.value;

    if (resolved === null) {
      return c.json(problemNotFound(path, `Estimate ${estimateId} not found`), 404);
    }
    if (resolved.level !== "owner") {
      return c.json(
        problemForbidden(path, "Only the owner can remove a collaborator.", "owner_only"),
        403,
      );
    }

    // AC-5.4 — a fabricated grant id (or one lifted from a DIFFERENT
    // estimate) → 404. Scoped by BOTH `collaboratorId` AND `estimateId`.
    const existingExit = await Effect.runPromiseExit(
      findCollaboratorById(estimateId, collaboratorId),
    );
    if (existingExit._tag === "Failure") {
      throw new Error("Unexpected database failure looking up the collaborator grant");
    }
    if (existingExit.value === null) {
      return c.json(problemNotFound(path, `Collaborator grant ${collaboratorId} not found`), 404);
    }

    const deleteExit = await Effect.runPromiseExit(deleteCollaboratorById(collaboratorId));
    if (deleteExit._tag === "Failure") {
      throw new Error("Unexpected database failure removing the collaborator");
    }
    const removed = deleteExit.value;

    // Owner-initiated removal notification (AC-7.2, T10), best-effort,
    // strictly AFTER the DELETE above has committed — never rolls back
    // this removal. NO `link` (plan.md: "the target would 404"). Recipient
    // is the JUST-DELETED grant's own `userId`, read from the row
    // `deleteCollaboratorById` returned (its pre-deletion snapshot) rather
    // than re-queried — the row is already gone.
    const removalEstimateName = await resolveEstimateNameForNotify(estimateId);
    await bestEffortNotify(
      () =>
        deps.notifyCollaboratorRemoved({
          recipientId: removed.userId,
          estimateId,
          estimateName: removalEstimateName,
        }),
      `estimate ${estimateId} (collaborator removed, recipient ${removed.userId})`,
    );

    return new Response(null, { status: 204 });
  });
}
