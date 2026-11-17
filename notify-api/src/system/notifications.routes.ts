/**
 * POST /system/notifications — internal cross-user in-app push endpoint
 * (T3, specs/20260716-refund-service, plan.md "On decision → notify the
 * employee" (AC-3.6), ADR 20260716-system-notifications-cross-user-trigger).
 *
 * Structurally mirrors emails.routes.ts (T3, specs/20260713-user-invitations,
 * ADR 20260714-notify-api-email-channel-service-trust): systemAuthMiddleware scoped to `notifications.push` (a service
 * JWT — NOT jwtMiddleware; see
 * systemAuth.middleware.ts's header for the invariant that ALSO applies to
 * this route) → zod-validate body → the
 * SAME inApp channel the user-JWT POST /notifications already uses
 * (src/channels/inApp.channel.ts) → persist + SSE-push.
 *
 * This is the cross-user capability ADR 20260713-notification-center-standalone-service-shell-seam reserved and ADR 20260716-system-notifications-cross-user-trigger now
 * activates: `recipientId` is taken directly from the trusted internal
 * request body — never from a caller's own JWT `sub` — because the caller
 * (refund-api) is notifying a DIFFERENT user (the request's owner) than
 * itself. This is safe ONLY because the route is gated by the internal
 * token, not a user JWT; the user-facing POST /notifications route
 * deliberately has no `recipient` field at all (OWASP A01, ADR 20260713-notification-center-standalone-service-shell-seam) and
 * this route must never be reachable via a user Bearer JWT.
 *
 * Failure handling (ADR 20260716-system-notifications-cross-user-trigger "best-effort, not transactional with the
 * decision"): unlike /system/emails, the inApp channel has no soft-failure
 * branch — a database failure surfaces as a thrown Error, caught by
 * app.onError as a 500 Problem JSON. This is fine: refund-api calls this
 * endpoint AFTER its own decision transaction has already committed, logs
 * failures, and never rolls back or retries synchronously on a non-2xx
 * response (plan.md, ADR 20260716-system-notifications-cross-user-trigger §4).
 *
 * Body-size cap (413): the payload is small by construction (title <=200
 * chars, body <=2000 chars, link <=2000 chars, a recipientId) — 16 KiB
 * mirrors raise.routes.ts's and emails.routes.ts's precedent.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { emailChannel } from "@/channels/email.channel";
import { inAppChannel } from "@/channels/inApp.channel";
import { env } from "@/lib/env";
import { zodIssuesHook } from "@/lib/zodHook";
import { userContact, type UserContactClient } from "@/lib/userContact";
import { ProblemSchema, problem, type NotificationDto } from "@/notifications/notifications.schemas";
import {
  createSystemAuthMiddleware,
  originAllowed,
  type SystemAuthVariables,
} from "./systemAuth.middleware";
import { renderEmailTemplate } from "./emailTemplates";
import { NotificationSchema } from "@/notifications/notifications.schemas";
import {
  SystemNotificationRequestSchema,
  SystemNotificationResponseSchema,
} from "./notifications.schemas";

const SYSTEM_NOTIFICATIONS_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

/**
 * What an email notice needs beyond the in-app push (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth).
 * `null` contacts / base URL = the env group is not configured: every email
 * request is answered `skipped`. Injected in tests; production reads env.
 */
export type EmailNoticeDeps = {
  contacts: UserContactClient | null;
  appBaseUrl: string | undefined;
  /** The email channel; tests inject a recording one. */
  channel?: Pick<typeof emailChannel, "send">;
};

const defaultEmailNoticeDeps = (): EmailNoticeDeps => ({
  contacts: userContact,
  appBaseUrl: env.APP_BASE_URL,
});

type EmailStatus = "sent" | "failed" | "skipped";

const sendNotice = async (
  deps: EmailNoticeDeps,
  request: { recipientId: string; originApp: string },
  created: { title: string; body: string; link?: { href: string } | undefined },
): Promise<EmailStatus> => {
  if (deps.contacts === null || deps.appBaseUrl === undefined) return "skipped";
  try {
    const contact = await deps.contacts.lookup(request.recipientId);
    if (contact.status === "inactive") return "skipped";
    if (contact.status === "failed") return "failed";

    const { subject, html } = renderEmailTemplate({
      template: "notification_notice",
      data: {
        title: created.title,
        body: created.body,
        originApp: request.originApp,
        appBaseUrl: deps.appBaseUrl,
        href: created.link?.href,
      },
    });
    const result = await (deps.channel ?? emailChannel).send({
      to: contact.email,
      template: "notification_notice",
      subject,
      html,
    });
    return result.status;
  } catch (error) {
    // E.g. the delivery row could not be written. Never a 5xx for an email.
    console.error(
      "[system-notifications] email notice failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return "failed";
  }
};

/** Factory so tests can inject the auth middleware (in-memory JWKS) and the lookup; production uses the default export. */
export const createSystemNotificationsRouter = (
  authMiddleware: MiddlewareHandler<{ Variables: SystemAuthVariables }>,
  emailNotice: EmailNoticeDeps = defaultEmailNoticeDeps(),
) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({ defaultHook: zodIssuesHook });

  // Scoped to this router's ONE exact path only — NEVER `.use("*", …)`. See
  // raise.routes.ts's and emails.routes.ts's file headers for why a "*"
  // middleware on any sub-router mounted in index.ts would leak onto every
  // other route once merged — including GET /notifications/stream (ADR 20260713-sse-stream-auth-short-lived-ticket,
  // no-Bearer) and every jwtMiddleware-protected route (which must NEVER
  // accept a service credential, and vice versa — the user and service
  // audiences are kept apart, ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049).
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
      "(aud=SERVICE_AUDIENCE, scope notifications.push, ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049) — never a user JWT. Routes through the same inApp " +
      "channel the user-JWT POST /notifications uses, persisting a " +
      "Notification row for `recipientId` and pushing it over that " +
      "recipient's open SSE streams. `recipientId` may be any user, " +
      "including one other than the caller — the cross-user capability " +
      "ADR 20260713-notification-center-standalone-service-shell-seam reserved and this route activates. An optional `it: {title, body}` " +
      "carries an Italian rendering (ADR 20261104-bilingual-system-notifications): stored, returned by the list and " +
      "the SSE payload, and chosen by the reader from its interface language. An optional `idempotencyKey` " +
      "(1-200 of [A-Za-z0-9._:-], scoped to the calling service) makes a repeat safe: the first call answers " +
      "201, a repeat with the same key answers 200 with the stored notification and sends nothing new.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: SystemNotificationRequestSchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: NotificationSchema } },
        description:
          "A repeat: the request carried an `idempotencyKey` this calling service had already used. The " +
          "notification stored by the first call is returned; nothing is published, pushed or mailed.",
      },
      201: {
        content: { "application/json": { schema: SystemNotificationResponseSchema } },
        description: "Notification created for recipientId and published to its SSE streams. " +
          "With `email: true` the body also carries `emailStatus` (sent | failed | skipped); " +
          "an email problem never changes the status code.",
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
          "it is not bound to (e.g. system:inventory-api may send only `inventory`), " +
          "or asked for `email: true` with a token that lacks the `emails.send` scope " +
          "(nothing is written in either case)",
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
    // (ADR 20261006-scoped-service-jwt-fourth-notify-caller).
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

    // An email is a capability of its own (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired, specs/20261101-crm-notifications D-3): refuse
    // BEFORE anything is written.
    if (body.email === true && !c.get("scopes").includes("emails.send")) {
      return c.json(
        problem(
          403,
          "Forbidden",
          "Sending an email notice requires the emails.send scope.",
          c.req.path,
        ),
        403,
      );
    }

    const input = {
      recipientId: body.recipientId,
      title: body.title,
      body: body.body,
      severity: body.severity,
      originApp: body.originApp,
      link: body.link,
      it: body.it,
      toastWorthy: false,
    };

    // Repeat protection (specs/20261117-legal-entities T56, AC-9.14): a key scoped to the calling service. The
    // origin and scope checks above ran first, so a repeat is held to the same rules as the first call. A repeat
    // answers 200 with the stored row and does nothing else — no SSE event, no push, no email (so `email: true`
    // on a repeat is never acted on, and `emailStatus` is absent).
    let created: NotificationDto;
    if (body.idempotencyKey !== undefined) {
      const once = await inAppChannel.sendOnce(input, {
        callerSub: c.get("serviceSub"),
        idempotencyKey: body.idempotencyKey,
      });
      if (once.replayed) return c.json(once.notification, 200);
      created = once.notification;
    } else {
      created = await inAppChannel.send(input);
    }

    if (body.email !== true) return c.json(created, 201);

    // Best-effort, after the row exists: whatever happens, the 201 stands.
    const emailStatus = await sendNotice(emailNotice, body, created);
    return c.json({ ...created, emailStatus }, 201);
  });

  return router;
};

export const systemNotificationsRouter = createSystemNotificationsRouter(
  createSystemAuthMiddleware({ scope: "notifications.push" }),
);
