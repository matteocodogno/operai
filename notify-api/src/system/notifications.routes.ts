/**
 * POST /system/notifications — internal cross-user in-app push endpoint
 * (T3, specs/007-refund-service, plan.md "On decision → notify the
 * employee" (AC-3.6), ADR-0017).
 *
 * Structurally mirrors emails.routes.ts (T3, specs/006-user-invitations,
 * ADR-0011): internalTokenMiddleware (X-Internal-Token, NOT jwtMiddleware —
 * see internalToken.middleware.ts's header for the mutual-exclusion
 * invariant that ALSO applies to this route) → zod-validate body → the
 * SAME inApp channel the user-JWT POST /notifications already uses
 * (src/channels/inApp.channel.ts) → persist + SSE-push.
 *
 * This is the cross-user capability ADR-0009 reserved and ADR-0017 now
 * activates: `recipientId` is taken directly from the trusted internal
 * request body — never from a caller's own JWT `sub` — because the caller
 * (refund-api) is notifying a DIFFERENT user (the request's owner) than
 * itself. This is safe ONLY because the route is gated by the internal
 * token, not a user JWT; the user-facing POST /notifications route
 * deliberately has no `recipient` field at all (OWASP A01, ADR-0009) and
 * this route must never be reachable via a user Bearer JWT.
 *
 * Failure handling (ADR-0017 "best-effort, not transactional with the
 * decision"): unlike /system/emails, the inApp channel has no soft-failure
 * branch — a database failure surfaces as a thrown Error, caught by
 * app.onError as a 500 Problem JSON. This is fine: refund-api calls this
 * endpoint AFTER its own decision transaction has already committed, logs
 * failures, and never rolls back or retries synchronously on a non-2xx
 * response (plan.md, ADR-0017 §4).
 *
 * Body-size cap (413): the payload is small by construction (title <=200
 * chars, body <=2000 chars, link <=2000 chars, a recipientId) — 16 KiB
 * mirrors raise.routes.ts's and emails.routes.ts's precedent.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { inAppChannel } from "@/channels/inApp.channel";
import { ProblemSchema, problem } from "@/notifications/notifications.schemas";
import { internalTokenMiddleware } from "./internalToken.middleware";
import {
  SystemNotificationRequestSchema,
  SystemNotificationResponseSchema,
} from "./notifications.schemas";

const SYSTEM_NOTIFICATIONS_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

export const systemNotificationsRouter = new OpenAPIHono();

// Scoped to this router's ONE exact path only — NEVER `.use("*", …)`. See
// raise.routes.ts's and emails.routes.ts's file headers for why a "*"
// middleware on any sub-router mounted in index.ts would leak onto every
// other route once merged — including GET /notifications/stream (ADR-0008,
// no-Bearer) and every jwtMiddleware-protected route (which must NEVER
// accept this internal token — ADR-0011's mutual-exclusion invariant,
// reused verbatim by ADR-0017 for this second internal caller).
systemNotificationsRouter.use(
  "/system/notifications",
  bodyLimit({
    maxSize: SYSTEM_NOTIFICATIONS_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        problem(
          413,
          "Payload Too Large",
          `Request body exceeds the maximum allowed size of ${(SYSTEM_NOTIFICATIONS_BODY_SIZE_LIMIT / 1024).toFixed(0)} KB.`,
          c.req.path,
        ),
        413,
      ),
  }),
);

systemNotificationsRouter.use("/system/notifications", internalTokenMiddleware);

const sendSystemNotificationRoute = createRoute({
  method: "post",
  path: "/system/notifications",
  tags: ["System"],
  summary: "Push an in-app notification to an arbitrary recipient (cross-user)",
  description:
    "Internal-only endpoint authenticated by X-Internal-Token (ADR-0011, " +
    "reused by ADR-0017) — never a user JWT. Routes through the same inApp " +
    "channel the user-JWT POST /notifications uses, persisting a " +
    "Notification row for `recipientId` and pushing it over that " +
    "recipient's open SSE streams. `recipientId` may be any user, " +
    "including one other than the caller — the cross-user capability " +
    "ADR-0009 reserved and this route activates.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SystemNotificationRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: SystemNotificationResponseSchema } },
      description: "Notification created for recipientId and published to its SSE streams",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description:
        "Validation error — missing/empty recipientId, title, or body, bad " +
        "severity/originApp enum, or a non-relative link.href",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid X-Internal-Token",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request body exceeds the size cap",
    },
  },
});

systemNotificationsRouter.openapi(sendSystemNotificationRoute, async (c) => {
  const body = c.req.valid("json");

  const created = await inAppChannel.send({
    recipientId: body.recipientId,
    title: body.title,
    body: body.body,
    severity: body.severity,
    originApp: body.originApp,
    link: body.link,
    toastWorthy: false,
  });

  return c.json(created, 201);
});
