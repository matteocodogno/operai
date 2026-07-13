/**
 * GET /notifications (list) + GET /notifications/unread-count
 * (T5, specs/005-notification-center, plan.md §API contracts, US-2/US-6).
 *
 * Both routes are jwtMiddleware-protected (ADR-0005 + ADR-0010) and scoped
 * exclusively by recipientId := JWT sub — never from a query/path parameter.
 *
 * DRIFT NOTE (reported to the caller, not silently resolved): tasks.md T5's
 * "done when" line says "… not-owned → 404 (ADR-0005)", and plan.md's AC-6.2
 * test-strategy row says "B fetching A's id → 404". Neither plan.md's
 * §API contracts section for GET /notifications (a pure list, no :id path
 * param) nor the rest of this spec defines any single-notification-by-id GET
 * endpoint — there is no id to be "not owned" against. This appears to be
 * language carried over from estimai-api's GET /estimates/{id} pattern that
 * doesn't apply to notify-api's list-only contract. Implemented here: GET
 * /notifications is scoped strictly to recipientId (AC-6.2 — user B's list
 * can structurally never contain user A's rows), which is the literal,
 * documented API surface. No id-based 404 path exists because no such route
 * is specified. Flagged in the T5 return for the caller to confirm/amend
 * tasks.md or plan.md.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { countUnread, listNotifications } from "./notifications.repo";
import {
  ListQuerySchema,
  ListResponseSchema,
  ProblemSchema,
  UnreadCountResponseSchema,
} from "./notifications.schemas";

export const listRouter = new OpenAPIHono<{ Variables: JwtVariables }>();

// jwtMiddleware is scoped to this router's TWO exact paths only — NEVER
// `.use("*", jwtMiddleware)`. index.ts mounts every notifications router at
// the same prefix (`app.route("/", listRouter)` etc.), and Hono merges each
// child router's middleware into ONE flat route table once mounted — a "*"
// registered on ANY sub-router therefore gates the WHOLE app, including
// `GET /notifications/stream`, which per ADR-0008 MUST be reachable WITHOUT a
// Bearer (EventSource cannot send one; it is authed by the query-string
// ticket instead). This mirrors the precedent already documented in
// stream.routes.ts's stream-ticket route.
listRouter.use("/notifications", jwtMiddleware);
listRouter.use("/notifications/unread-count", jwtMiddleware);

// ─── GET /notifications — list, newest-first, cursor-paginated ──────────────

const listRoute = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["Notifications"],
  summary: "List the caller's notifications",
  description:
    "Returns the caller's notifications newest-first (AC-2.3), cursor-paginated. " +
    "Returns { items: [], nextCursor: null } for a caller with none — not an error (AC-2.4). " +
    "Strictly scoped to the JWT sub — never returns another user's notifications (AC-6.2).",
  request: {
    query: ListQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ListResponseSchema } },
      description: "Page of notifications (AC-2.3, AC-2.4, AC-6.2)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

listRouter.openapi(listRoute, async (c) => {
  const recipientId = c.get("userId");
  const { limit, cursor } = c.req.valid("query");

  const effect = listNotifications(recipientId, limit, cursor);
  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing notifications");
  }

  return c.json(exit.value, 200);
});

// ─── GET /notifications/unread-count — bell seed / reconnect resync ─────────

const unreadCountRoute = createRoute({
  method: "get",
  path: "/notifications/unread-count",
  tags: ["Notifications"],
  summary: "Get the caller's exact unread notification count",
  description:
    "Exact server truth for the caller's unread count — the client formats the '9+' cap. " +
    "Used to seed the bell badge and to resync on SSE (re)connect (US-1).",
  responses: {
    200: {
      content: { "application/json": { schema: UnreadCountResponseSchema } },
      description: "Unread count (AC-1.2, AC-1.3, AC-6.1)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

listRouter.openapi(unreadCountRoute, async (c) => {
  const recipientId = c.get("userId");

  const effect = countUnread(recipientId);
  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure counting unread notifications");
  }

  return c.json({ count: exit.value }, 200);
});
