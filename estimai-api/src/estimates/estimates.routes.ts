/**
 * Estimates CRUD router (T4+T5, specs/20260606-estimate-persistence;
 * widened for sharing in T6, specs/20260807-estimate-sharing; optimistic
 * concurrency added in T7, ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004).
 *
 * All routes are protected by jwtMiddleware (set userId/email on context).
 * Every repository call is scoped by userId derived from the verified JWT sub.
 *
 * Endpoints on estimatesRouter (2 MiB body limit):
 *   POST   /estimates          → 201 EstimateFull        (AC-1.1)
 *   GET    /estimates          → 200 EstimateListItem[]  (AC-2.1, AC-2.3; T6: owned ∪ shared)
 *   GET    /estimates/:id      → 200 EstimateFull, ETag: "<version>"   (AC-2.2; T6: any relationship
 *                                                          suffices; T7: ETag header)
 *   PUT    /estimates/:id      → 200 EstimateFull, ETag: "<new version>" (AC-1.2; T7: REQUIRED
 *                                                          If-Match, version CAS + owner/editor-grant
 *                                                          predicate in ONE statement, 428/403/404/409 —
 *                                                          see the updateEstimateRoute doc comment)
 *   DELETE /estimates/:id      → 204 (no body)           (AC-3.1; still owner-only)
 *
 * A CLOSED estimate (POST /estimates/{id}/close, lifecycle.routes.ts) is
 * read-only: PUT answers 409 `estimate_closed` (same atomic CAS predicate).
 * DELETE and collaborator management stay allowed while closed.
 *
 * Endpoints on importEstimatesRouter (larger body limit — see BODY LIMIT DESIGN):
 *   POST   /estimates/import   → 200 ImportResponse      (AC-5.2, AC-5.4)
 *
 * BODY LIMIT DESIGN (OWASP A04 fix):
 *   - estimatesRouter: 2 MiB wildcard bodyLimit — single-estimate POST/PUT only
 *     need headroom for a 1 MiB content plus the JSON envelope.
 *   - importEstimatesRouter: separate router with a larger bodyLimit so that a
 *     legitimate batch (e.g. three 900 KB estimates) is not rejected at the outer
 *     envelope before per-element handling can run. The import limit is:
 *       min(MAX_ESTIMATE_BYTES × 200 + 64 KiB envelope, 32 MiB hard ceiling)
 *     The 32 MiB ceiling is the DoS trade-off: the import endpoint is internal/
 *     behind-auth, so a generous-but-bounded ceiling is acceptable. The per-element
 *     checkContentSize() (1 MiB) still runs inside the handler — the body limit is
 *     only the outer envelope bound, not a substitute for per-element validation.
 *   - The two routers are mounted separately in index.ts so their bodyLimit
 *     middleware chains are completely independent (no double-capping).
 *
 * DENIAL TAXONOMY (T6, plan.md "Access resolution inside estimai-api", ADR 20260807-denial-taxonomy-shared-records-403-vs-404
 * — a deliberate narrowing of ADR 20260703-jwt-resource-server-remote-jwks's blanket "not owned = 404"):
 *   - NO relationship at all (stranger)              → 404 (AC-1.6, ADR 20260703-jwt-resource-server-remote-jwks intact)
 *   - a relationship exists but the level is short    → 403 with a stable `code`
 *     (DELETE's "owner_only"; PUT's "insufficient_access" for a viewer, T7 —
 *     a collaborator attempting either already knows the estimate exists,
 *     so 404 would be a lie)
 * `GET` is the one operation where ANY relationship (owner/editor/viewer)
 * is sufficient — there is no 403 on the read path.
 *
 * All errors are RFC 7807 Problem JSON via the global onError handler, with the
 * NotFoundError/ForbiddenError/SizeError paths handled inline (404/403/413).
 *
 * T5: per-estimate size guard enforced on POST and PUT before any DB write.
 *   - computeSizeBytes() from estimates.repo.ts measures the UTF-8 byte length
 *     of the serialised content.
 *   - If it exceeds MAX_ESTIMATE_BYTES → 413 Problem, nothing is persisted.
 *   - checkContentSize() is a small reusable helper called per element in import.
 *   - bodyLimit middleware caps raw request body (see BODY LIMIT DESIGN above).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { nulRefusalIn, unexpectedDbFailure } from "@/lib/dbFailure";
import { bodyLimit } from "hono/body-limit";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import {
  ConflictError,
  EstimateStateError,
  ForbiddenError,
  NotFoundError,
  SizeError,
} from "@/lib/errors";
import { env } from "@/lib/env";
import { zodIssuesHook } from "@/lib/zodHook";
import { resolveIdentities, type Identity as ResolvedIdentity } from "@/lib/authClient";
import { holdsReadAll, isOversightReadOnly, OversightUnavailableError } from "./oversight";
import {
  EstimateUpsertSchema,
  EstimateFullSchema,
  EstimateListItemSchema,
  ListEstimatesQuerySchema,
  EstimateIdParamSchema,
  ImportRequestSchema,
  ImportResponseSchema,
  type Identity,
} from "./estimates.schemas";
import {
  ConflictProblemSchema,
  ProblemSchema,
  ProblemWithCodeSchema,
  UNKNOWN_IDENTITY,
  parseIfMatch,
  problemBadRequest,
  problemConflict,
  problemEstimateState,
  problemForbidden,
  problemAuthzUnavailable,
  problemNotFound,
  problemOversightReadOnly,
  problemOversightRequired,
  problemPayloadTooLarge,
  problemPreconditionRequired,
  resolveFullIdentities,
  resolveIdentityFor,
  toWireFull,
  toWireListItem,
} from "./estimates.wire";
import {
  createEstimate,
  listEstimates,
  getEstimateById,
  getEstimateAsOversight,
  updateEstimate,
  deleteEstimate,
  computeSizeBytes,
} from "./estimates.repo";

// Problem bodies, the If-Match parser and the row → wire mapping live in
// ./estimates.wire (shared with the close/reopen routes, lifecycle.routes.ts).

/**
 * Resolves the 409 conflict body's `lastModifiedBy` (T7). `null` means the
 * row predates this feature's `lastModifiedByUserId` column (never written
 * by a CAS write yet) — returned as UNKNOWN_IDENTITY without an `auth` call,
 * matching the same never-blocks-the-409 posture as a resolution failure.
 */
const resolveLastModifiedByIdentity = async (
  authHeader: string,
  lastModifiedByUserId: string | null,
): Promise<Identity> =>
  lastModifiedByUserId === null
    ? UNKNOWN_IDENTITY
    : resolveIdentityFor(authHeader, lastModifiedByUserId);

// ─── Size guard helper (reusable by T6 import endpoint) ─────────────────────
//
// Returns a SizeError if `content` serialises to more than `limitBytes` UTF-8
// bytes, otherwise returns undefined. Callers check the return value before
// any DB write so nothing is persisted on rejection (AC-1.4).

export const checkContentSize = (
  content: Parameters<typeof computeSizeBytes>[0],
  limitBytes: number,
): SizeError | undefined => {
  const actualBytes = computeSizeBytes(content);
  if (actualBytes > limitBytes) {
    return new SizeError({
      message: `Estimate content is ${(actualBytes / 1024 / 1024).toFixed(1)} MB; the maximum is ${(limitBytes / 1024 / 1024).toFixed(1)} MB. Nothing was saved.`,
      actualBytes,
      limitBytes,
    });
  }
  return undefined;
};

// ─── Body-size limit constants ────────────────────────────────────────────────

// Single-estimate endpoints (POST /estimates, PUT /estimates/:id): 2 MiB gives
// headroom for the JSON envelope around a max-size (1 MiB) content (AC-1.4, DoS).
const BODY_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MiB

/** ADR 20261108-estimai-oversight-permission-amends-0036's revisit trigger for the unpaginated `whose=all` list. */
export const OVERSIGHT_LIST_REVISIT_ROWS = 500;

// Import endpoint: must accommodate up to 200 elements each up to MAX_ESTIMATE_BYTES
// plus a small envelope (~64 KiB). An absolute 32 MiB ceiling is applied as the
// DoS trade-off: this endpoint is internal/behind-auth, so a generous-but-bounded
// ceiling is acceptable. The per-element checkContentSize() (1 MiB) still runs
// inside the handler — the body limit is only the outer envelope bound.
//
// Ceiling derivation: MAX_ESTIMATE_BYTES (default 1 MiB) × 200 + 65536 ≈ 200 MiB
// computed value is much larger than the 32 MiB ceiling, so the ceiling always
// applies with the default. If MAX_ESTIMATE_BYTES were reduced to e.g. 100 KiB,
// the computed value (≈ 20 MiB) would fall under the ceiling.
const IMPORT_BODY_SIZE_LIMIT = (() => {
  const MAX_CEILING = 32 * 1024 * 1024; // 32 MiB hard ceiling
  const ENVELOPE_BYTES = 64 * 1024; // 64 KiB for the outer JSON envelope
  if (env.MAX_IMPORT_REQUEST_BYTES !== undefined) {
    // Honour the explicit env override but still cap at 32 MiB.
    return Math.min(env.MAX_IMPORT_REQUEST_BYTES, MAX_CEILING);
  }
  const computed = env.MAX_ESTIMATE_BYTES * 200 + ENVELOPE_BYTES;
  return Math.min(computed, MAX_CEILING);
})();

// ─── Routers ──────────────────────────────────────────────────────────────────
//
// estimatesRouter: CRUD endpoints (2 MiB body limit).
// importEstimatesRouter: bulk-import endpoint (IMPORT_BODY_SIZE_LIMIT).
//
// The two routers are mounted separately in index.ts so their bodyLimit middleware
// chains are completely independent — the import route is never subject to the 2 MiB
// cap, and single-estimate endpoints are never given the larger import limit.

export const estimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>({ defaultHook: zodIssuesHook });

estimatesRouter.use(
  "*",
  bodyLimit({
    maxSize: BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        {
          type: "https://httpstatuses.com/413",
          title: "Payload Too Large",
          status: 413,
          detail: `Request body exceeds the maximum allowed size of ${(BODY_SIZE_LIMIT / 1024 / 1024).toFixed(0)} MB.`,
          instance: c.req.path,
        },
        413,
      ),
  }),
);

// Apply jwtMiddleware to ALL routes on the CRUD router.
estimatesRouter.use("*", jwtMiddleware);

// ─── Import sub-router (separate bodyLimit — see BODY LIMIT DESIGN in file header) ──

export const importEstimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>({ defaultHook: zodIssuesHook });

importEstimatesRouter.use(
  "*",
  bodyLimit({
    maxSize: IMPORT_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        {
          type: "https://httpstatuses.com/413",
          title: "Payload Too Large",
          status: 413,
          detail: `Import request body exceeds the maximum allowed size of ${(IMPORT_BODY_SIZE_LIMIT / 1024 / 1024).toFixed(1)} MB.`,
          instance: c.req.path,
        },
        413,
      ),
  }),
);

// Apply jwtMiddleware to ALL routes on the import router.
importEstimatesRouter.use("*", jwtMiddleware);

// ─── POST /estimates — Create ─────────────────────────────────────────────────

const createEstimateRoute = createRoute({
  method: "post",
  path: "/estimates",
  tags: ["Estimates"],
  summary: "Create an estimate",
  description:
    "Persists a new estimate under the caller's account. Returns the full estimate on success.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: EstimateUpsertSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: "Estimate created (AC-1.1)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Content exceeds MAX_ESTIMATE_BYTES; nothing was persisted (AC-1.4)",
    },
  },
});

estimatesRouter.openapi(createEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

  // T5: enforce size guard BEFORE any DB write (AC-1.4 — no partial write).
  const sizeErr = checkContentSize(body.content, env.MAX_ESTIMATE_BYTES);
  if (sizeErr) {
    return c.json(
      problemPayloadTooLarge(c.req.path, sizeErr.actualBytes, sizeErr.limitBytes),
      413,
    );
  }

  const effect = createEstimate(userId, body.name, body.author, body.content);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    // A NUL the schema did not refuse is the safety net's 400 `validation_failed` (QE F1), not this generic one.
    if (cause._tag === "Fail" && nulRefusalIn(cause.error) === null) {
      return c.json(
        problemBadRequest(c.req.path, cause.error.message),
        400,
      );
    }
    throw unexpectedDbFailure("Unexpected database failure creating estimate", exit.cause);
  }

  // The creator is always the owner — no `auth` identity round trip needed.
  // The creator is always the owner and a new estimate is open.
  return c.json(toWireFull(exit.value, null, null), 201);
});

// ─── GET /estimates — List ────────────────────────────────────────────────────

const listEstimatesRoute = createRoute({
  method: "get",
  path: "/estimates",
  tags: ["Estimates"],
  summary: "List estimates for the current user",
  description:
    "Returns every estimate the caller owns OR holds a collaborator grant on, " +
    "ordered newest-first (T6, AC-2.1/2.2/2.3). Returns an empty array for a " +
    "user with no estimates and no grants — this is not an error. " +
    "`status=open|closed` filters on the closed state (specs/20261108-estimate-list-oversight); absent " +
    "returns both. `whose=all` (specs/20261108-estimate-list-oversight, ADR 20261108-estimai-oversight-permission-amends-0036) lists EVERY estimate and " +
    "needs `estimate:read-all`: rows the caller owns or collaborates on keep " +
    "their level, every other row is `access: \"oversight\"`. An unknown " +
    "`status`/`whose` value is a 400.",
  request: { query: ListEstimatesQuerySchema },
  responses: {
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Unknown `status` or `whose` value",
    },
    403: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description: "`whose=all` without `estimate:read-all` — code: oversight_required (AC-1.2)",
    },
    503: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description: "`whose=all` while `auth` is unreachable — code: authz_unavailable (AC-1.7)",
    },
    200: {
      content: {
        "application/json": { schema: z.array(EstimateListItemSchema) },
      },
      description: "List of estimates, owned and shared (AC-2.1, AC-2.3)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

estimatesRouter.openapi(listEstimatesRoute, async (c) => {
  const userId = c.get("userId");
  const authHeader = c.req.header("Authorization") ?? "";

  const { status, whose } = c.req.valid("query");

  // The only path that asks `auth` anything (ADR 20261108-estimai-oversight-permission-amends-0036). `mine`/absent never does.
  if (whose === "all") {
    try {
      if (!(await holdsReadAll(userId, authHeader))) {
        return c.json(problemOversightRequired(c.req.path), 403);
      }
    } catch (err) {
      if (err instanceof OversightUnavailableError) {
        return c.json(problemAuthzUnavailable(c.req.path), 503);
      }
      throw err;
    }
  }

  const effect = listEstimates(userId, status, whose);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw unexpectedDbFailure("Unexpected database failure listing estimates", exit.cause);
  }

  const rows = exit.value;

  // The oversight list is unpaginated by design (ADR 20261108-estimai-oversight-permission-amends-0036): listing columns only,
  // owners resolved once per distinct owner. Past ~500 rows the ADR is revisited,
  // so say so where operators look (security review 2026-11-09).
  if (whose === "all" && rows.length > OVERSIGHT_LIST_REVISIT_ROWS) {
    console.warn(
      `[oversight] whose=all returned ${rows.length} estimates (> ${OVERSIGHT_LIST_REVISIT_ROWS}): ADR 20261108-estimai-oversight-permission-amends-0036 says to add pagination`,
    );
  }

  // Batch-resolve display identity for every DISTINCT non-owned row's owner
  // in one call (plan.md "one batch per list render, distinct owner subs,
  // self excluded") — never one auth round trip per row. resolveIdentities
  // never throws (fails soft to "unknown" — AC keeps GET /estimates at 200
  // even when `auth` is unreachable).
  const ownerIdsToResolve = Array.from(
    new Set(rows.filter((row) => row.access !== "owner").map((row) => row.ownerId)),
  );
  const identities =
    ownerIdsToResolve.length > 0
      ? await resolveIdentities(authHeader, ownerIdsToResolve)
      : new Map<string, ResolvedIdentity>();

  return c.json(
    rows.map((row) => toWireListItem(row, identities)),
    200,
  );
});

// ─── GET /estimates/:id — Get full estimate ───────────────────────────────────

const getEstimateRoute = createRoute({
  method: "get",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Get a single estimate",
  description:
    "Returns the full estimate including content to ANY caller with a " +
    "relationship to it — owner, editor, or viewer (T6, AC-3.1). Returns 404 " +
    "if the estimate does not exist or the caller has no relationship to it " +
    "at all (AC-1.6 — no existence leak, ADR 20260703-jwt-resource-server-remote-jwks/ADR 20260807-denial-taxonomy-shared-records-403-vs-404). The response " +
    'carries an `ETag: "<version>"` header (T7) — the precondition value a ' +
    "subsequent PUT must echo back via `If-Match`.",
  request: {
    params: EstimateIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: 'Full estimate (AC-2.2). ETag: "<version>" (T7, AC-4.1).',
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No relationship to this estimate and no `estimate:read-all` (AC-1.6)",
    },
    503: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description:
        "No relationship, and `auth` could not say whether the caller holds `estimate:read-all` — code: authz_unavailable (AC-1.7)",
    },
  },
});

estimatesRouter.openapi(getEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const authHeader = c.req.header("Authorization") ?? "";

  let exit = await Effect.runPromiseExit(getEstimateById(id, userId));

  // Oversight fallback (specs/20261108-estimate-list-oversight, ADR 20261108-estimai-oversight-permission-amends-0036): consulted ONLY when the caller
  // has no relationship to the estimate, so an owner's or collaborator's read
  // never touches `auth` and an existing level always wins (AC-1.5).
  if (
    exit._tag === "Failure" &&
    exit.cause._tag === "Fail" &&
    exit.cause.error instanceof NotFoundError
  ) {
    try {
      if (await holdsReadAll(userId, authHeader)) {
        exit = await Effect.runPromiseExit(getEstimateAsOversight(id));
      }
    } catch (err) {
      if (err instanceof OversightUnavailableError) {
        return c.json(problemAuthzUnavailable(c.req.path), 503);
      }
      throw err;
    }
  }

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    throw unexpectedDbFailure("Unexpected database failure fetching estimate", exit.cause);
  }

  const row = exit.value;
  const { owner, closedBy } = await resolveFullIdentities(authHeader, row);

  // T7 — the precondition value a subsequent PUT must echo via If-Match.
  c.header("ETag", `"${row.version}"`);
  return c.json(toWireFull(row, owner, closedBy), 200);
});

// ─── PUT /estimates/:id — Update ─────────────────────────────────────────────

const updateEstimateRoute = createRoute({
  method: "put",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Update an estimate",
  description:
    "Updates the estimate in place (same id, no duplicate) via optimistic " +
    "concurrency (T7, specs/20260807-estimate-sharing, ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004 — amends " +
    "ADR 20260703-estimate-persistence-jsonb-document's last-write-wins). `If-Match` is REQUIRED and must echo the " +
    "estimate's current `ETag`/`version`; a stale value yields 409, an " +
    "absent or malformed one yields 428. Evaluation order is fixed: " +
    "401 → 400 → 428 → 413 → 404/403 → 409, so a stranger's probe (even " +
    "carrying a syntactically valid If-Match) can never elicit a 409 that " +
    "would confirm the record exists. Owner or editor-level collaborators " +
    "may write; a viewer gets 403 (AC-3.1).",
  request: {
    params: EstimateIdParamSchema,
    headers: z.object({
      // Deliberately z.string().optional() at the SCHEMA level — this is
      // documentation only. `If-Match` is REQUIRED by the *handler*
      // (parseIfMatch → 428), not by zod-openapi's request validation: if
      // this were a required schema field, a missing header would be
      // rejected as a 400 by the framework's own validation, which runs
      // BEFORE the handler body — silently breaking the plan's fixed
      // evaluation order (401 → 400 → 428 → ...) by turning "missing
      // precondition" into the wrong status code entirely.
      "if-match": z
        .string()
        .optional()
        .describe('Required. The estimate\'s current version, e.g. "3" (T7, AC-4.1/4.3/4.4).'),
    }),
    body: {
      required: true,
      content: {
        "application/json": { schema: EstimateUpsertSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: 'Updated estimate (AC-1.2). ETag: "<new version>" (T7).',
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    403: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description:
        'A relationship exists but the caller\'s level is insufficient — code: "insufficient_access" (T7, AC-3.1); or the caller may read the estimate only through estimate:read-all — code: "oversight_read_only" (specs/20261108-estimate-list-oversight)',
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No relationship to this estimate (AC-1.6)",
    },
    409: {
      content: {
        "application/json": { schema: z.union([ConflictProblemSchema, ProblemWithCodeSchema]) },
      },
      description:
        'The stored version no longer matches If-Match — code: "estimate_version_conflict" (T7, AC-4.1/4.3/4.4) — ' +
        'or the estimate is closed (read-only until reopened) — code: "estimate_closed". Nothing was written.',
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Content exceeds MAX_ESTIMATE_BYTES; prior stored version untouched (AC-1.4)",
    },
    428: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description:
        'If-Match is missing or malformed — code: "precondition_required" (T7, AC-4.4).',
    },
  },
});

estimatesRouter.openapi(updateEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const authHeader = c.req.header("Authorization") ?? "";

  // T7 — If-Match is REQUIRED, checked before any size/DB work (fixed
  // evaluation order: 401 → 400 → 428 → 413 → 404/403 → 409). A silent
  // fallback to last-write-wins here would reintroduce exactly the clobber
  // this feature exists to close, across a mixed old/new client fleet.
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  if (expectedVersion === null) {
    return c.json(problemPreconditionRequired(c.req.path), 428);
  }

  // T5: enforce size guard BEFORE any DB write (AC-1.4 — prior version stays intact).
  const sizeErr = checkContentSize(body.content, env.MAX_ESTIMATE_BYTES);
  if (sizeErr) {
    return c.json(
      problemPayloadTooLarge(c.req.path, sizeErr.actualBytes, sizeErr.limitBytes),
      413,
    );
  }

  const effect = updateEstimate(id, userId, expectedVersion, body.name, body.author, body.content);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail") {
      const err = cause.error;
      if (err instanceof NotFoundError) {
        if (await isOversightReadOnly(userId, authHeader, id)) {
          return c.json(problemOversightReadOnly(c.req.path), 403);
        }
        return c.json(problemNotFound(c.req.path, err.message), 404);
      }
      if (err instanceof ForbiddenError) {
        return c.json(problemForbidden(c.req.path, err.message, err.code), 403);
      }
      if (err instanceof EstimateStateError) {
        return c.json(problemEstimateState(c.req.path, err), 409);
      }
      if (err instanceof ConflictError) {
        const lastModifiedBy = await resolveLastModifiedByIdentity(
          authHeader,
          err.lastModifiedByUserId,
        );
        return c.json(
          problemConflict(c.req.path, err.currentVersion, err.updatedAt, lastModifiedBy),
          409,
        );
      }
    }
    throw unexpectedDbFailure("Unexpected database failure updating estimate", exit.cause);
  }

  const row = exit.value;
  // Success means the caller is the owner OR an editor-level collaborator
  // (a viewer can never match the CAS predicate) — resolve the owner
  // identity whenever the caller themselves is not the owner, same rule as
  // GET/list (AC-2.1/10.5).
  // A successful PUT implies the estimate is open, so closedBy is null.
  const { owner, closedBy } = await resolveFullIdentities(authHeader, row);

  // T7 — the new precondition value for the next write.
  c.header("ETag", `"${row.version}"`);
  return c.json(toWireFull(row, owner, closedBy), 200);
});

// ─── DELETE /estimates/:id — Delete ──────────────────────────────────────────

const deleteEstimateRoute = createRoute({
  method: "delete",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Delete an estimate",
  description:
    "Deletes the estimate; every EstimateCollaborator grant cascades away " +
    "(AC-9.1). Owner-only (AC-3.3) — a collaborator (editor or viewer) gets " +
    "403 owner_only, NOT 404, because they already know the estimate exists " +
    "(T6, ADR 20260807-denial-taxonomy-shared-records-403-vs-404). 404 is reserved for callers with no relationship at all.",
  request: {
    params: EstimateIdParamSchema,
  },
  responses: {
    204: {
      description: "Deleted (AC-3.1)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    403: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description:
        "Caller is a collaborator, not the owner — code: owner_only (AC-3.3); or may read the estimate only through estimate:read-all — code: oversight_read_only (specs/20261108-estimate-list-oversight)",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No relationship to this estimate (AC-1.6)",
    },
  },
});

estimatesRouter.openapi(deleteEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const authHeader = c.req.header("Authorization") ?? "";

  const effect = deleteEstimate(id, userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      if (await isOversightReadOnly(userId, authHeader, id)) {
        return c.json(problemOversightReadOnly(c.req.path), 403);
      }
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ForbiddenError) {
      return c.json(
        problemForbidden(c.req.path, cause.error.message, cause.error.code),
        403,
      );
    }
    throw unexpectedDbFailure("Unexpected database failure deleting estimate", exit.cause);
  }

  return new Response(null, { status: 204 });
});

// ─── POST /estimates/import — Bulk import (T6, AC-5.2, AC-5.4) ───────────────
//
// Registered on importEstimatesRouter (not estimatesRouter) so it gets its own,
// larger bodyLimit — see BODY LIMIT DESIGN in the file header.
//
// Each element is processed independently, in its own try/catch (one transaction
// per element). A failure in any element never aborts or rolls back others.
//
// SECURITY (OWASP A01/A04):
//   - userId is ALWAYS taken from c.get('userId') (JWT sub) — never from the body.
//   - The ImportRequestSchema reuses EstimateUpsert which strips id/userId/timestamps,
//     so callers cannot smuggle server-controlled fields (IDOR prevention).
//   - Per-element size guard (checkContentSize) runs before each DB write.
//   - Per-element error messages are sanitized (A09): SizeError messages are
//     user-safe (they name the size limit); DatabaseError is replaced with a
//     generic message to avoid leaking Prisma/DB internals to the wire.
//
// Response contract (plan.md):
//   - 200 as long as the REQUEST ENVELOPE is well-formed (per-element outcomes in results).
//   - 400 if the envelope is malformed (not an array, missing top-level fields).
//   - 401 handled by jwtMiddleware upstream.
//   - 413 if the entire import request body exceeds IMPORT_BODY_SIZE_LIMIT.

const importEstimatesRoute = createRoute({
  method: "post",
  path: "/estimates/import",
  tags: ["Estimates"],
  summary: "Bulk import estimates (one-time migration, US-5)",
  description:
    "Imports a batch of estimates from local storage under the caller's account. " +
    "Each element is imported independently in its own transaction — one failure " +
    "never aborts or rolls back others (AC-5.4). Per-element size guard applies. " +
    "Returns 200 with per-element results as long as the request envelope is well-formed.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: ImportRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportResponseSchema } },
      description: "Batch processed — check each element's status in results (AC-5.2, AC-5.4)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Malformed request envelope (not an array, missing required fields)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Import request body exceeds IMPORT_BODY_SIZE_LIMIT; no elements processed",
    },
  },
});

importEstimatesRouter.openapi(importEstimatesRoute, async (c) => {
  // userId is derived from the JWT sub — never from the request body (OWASP A01).
  const userId = c.get("userId");
  const { estimates } = c.req.valid("json");

  // Process each element independently so one failure cannot abort the batch.
  // We deliberately do NOT use Promise.all here — sequential processing avoids
  // overwhelming the DB connection pool with a large batch (200 elements) and
  // makes the per-element isolation explicit and auditable.
  const results = [];

  for (const element of estimates) {
    const { localId, name, author, content } = element;

    // Per-element size guard (reuses T5's checkContentSize).
    // Over-size → that element is marked failed; others continue (AC-5.4).
    // SizeError.message is user-safe (names the size limit in MB) — safe to wire.
    const sizeErr = checkContentSize(content, env.MAX_ESTIMATE_BYTES);
    if (sizeErr) {
      results.push({
        localId,
        status: "failed" as const,
        error: sizeErr.message,
      });
      continue;
    }

    // Each create runs in its own Effect — a DB error on this element is caught
    // here and marks only this element failed; the loop continues (AC-5.4).
    const exit = await Effect.runPromiseExit(
      createEstimate(userId, name, author, content),
    );

    if (exit._tag === "Success") {
      results.push({
        localId,
        status: "imported" as const,
        id: exit.value.id,
      });
    } else {
      // OWASP A09 — error sanitization at the wire boundary:
      //   SizeError (_tag === "SizeError"): message names the size limit in MB — safe to
      //     forward (e.g. if the caller re-uses this handler for other error types).
      //   DatabaseError: replace with generic message — never forward Prisma/cause
      //     internals (connection strings, table names, constraint names).
      //   Other (e.g. unexpected Die): generic fallback.
      //
      // Note: currently createEstimate only fails with DatabaseError, so the SizeError
      // branch is unreachable in this code path. It is kept as a forward-compatibility
      // guard: if the error union is ever widened (e.g. a retry layer adds SizeError),
      // the sanitization remains correct without further changes. Using _tag
      // discriminant (not instanceof) avoids TypeScript narrowing issues with
      // Data.TaggedError intersections.
      const errorMessage = (() => {
        if (exit.cause._tag !== "Fail") {
          return "Unexpected error while importing estimate";
        }
        const err = exit.cause.error as { _tag: string; message: string };
        if (err._tag === "SizeError") {
          return err.message; // user-safe: "X.X MB; maximum is Y.Y MB. Nothing was saved."
        }
        // DatabaseError or any other typed error — use a generic message.
        return "Failed to import estimate";
      })();
      results.push({
        localId,
        status: "failed" as const,
        error: errorMessage,
      });
    }
  }

  return c.json({ results }, 200);
});
