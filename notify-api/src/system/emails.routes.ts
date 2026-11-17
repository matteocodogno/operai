/**
 * POST /system/emails — internal email-send endpoint (T3,
 * specs/20260713-user-invitations, plan.md §API contracts, ADR 20260714-notify-api-email-channel-service-trust; extended by
 * T7, specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-signed-link-email-delivery for
 * `refund_batch_compiled`).
 *
 * Flow: systemAuthMiddleware scoped to `emails.send` (a service JWT — NOT
 * jwtMiddleware; see systemAuth.middleware.ts's header) → zod-validate body
 * against the per-template discriminated union (system/emails.schemas.ts) →
 * render the fixed template (system/emailTemplates.ts) → the email channel
 * (src/channels/email.channel.ts) sends via Resend (or stubs, per
 * EMAIL_ENABLED) and records one EmailDelivery row.
 *
 * Failure handling (plan.md, ADR 20260714-notify-api-email-channel-service-trust): a Resend/network failure is a SOFT
 * failure. This route always returns 200 with `{ deliveryId, status, error? }`
 * — the caller (auth or refund-api) treats non-"sent" as a signal to show
 * "email failed, resend" rather than ever seeing a 5xx that would fail the
 * triggering request (invitation-create, batch-compile). Only a bad request
 * shape (missing/invalid `to`/`template`/`data`) or a wrong/missing
 * credential produce a non-200.
 *
 * Repeat protection, caller binding and addressing by user id (specs/20261117-legal-entities T56, AC-9.13/9.14,
 * plan "Amendment 2026-11-17 after security review" G1.3-G1.5, G5):
 *  - `idempotencyKey` (optional, scoped to the calling service's `sub`): a repeat after a `sent` attempt answers 200
 *    with the same `deliveryId` and sends nothing; after `failed` attempts alone it sends again. The key reaches
 *    Resend as `<sub>:<key>` (its `Idempotency-Key`; Resend keeps keys for 24 hours — the window that remains for
 *    a repeat Resend itself would recognise, while notify-api's own record has no expiry).
 *  - EMAIL_TEMPLATE_POLICY: a template may be bound to the callers allowed to send it (403 `template_not_allowed`,
 *    nothing written) and may allow `recipientId` addressing (every other template: 400). A template absent from the
 *    table is open to every `emails.send` holder and takes `to` only — as before.
 *  - `recipientId` (a template that allows it): notify-api resolves the address from auth (ADR 20261101); inactive
 *    user -> 200 `skipped` / `recipient_inactive`, lookup failure -> 200 `failed` / `contact_lookup_failed`, the
 *    email-notice env group unset -> 200 `skipped` / `not_configured`. None of these has an address, so none writes
 *    a delivery row.
 *
 * Body-size cap (413): the payload is small by construction (an email address,
 * an enum, a handful of short strings) — 16 KiB is a generous-but-bounded
 * envelope cap, mirroring raise.routes.ts's precedent.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { emailChannel } from "@/channels/email.channel";
import { findSentDelivery } from "@/channels/emailDelivery.repo";
import { userContact, type UserContactClient } from "@/lib/userContact";
import { zodIssuesHook } from "@/lib/zodHook";
import { env } from "@/lib/env";
import { Effect } from "effect";
import { z } from "zod";
import { ProblemSchema, problem } from "@/notifications/notifications.schemas";
import { renderEmailTemplate } from "./emailTemplates";
import { SendEmailRequestSchema, SendEmailResponseSchema } from "./emails.schemas";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";
import type { MiddlewareHandler } from "hono";

const SYSTEM_EMAILS_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

/**
 * Who may send a template, and how it may be addressed (specs/20261117-legal-entities T56).
 *  - `callers`: the service `sub`s allowed to send it; any other caller -> 403 `template_not_allowed` before
 *    anything is written. Absent = every holder of `emails.send`.
 *  - `allowRecipientId`: the template may be addressed by an auth user id instead of an address. Absent = it may
 *    not (a body naming `recipientId` for it is a 400), so no other caller gains "mail any user by id".
 * A template absent from the table behaves as every template did before T56.
 */
export type EmailTemplatePolicy = {
  readonly callers?: readonly string[];
  readonly allowRecipientId?: boolean;
};

/** Production table. `legal_entity_change` (bound to `system:auth`, `recipientId` allowed) is added with the template (T57). */
export const EMAIL_TEMPLATE_POLICY: Readonly<Record<string, EmailTemplatePolicy>> = {};

/** What the route needs beyond the channel; injected in tests, production reads the env. */
export type SystemEmailsDeps = {
  policy: Readonly<Record<string, EmailTemplatePolicy>>;
  /** `null` = the email-notice env group is not configured: every `recipientId` send is `skipped`. */
  contacts: UserContactClient | null;
  appBaseUrl: string | undefined;
};

const defaultDeps = (): SystemEmailsDeps => ({
  policy: EMAIL_TEMPLATE_POLICY,
  contacts: userContact,
  appBaseUrl: env.APP_BASE_URL,
});

const EmailProblemSchema = ProblemSchema.extend({ code: z.string().optional() });

/** Factory so tests can inject the auth middleware (in-memory JWKS), the template table and the lookup; production uses the default export. */
export const createSystemEmailsRouter = (
  authMiddleware: MiddlewareHandler<{ Variables: SystemAuthVariables }>,
  injected: Partial<SystemEmailsDeps> = {},
) => {
  const deps: SystemEmailsDeps = { ...defaultDeps(), ...injected };
  const systemEmailsRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>({ defaultHook: zodIssuesHook });

  // Scoped to this router's ONE exact path only — NEVER `.use("*", …)`. See
  // raise.routes.ts's file header for why a "*" middleware on any sub-router
  // mounted in index.ts would leak onto every other route once merged,
  // including GET /notifications/stream (ADR 20260713-sse-stream-auth-short-lived-ticket, no-Bearer) and every
  // jwtMiddleware-protected route (which must NEVER accept this internal
  // token — ADR 20260714-notify-api-email-channel-service-trust's mutual-exclusion invariant).
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

  systemEmailsRouter.use("/system/emails", authMiddleware);

  const sendEmailRoute = createRoute({
    method: "post",
    path: "/system/emails",
    tags: ["System"],
    summary: "Send a transactional email via the internal email channel",
    description:
      "Internal-only endpoint authenticated by a service JWT with scope " +
      "`emails.send` (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired) — never a user JWT. Renders a fixed, per-template escaped template and sends " +
      "via Resend, recording an EmailDelivery row. A Resend/network failure is " +
      'a soft failure surfaced as {"status":"failed"}, never a 5xx. An optional `idempotencyKey` (scoped to the ' +
      "calling service) makes a repeat safe: after a `sent` attempt the repeat answers 200 with the same " +
      "`deliveryId` and sends nothing. A template may be bound to specific callers (403 `template_not_allowed`) and " +
      "may be addressed by `recipientId` (an auth user id) instead of `to` — exactly one of the two.",
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
          "Send attempted — status reflects the outcome (sent or failed); a repeat of a sent key answers `sent` " +
          "with the first attempt's deliveryId. With `recipientId`: `skipped` (recipient_inactive, not_configured) " +
          "or `failed` (contact_lookup_failed), with no deliveryId.",
      },
      400: {
        content: { "application/json": { schema: EmailProblemSchema } },
        description:
          "Bad `to` (not a valid email), unrecognised `template`, `to` and `recipientId` both or neither, or " +
          "`recipientId` for a template that does not allow it",
      },
      401: {
        content: { "application/json": { schema: ProblemSchema } },
        description: "Missing or invalid credential, or a credential without the `emails.send` scope",
      },
      403: {
        content: { "application/json": { schema: EmailProblemSchema } },
        description:
          "The template is bound to other callers (`code: template_not_allowed`); nothing is written",
      },
      413: {
        content: { "application/json": { schema: ProblemSchema } },
        description: "Request body exceeds the size cap",
      },
    },
  });

  systemEmailsRouter.openapi(sendEmailRoute, async (c) => {
    const body = c.req.valid("json");
    const callerSub = c.get("serviceSub");
    const policy = deps.policy[body.template];

    // Per-template caller binding (T56, AC-9.13): before anything is read, resolved or written.
    if (policy?.callers !== undefined && !policy.callers.includes(callerSub)) {
      return c.json(
        {
          ...problem(403, "Forbidden", "This service principal may not send that template.", c.req.path),
          code: "template_not_allowed",
        },
        403,
      );
    }

    // `recipientId` only for a template that allows it: no other template gains "mail any user by id".
    if (body.recipientId !== undefined && policy?.allowRecipientId !== true) {
      return c.json(
        {
          ...problem(400, "Bad Request", "recipientId is not accepted for that template; send `to`.", c.req.path),
          code: "recipient_id_not_allowed",
        },
        400,
      );
    }

    const idempotency =
      body.idempotencyKey !== undefined
        ? { callerSub, idempotencyKey: body.idempotencyKey }
        : undefined;

    let to = body.to;
    if (body.recipientId !== undefined) {
      // A repeat of a delivered send answers with the first result BEFORE the address is looked up: the lookup is
      // an outbound call to auth and its answer (the user may be inactive by now) must not undo a delivered send.
      if (idempotency) {
        const prior = await Effect.runPromiseExit(findSentDelivery(idempotency));
        if (prior._tag === "Failure") throw new Error("Unexpected database failure looking up email delivery");
        if (prior.value) return c.json({ deliveryId: prior.value.id, status: "sent" as const }, 200);
      }

      if (deps.contacts === null || deps.appBaseUrl === undefined) {
        return c.json({ status: "skipped" as const, reason: "not_configured" as const }, 200);
      }
      const contact = await deps.contacts.lookup(body.recipientId);
      if (contact.status === "inactive") {
        return c.json({ status: "skipped" as const, reason: "recipient_inactive" as const }, 200);
      }
      if (contact.status === "failed") {
        return c.json({ status: "failed" as const, reason: "contact_lookup_failed" as const }, 200);
      }
      to = contact.email;
    }

    // The schema guarantees exactly one of `to` / `recipientId`; both paths above leave an address in `to`.
    if (to === undefined) throw new Error("email address was not resolved");

    const { subject, html } = renderEmailTemplate(body);

    const result = await emailChannel.send({
      to,
      template: body.template,
      subject,
      html,
      idempotency,
    });

    if (result.status === "failed") {
      return c.json(
        { deliveryId: result.deliveryId, status: "failed" as const, error: result.error },
        200,
      );
    }

    return c.json({ deliveryId: result.deliveryId, status: "sent" as const }, 200);
  });

  return systemEmailsRouter;
};

export const systemEmailsRouter = createSystemEmailsRouter(
  createSystemAuthMiddleware({ scope: "emails.send" }),
);
