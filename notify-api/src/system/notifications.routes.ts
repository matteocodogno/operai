/**
 * POST /system/notifications — internal cross-user in-app push endpoint
 * (T3, specs/007-refund-service, plan.md "On decision → notify the
 * employee" (AC-3.6), ADR-0017).
 *
 * Structurally mirrors emails.routes.ts (T3, specs/006-user-invitations,
 * ADR-0011): systemAuthMiddleware scoped to `notifications.push` (a service
 * JWT, or the transition-only X-Internal-Token — NOT jwtMiddleware; see
 * systemAuth.middleware.ts's header for the invariant that ALSO applies to
 * this route) → zod-validate body → the
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
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { inAppChannel } from "@/channels/inApp.channel";
import { ProblemSchema, problem } from "@/notifications/notifications.schemas";
import {
  createSystemAuthMiddleware,
  originAllowed,
  type SystemAuthVariables,
} from "./systemAuth.middleware";
import {
  SystemNotificationRequestSchema,
  SystemNotificationResponseSchema,
} from "./notifications.schemas";

const SYSTEM_NOTIFICATIONS_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

/** Factory so tests can inject the auth middleware (in-memory JWKS); production uses the default export. */
export const createSystemNotificationsRouter = (
  authMiddleware: MiddlewareHandler<{ Variables: SystemAuthVariables }>,
) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>();

  // Scoped to this router's ONE exact path only — NEVER `.use("*", …)`. See
  // raise.routes.ts's and emails.routes.ts's file headers for why a "*"
  // middleware on any sub-router mounted in index.ts would leak onto every
  // other route once merged — including GET /notifications/stream (ADR-0008,
  // no-Bearer) and every jwtMiddleware-protected route (which must NEVER
  // accept this internal token — ADR-0011's mutual-exclusion invariant,
  // reused verbatim by ADR-0017 for this second internal caller).
  router.use(
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

  router.use("/system/notifications", authMiddleware);

  const sendSystemNotificationRoute = createRoute({
    method: "post",
    path: "/system/notifications",
    tags: ["System"],
    summary: "Push an in-app notification to an arbitrary recipient (cross-user)",
    description:
      "Internal-only endpoint authenticated by a scoped service JWT " +
      "(aud=SERVICE_AUDIENCE, scope notifications.push, ADR-0044/0049) or, " +
      "during the transition, the shared X-Internal-Token (ADR-0017) — never a user JWT. Routes through the same inApp " +
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
        description:
          "Missing or invalid credential, or a service JWT without the " +
          "notifications.push scope (identical body for every cause)",
      },
      403: {
        content: { "application/json": { schema: ProblemSchema } },
        description:
          "A service principal tried to raise a notification for an originApp " +
          "it is not bound to (e.g. system:inventory-api may send only `inventory`)",
      },
      413: {
        content: { "application/json": { schema: ProblemSchema } },
        description: "Request body exceeds the size cap",
      },
    },
  });

  router.openapi(sendSystemNotificationRoute, async (c) => {
    const body = c.req.valid("json");

    // Service principals may raise only the origin app(s) bound to their `sub`
    // (ADR-0044). null = legacy internal token, unrestricted (unchanged).
    if (!originAllowed(c.get("allowedOrigins"), body.originApp)) {
      return c.json(
        problem(
          403,
          "Forbidden",
          "This service principal may not raise notifications for that originApp.",
          c.req.path,
        ),
        403,
      );
    }

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

  return router;
};

export const systemNotificationsRouter = createSystemNotificationsRouter(
  createSystemAuthMiddleware({ scope: "notifications.push" }),
);
