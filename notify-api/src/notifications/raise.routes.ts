/**
 * POST /notifications — raise endpoint (T4, specs/005-notification-center,
 * plan.md §API contracts / §Architecture "raise → persist → push → badge" sequence).
 *
 * Flow: jwtMiddleware (ADR-0005 + ADR-0010) → zod-validate body → INSERT
 * (recipientId := JWT sub) → publish() the event to the EventBus (T3) so every
 * open SSE stream for that sub receives it (T7 wires the consumption side).
 *
 * SECURITY (OWASP A01 — never trust the body for identity):
 *   RaiseNotificationSchema has no recipient/recipientId field at all (see
 *   notifications.schemas.ts file header). recipientId is derived exclusively
 *   from c.get('userId'), which jwtMiddleware sets from the verified JWT `sub`.
 *   Even a caller that sends `{ "recipient": "someone-else" }` in the raw body
 *   has that key silently stripped by zod before the handler ever runs.
 *
 * Body-size cap (413): the raise payload is small by construction (title
 * <=200 chars, body <=2000 chars, link <=2000 chars) — a generous-but-bounded
 * 16 KiB envelope cap catches abuse before it reaches zod validation, mirroring
 * estimai-api's bodyLimit pattern (estimates.routes.ts BODY LIMIT DESIGN).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { eventBus } from "./eventBus";
import { createNotification } from "./notifications.repo";
import {
  NotificationSchema,
  ProblemSchema,
  RaiseNotificationSchema,
  problem,
} from "./notifications.schemas";

// Raise payloads are small by construction (see file header) — 16 KiB is a
// generous-but-bounded envelope cap, well above any legitimate title+body+link.
const RAISE_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

export const raiseRouter = new OpenAPIHono<{ Variables: JwtVariables }>();

// Both middlewares below are scoped to this router's ONE exact path only —
// NEVER `.use("*", …)`. index.ts mounts every notifications router at the
// same prefix (`app.route("/", raiseRouter)` etc.), and Hono merges each
// child router's middleware into ONE flat route table once mounted — a "*"
// registered on ANY sub-router therefore applies to the WHOLE app, including
// `GET /notifications/stream`, which per ADR-0008 MUST be reachable WITHOUT a
// Bearer (EventSource cannot send one; it is authed by the query-string
// ticket instead). This mirrors the precedent already documented in
// stream.routes.ts's stream-ticket route.
raiseRouter.use(
  "/notifications",
  bodyLimit({
    maxSize: RAISE_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        problem(
          413,
          "Payload Too Large",
          `Request body exceeds the maximum allowed size of ${(RAISE_BODY_SIZE_LIMIT / 1024).toFixed(0)} KB.`,
          c.req.path,
        ),
        413,
      ),
  }),
);

raiseRouter.use("/notifications", jwtMiddleware);

const raiseRoute = createRoute({
  method: "post",
  path: "/notifications",
  tags: ["Notifications"],
  summary: "Raise a notification for the caller",
  description:
    "Persists a new notification for the caller (recipientId is always the JWT sub — " +
    "any recipient field in the body is ignored, OWASP A01) and publishes it to the " +
    "caller's open SSE streams.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RaiseNotificationSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: NotificationSchema } },
      description: "Notification created (AC-4.1..4.4)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description:
        "Validation error — missing/empty title or body, bad severity/originApp enum, or a non-relative link.href (AC-4.5)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request body exceeds the size cap",
    },
  },
});

raiseRouter.openapi(raiseRoute, async (c) => {
  // recipientId is ALWAYS the JWT sub — never the body (OWASP A01). The zod
  // schema doesn't even declare a recipient field, so nothing to strip-check here.
  const recipientId = c.get("userId");
  const body = c.req.valid("json");

  const effect = createNotification({
    recipientId,
    title: body.title,
    body: body.body,
    severity: body.severity,
    originApp: body.originApp,
    link: body.link,
    toastWorthy: body.toast,
  });

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure creating notification");
  }

  const created = exit.value;

  // Publish AFTER persistence succeeds — the DB is the source of truth (plan.md
  // Risk R3/R5); a dropped publish never loses the notification, only the live push.
  eventBus.publish(recipientId, {
    type: "notification",
    data: created,
  });

  return c.json(created, 201);
});
