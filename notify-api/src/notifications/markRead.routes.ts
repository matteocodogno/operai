/**
 * POST /notifications/mark-all-read (T6, specs/005-notification-center, US-3).
 *
 * Sets readAt := now() for every currently-unread notification belonging to the
 * caller (recipientId := JWT sub). Idempotent by construction: notifications.repo's
 * markAllRead() updateMany() against `readAt: null` naturally returns count:0 when
 * nothing is unread — no separate "already all read" branch (AC-3.4).
 *
 * Side effect (US-3, AC-3.1 across tabs): publishes an `unread-reset` event to the
 * EventBus so every one of the caller's open SSE streams (T7) clears its badge —
 * not just the tab that issued the mark-all-read call.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { eventBus } from "./eventBus";
import { markAllRead } from "./notifications.repo";
import { MarkAllReadResponseSchema, ProblemSchema } from "./notifications.schemas";

export const markReadRouter = new OpenAPIHono<{ Variables: JwtVariables }>();

// jwtMiddleware is scoped to this router's ONE exact path only — NEVER
// `.use("*", jwtMiddleware)`. index.ts mounts every notifications router at
// the same prefix (`app.route("/", markReadRouter)` etc.), and Hono merges
// each child router's middleware into ONE flat route table once mounted — a
// "*" registered on ANY sub-router therefore gates the WHOLE app, including
// `GET /notifications/stream`, which per ADR-0008 MUST be reachable WITHOUT a
// Bearer (EventSource cannot send one; it is authed by the query-string
// ticket instead). This mirrors the precedent already documented in
// stream.routes.ts's stream-ticket route.
markReadRouter.use("/notifications/mark-all-read", jwtMiddleware);

const markAllReadRoute = createRoute({
  method: "post",
  path: "/notifications/mark-all-read",
  tags: ["Notifications"],
  summary: "Mark all of the caller's unread notifications as read",
  description:
    "Sets readAt := now() for every currently-unread notification owned by the caller. " +
    "Idempotent — returns { updated: 0, count: 0 } when nothing was unread (AC-3.4). " +
    "Publishes an unread-reset event to all of the caller's open SSE streams (AC-3.1).",
  responses: {
    200: {
      content: { "application/json": { schema: MarkAllReadResponseSchema } },
      description: "Notifications marked read (AC-3.1, AC-3.4)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

markReadRouter.openapi(markAllReadRoute, async (c) => {
  const recipientId = c.get("userId");

  const effect = markAllRead(recipientId);
  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure marking notifications as read");
  }

  const updated = exit.value;

  // Broadcast to every open stream for this sub — including sibling tabs that
  // did not issue this call (AC-3.1 "across tabs"). Fired even when updated===0
  // so a sibling tab's optimistic local state stays reconciled with the caller.
  eventBus.publish(recipientId, { type: "unread-reset", data: { count: 0 } });

  return c.json({ updated, count: 0 as const }, 200);
});
