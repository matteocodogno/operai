/**
 * Accounting review queue endpoint (T11, specs/007-refund-service).
 *
 *   GET /review/requests → 200 [{id,owner,submittedAt,subtotals}]
 *                           (submitted ∧ in the caller's entity scope)
 *
 * `GET /requests/:id` — the full-detail read accounting also uses (AC-6.1/
 * 6.3/6.4/6.5/6.6) — is the SAME shared route requests.routes.ts registers
 * (T7's `canReadRequest` already evaluates the owner-OR-in-scope-accounting
 * predicate); nothing new is added here for it.
 *
 * Denial semantics (plan.md § API contracts, ADR-0015):
 *   - No `request:review` grant AT ALL → 403 (capability-absent, AC-5.4).
 *   - A conditioned grant whose scope matches zero submitted requests, or
 *     whose caller has no resolved `entity` attribute → 200 with an EMPTY
 *     array (the capability itself is present — this is not a 403; matches
 *     AC-5.6's "does not appear in their queue at all").
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { ProblemSchema } from "../requests/requests.schemas";
import { listReviewQueueRequests } from "./review.repo";
import { ReviewQueueItemSchema } from "./review.schemas";
import { filterQueueInScope, mapQueueItem, scopeForReviewAction } from "./review.service";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const reviewRouter = new OpenAPIHono<{ Variables: AuthzVariables }>();

reviewRouter.use("/review/requests", jwtMiddleware);
reviewRouter.use("/review/requests", authzMiddleware);

// ─── GET /review/requests — accounting queue ───────────────────────────────

const listQueueRoute = createRoute({
  method: "get",
  path: "/review/requests",
  tags: ["Review"],
  summary: "List the accounting review queue",
  description:
    "Every `submitted` request containing at least one line for an entity " +
    "the caller is scoped to (AC-5.1/5.5/5.6); an unconditioned " +
    "`request:review` grant sees every submitted request regardless of " +
    "entity (AC-5.5, 'global'). 403 if the caller holds no `request:review` " +
    "grant at all (AC-5.4).",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: z.array(ReviewQueueItemSchema) } },
      description: "Queue rows, oldest-submitted-first (may be empty)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:review` capability",
    },
  },
});

reviewRouter.openapi(listQueueRoute, async (c) => {
  const authz = c.get("authz");

  const scope = scopeForReviewAction(authz, "review");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to review refund requests"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(listReviewQueueRequests());
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing the review queue");
  }

  if (scope === null) {
    return c.json([], 200);
  }

  const inScope = filterQueueInScope(exit.value, scope);
  return c.json(inScope.map(mapQueueItem), 200);
});
