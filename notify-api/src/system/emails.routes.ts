/**
 * POST /system/emails — internal email-send endpoint (T3,
 * specs/006-user-invitations, plan.md §API contracts, ADR-0011).
 *
 * Flow: internalTokenMiddleware (X-Internal-Token, NOT jwtMiddleware — see
 * that file's header for the mutual-exclusion invariant) → zod-validate body
 * → render the fixed bilingual template (system/emailTemplates.ts) → the
 * email channel (src/channels/email.channel.ts) sends via Resend (or stubs,
 * per EMAIL_ENABLED) and records one EmailDelivery row.
 *
 * Failure handling (plan.md, ADR-0011): a Resend/network failure is a SOFT
 * failure. This route always returns 200 with `{ deliveryId, status, error? }`
 * — auth (the caller) treats non-"sent" as a signal to show "email failed,
 * resend" rather than ever seeing a 5xx that would fail the invitation-create
 * request. Only a bad request shape (missing/invalid `to`/`template`/`data`)
 * or a wrong/missing internal token produce a non-200.
 *
 * Body-size cap (413): the payload is small by construction (an email address,
 * an enum, three short strings) — 16 KiB is a generous-but-bounded envelope
 * cap, mirroring raise.routes.ts's precedent.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { emailChannel } from "@/channels/email.channel";
import { ProblemSchema, problem } from "@/notifications/notifications.schemas";
import { renderEmailTemplate } from "./emailTemplates";
import { SendEmailRequestSchema, SendEmailResponseSchema } from "./emails.schemas";
import { internalTokenMiddleware } from "./internalToken.middleware";

const SYSTEM_EMAILS_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

export const systemEmailsRouter = new OpenAPIHono();

// Scoped to this router's ONE exact path only — NEVER `.use("*", …)`. See
// raise.routes.ts's file header for why a "*" middleware on any sub-router
// mounted in index.ts would leak onto every other route once merged,
// including GET /notifications/stream (ADR-0008, no-Bearer) and every
// jwtMiddleware-protected route (which must NEVER accept this internal
// token — ADR-0011's mutual-exclusion invariant).
systemEmailsRouter.use(
  "/system/emails",
  bodyLimit({
    maxSize: SYSTEM_EMAILS_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        problem(
          413,
          "Payload Too Large",
          `Request body exceeds the maximum allowed size of ${(SYSTEM_EMAILS_BODY_SIZE_LIMIT / 1024).toFixed(0)} KB.`,
          c.req.path,
        ),
        413,
      ),
  }),
);

systemEmailsRouter.use("/system/emails", internalTokenMiddleware);

const sendEmailRoute = createRoute({
  method: "post",
  path: "/system/emails",
  tags: ["System"],
  summary: "Send a transactional email via the internal email channel",
  description:
    "Internal-only endpoint authenticated by X-Internal-Token (ADR-0011) — " +
    "never a user JWT. Renders a fixed bilingual (IT+EN) template and sends " +
    "via Resend, recording an EmailDelivery row. A Resend/network failure is " +
    'a soft failure surfaced as {"status":"failed"}, never a 5xx.',
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SendEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SendEmailResponseSchema } },
      description:
        "Send attempted — status reflects the outcome (sent or failed)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Bad `to` (not a valid email) or unrecognised `template`",
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

systemEmailsRouter.openapi(sendEmailRoute, async (c) => {
  const body = c.req.valid("json");
  const { subject, html } = renderEmailTemplate(body.template, body.data);

  const result = await emailChannel.send({
    to: body.to,
    template: body.template,
    subject,
    html,
  });

  if (result.status === "failed") {
    return c.json(
      { deliveryId: result.deliveryId, status: "failed" as const, error: result.error },
      200,
    );
  }

  return c.json({ deliveryId: result.deliveryId, status: "sent" as const }, 200);
});
