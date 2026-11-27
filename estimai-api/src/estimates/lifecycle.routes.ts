/**
 * Close / reopen an estimate — the CRM's "estimate ready" signal.
 *
 *   POST /estimates/{id}/close   → 200 EstimateFull, ETag: "<new version>"
 *   POST /estimates/{id}/reopen  → 200 EstimateFull, ETag: "<new version>"
 *
 * A closed estimate is READ-ONLY for everybody until reopened (PUT answers
 * 409 `estimate_closed`); DELETE and collaborator management stay allowed.
 *
 * Access and concurrency mirror PUT /estimates/{id} exactly (ADR 20260807-denial-taxonomy-shared-records-403-vs-404/0038):
 * owner or `editor` collaborator; a viewer gets 403 `insufficient_access`, no
 * relationship 404; `If-Match: "<version>"` is REQUIRED (absent/malformed →
 * 428, stale → 409 `estimate_version_conflict`, same problem shape as PUT).
 * Closing a closed estimate → 409 `estimate_already_closed`; reopening an open
 * one → 409 `estimate_not_closed`. The access predicate, the version CAS and
 * the expected state are ONE `updateMany` (estimates.repo.ts
 * `setEstimateClosed`), so the check and the write are atomic. Fixed
 * evaluation order: 401 → 428 → 404/403 → 409.
 *
 * After the write COMMITS, the change is pushed to crm-api
 * (`src/lib/crmNotices.ts`), awaited but best-effort: it never fails or rolls
 * back the request, and it is never sent for a refused request.
 *
 * A registration FUNCTION with injectable deps (the collaborators.routes.ts
 * pattern) rather than module-level imports, so route tests pass doubles for
 * the CRM notifier and identity resolver without `mock.module()` — which in a
 * shared `bun test` process would leak into other test files. Called on
 * `estimatesRouter` in index.ts BEFORE it is mounted, so these routes inherit
 * its bodyLimit + jwtMiddleware and reach the OpenAPI document.
 */

import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { unexpectedDbFailure } from "@/lib/dbFailure";
import type { JwtVariables } from "@/auth/jwt.middleware";
import { resolveIdentities as realResolveIdentities } from "@/lib/authClient";
import {
  sendEstimateNotice as realSendEstimateNotice,
  type EstimateNoticeEvent,
  type SendEstimateNotice,
} from "@/lib/crmNotices";
import { ConflictError, EstimateStateError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { setEstimateClosed, type LifecycleTransition } from "./estimates.repo";
import { isOversightReadOnly } from "./oversight";
import { EstimateFullSchema, EstimateIdParamSchema } from "./estimates.schemas";
import {
  ConflictProblemSchema,
  ProblemSchema,
  ProblemWithCodeSchema,
  UNKNOWN_IDENTITY,
  parseIfMatch,
  problemConflict,
  problemEstimateState,
  problemForbidden,
  problemNotFound,
  problemOversightReadOnly,
  problemPreconditionRequired,
  resolveFullIdentities,
  resolveIdentityFor,
  toWireFull,
  type IdentityResolver,
} from "./estimates.wire";

export interface LifecycleRouteDeps {
  readonly sendEstimateNotice: SendEstimateNotice;
  readonly resolveIdentities: IdentityResolver;
}

const defaultDeps: LifecycleRouteDeps = {
  sendEstimateNotice: realSendEstimateNotice,
  resolveIdentities: realResolveIdentities,
};

const EVENT: Record<LifecycleTransition, EstimateNoticeEvent> = {
  close: "closed",
  reopen: "reopened",
};

const ifMatchHeader = z.object({
  // Optional at the SCHEMA level on purpose (same as PUT): a required schema
  // field would turn a missing precondition into the framework's 400 before
  // the handler runs, instead of the contract's 428.
  "if-match": z
    .string()
    .optional()
    .describe('Required. The estimate\'s current version, e.g. "3".'),
});

const buildRoute = (transition: LifecycleTransition) => {
  const closing = transition === "close";
  return createRoute({
    method: "post",
    path: `/estimates/{id}/${transition}`,
    tags: ["Estimates"],
    summary: closing ? "Close an estimate" : "Reopen a closed estimate",
    description: closing
      ? "Marks the estimate closed: read-only for everybody until reopened, and pushed to " +
        "crm-api as ready (best effort, after commit). Owner or editor; If-Match REQUIRED " +
        "(same contract as PUT). Bumps the version by 1."
      : "Reopens a closed estimate so it can be edited again, and pushes the change to " +
        "crm-api (best effort, after commit). Owner or editor; If-Match REQUIRED " +
        "(same contract as PUT). Bumps the version by 1.",
    request: { params: EstimateIdParamSchema, headers: ifMatchHeader },
    responses: {
      200: {
        content: { "application/json": { schema: EstimateFullSchema } },
        description: `Estimate ${closing ? "closed" : "reopened"}. ETag: "<new version>".`,
      },
      401: {
        content: { "application/json": { schema: ProblemSchema } },
        description: "Missing or invalid Bearer JWT",
      },
      403: {
        content: { "application/json": { schema: ProblemWithCodeSchema } },
        description:
          'The caller is a viewer — code: "insufficient_access"; or may read the estimate only through estimate:read-all — code: "oversight_read_only"',
      },
      404: {
        content: { "application/json": { schema: ProblemSchema } },
        description: "No relationship to this estimate",
      },
      409: {
        content: {
          "application/json": { schema: z.union([ConflictProblemSchema, ProblemWithCodeSchema]) },
        },
        description: closing
          ? 'Already closed — code: "estimate_already_closed"; or a stale If-Match — code: "estimate_version_conflict". Nothing was written.'
          : 'Not closed — code: "estimate_not_closed"; or a stale If-Match — code: "estimate_version_conflict". Nothing was written.',
      },
      428: {
        content: { "application/json": { schema: ProblemWithCodeSchema } },
        description: 'If-Match is missing or malformed — code: "precondition_required"',
      },
    },
  });
};

export function registerEstimateLifecycleRoutes(
  router: OpenAPIHono<{ Variables: JwtVariables }>,
  deps: LifecycleRouteDeps = defaultDeps,
): void {
  for (const transition of ["close", "reopen"] as const) {
    router.openapi(buildRoute(transition), async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const authHeader = c.req.header("Authorization") ?? "";

      const expectedVersion = parseIfMatch(c.req.header("If-Match"));
      if (expectedVersion === null) {
        return c.json(problemPreconditionRequired(c.req.path), 428);
      }

      const exit = await Effect.runPromiseExit(
        setEstimateClosed(id, userId, expectedVersion, transition),
      );

      if (exit._tag === "Failure") {
        const cause = exit.cause;
        if (cause._tag === "Fail") {
          const err = cause.error;
          if (err instanceof NotFoundError) {
            // No relationship: a read-all holder may read this estimate, not change it (AC-1.4).
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
            const lastModifiedBy =
              err.lastModifiedByUserId === null
                ? UNKNOWN_IDENTITY
                : await resolveIdentityFor(authHeader, err.lastModifiedByUserId, deps.resolveIdentities);
            return c.json(
              problemConflict(c.req.path, err.currentVersion, err.updatedAt, lastModifiedBy),
              409,
            );
          }
        }
        throw unexpectedDbFailure(`Unexpected database failure on estimate ${transition}`, exit.cause);
      }

      const row = exit.value;

      // The write has committed — push to crm-api. Never throws (crmNotices.ts);
      // the extra catch is defence in depth against an injected double.
      try {
        await deps.sendEstimateNotice({
          estimateId: row.id,
          event: EVENT[transition],
          version: row.version,
          at: row.updatedAt,
          byUserId: userId,
        });
      } catch (error) {
        console.error(
          `[lifecycle] estimate notice threw unexpectedly for estimate ${row.id} — the change was NOT rolled back:`,
          error instanceof Error ? error.message : "unknown error",
        );
      }

      const { owner, closedBy } = await resolveFullIdentities(authHeader, row, deps.resolveIdentities);
      c.header("ETag", `"${row.version}"`);
      return c.json(toWireFull(row, owner, closedBy), 200);
    });
  }
}
