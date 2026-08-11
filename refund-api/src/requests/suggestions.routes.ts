/**
 * `GET /line-suggestions` — the employee's own past `travel_km` trip
 * signatures, grouped, ranked and capped (T5, specs/014-motivo-autocomplete).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ MOUNTED AT TOP LEVEL — NEVER UNDER `/requests/…`.                        │
 * │                                                                          │
 * │ `requestsRouter` is registered FIRST in src/index.ts and owns            │
 * │ `GET /requests/{id}`. A sibling path like `/requests/line-suggestions`   │
 * │ would be swallowed by it as `id = "line-suggestions"` and answered with  │
 * │ that route's ownership 404 — a silent, total feature outage that no      │
 * │ type checker can catch. `suggestions.routes.test.ts` pins this with a    │
 * │ registration-order regression test; do not "tidy" the path into the      │
 * │ requests namespace.                                                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * A SEPARATE router from `requestsRouter`/`linesRouter` for two reasons:
 * the path is not in their namespace (above), and its validation-failure
 * contract is **400** (matching `rates/effective.routes.ts`'s query-validation
 * convention, plan § API contracts) rather than `linesRouter`'s 422-for-bodies.
 *
 * ── Authorization (plan D4 / ADR-0042) ──────────────────────────────────────
 *
 * Gated by the EXISTING `request:read` capability. No new catalog resource, no
 * new permission, no `auth` change of any kind: this route returns a strictly
 * data-minimised PROJECTION of the very rows `request:read` already authorises
 * the caller to read (any holder can reconstruct this corpus by hand from
 * `GET /requests` + `GET /requests/{id}`), so a separate `suggestion:read`
 * grant could withhold nothing while implying a control that does not exist.
 *
 * Two enforcement properties, both deliberate:
 *
 *  1. Capability absent → **403**, never 404. There is no record being
 *     addressed here, so there is no existence to hide (ADR-0014 point 3,
 *     matching `GET /requests` exactly). No 404 path exists on this route at
 *     all, so there is no ADR-0005/0037-style 403-vs-404 question to answer.
 *  2. The handler **IGNORES THE GRANT'S CONDITIONS ENTIRELY** and scopes to
 *     the JWT `sub` unconditionally. This is what makes AC-4.2 structural
 *     rather than incidental: a caller holding an unconditioned/global
 *     `request:review` — or even a hypothetically unconditioned
 *     `request:read` — still gets exactly their own lines, because
 *     `fetchTravelKmTriples` takes no scope argument at all and widening is
 *     therefore inexpressible. ADR-0015's entity-scope predicate is
 *     deliberately NOT consulted: it is a review concept, this is a
 *     self-scoped read.
 *
 * `authzMiddleware` still fails CLOSED (503) on an `auth` outage, unchanged
 * (ADR-0014 point 4). The client swallows that silently (AC-5.2) — that is a
 * client-side posture, not a server-side weakening.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 *
 * `Cache-Control: no-store` (plan D7): the response is personal data returned
 * under an `Authorization` header, and a private browser cache MAY otherwise
 * write such a response to disk (RFC 9111). Nothing here logs a motivo, and
 * the request carries no query text to log in the first place (plan D1) —
 * `src/lib/logger.ts` is path-only and must not be bypassed by a route-local
 * `console.log`.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ProblemSchema } from "./requests.schemas";
import { fetchTravelKmTriples } from "./suggestions.repo";
import { buildTripSuggestions } from "./suggestions.service";
import {
  SuggestionsQuerySchema,
  SuggestionsResponseSchema,
} from "./suggestions.schemas";

/** The path, as one constant, so the registration test cannot drift from the route. */
export const LINE_SUGGESTIONS_PATH = "/line-suggestions";

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

export const suggestionsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
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

suggestionsRouter.use(LINE_SUGGESTIONS_PATH, jwtMiddleware);
suggestionsRouter.use(LINE_SUGGESTIONS_PATH, authzMiddleware);

const lineSuggestionsRoute = createRoute({
  method: "get",
  path: LINE_SUGGESTIONS_PATH,
  tags: ["Suggestions"],
  summary: "The caller's own past travel_km trip signatures",
  description:
    "Returns the CALLER'S OWN distinct past mileage trips — folded motivo, " +
    "distance, entity, how many lines the trip groups, and its most recent " +
    "expense date — for the last 24 months, pre-ranked and capped at 200 " +
    "(AC-2.1/2.3/2.4). Strictly self-scoped: the owner is the verified JWT " +
    "`sub` and there is no parameter of any kind through which another " +
    "subject could be addressed (AC-4.1/4.2/4.3). Gated by the existing " +
    "`request:read` capability; the grant's conditions are deliberately " +
    "ignored, so a global `request:review` grants no additional reach. " +
    "`Cache-Control: no-store` — this is personal data and is never written " +
    "to a browser's disk cache.",
  security: [{ Bearer: [] }],
  request: { query: SuggestionsQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: SuggestionsResponseSchema } },
      description: "The caller's own ranked trip signatures (0..200)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "`type` missing, not `travel_km`, or an unknown query parameter present",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:read` capability",
    },
    503: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Authorization service unavailable (fail-closed, ADR-0014)",
    },
  },
});

suggestionsRouter.openapi(lineSuggestionsRoute, async (c) => {
  const authz = c.get("authz");
  const { type } = c.req.valid("query");

  // Set before any branch, so the 403 is as uncacheable as the 200.
  c.header("Cache-Control", "no-store");

  if (!hasCapability(authz.permissions, "request", "read")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to read refund requests"),
      403,
    );
  }

  // `c.get("userId")` is the verified JWT `sub` set by jwtMiddleware — the
  // ONLY thing that ever scopes this read. Note what is NOT passed:
  // `authz.permissions`, `authz.entity`, and nothing at all off the query.
  const ownerUserId = c.get("userId");

  const exit = await Effect.runPromiseExit(fetchTravelKmTriples(ownerUserId));
  if (exit._tag === "Failure") {
    // Bubble to the global RFC 7807 handler (src/index.ts app.onError). The
    // message deliberately names no user and no motivo.
    throw new Error("Unexpected database failure loading trip suggestions");
  }

  return c.json({ type, suggestions: buildTripSuggestions(exit.value) }, 200);
});
