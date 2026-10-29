/**
 * refund-api → notify-api internal cross-user in-app push client (T13,
 * specs/007-refund-service, plan.md "On decision → notify the employee"
 * (AC-3.6), ADR-0017; +`notifyPaid`, T6, specs/008-refund-monthly-processing,
 * plan.md § Email "Employee `paid` push (US-5, AC-5.1)").
 *
 * Deliberately isolated in its own module — mirrors `auth/src/lib/notify.ts`'s
 * pattern for calling out to another Operai service (and this service's own
 * `authz/resolveClient.ts`, T6) — so `decide.routes.ts` and its tests can
 * `mock.module()` this single function rather than mocking global `fetch`.
 *
 * Calls the internal, NON-user-JWT `POST /system/notifications` (ADR-0017),
 * authenticated as refund-api itself with the scoped 5-minute service JWT
 * from `serviceToken.ts` (`Authorization: Bearer`, scope `notifications.push`;
 * specs/016, ADR-0044/0049, which retired the shared internal token; notify-api
 * binds `system:refund-api` to `originApp: "refund"`) — deliberately NOT the deciding accounting user's own Bearer JWT, because the
 * recipient is a DIFFERENT user (the request's owner), not the caller.
 *
 * BEST-EFFORT (ADR-0017 §4): this function NEVER throws. A non-2xx response
 * or a network failure is caught and logged — no financial/PII detail in the
 * log, only the request id and outcome. `decide.routes.ts` awaits this AFTER
 * its own decision transaction has already committed and must never roll
 * back or fail the HTTP response because of a notify failure — the decision
 * recorded in refund-api's own database is the source of truth; the employee
 * always sees the outcome on their next `GET /requests/:id` regardless of
 * push delivery.
 *
 * Copy is English-only (specs/007's i18n-for-v1 decision — see refund-ui's
 * `strings.ts` doc comment for the same call made on the frontend side; no
 * bilingual IT+EN string here either) and deliberately generic: no rejection
 * motivation or amount is included in the push body (ADR-0017 Compliance
 * notes — "no attachment content or full financial detail, only a status
 * summary and a link"); the full outcome is only ever visible after the
 * employee opens the already access-controlled `GET /requests/:id`.
 */

import { postToNotify, type NotifyTransport } from "./notifyPost";

export type DecisionOutcome = "approved" | "rejected";

export interface NotifyDecisionInput {
  readonly recipientId: string;
  readonly requestId: string;
  readonly outcome: DecisionOutcome;
}

const COPY: Record<
  DecisionOutcome,
  { title: string; body: string; severity: "success" | "warning" }
> = {
  approved: {
    title: "Refund approved",
    body: "Your refund request has been approved.",
    severity: "success",
  },
  rejected: {
    title: "Refund rejected",
    body: "Your refund request has been rejected.",
    severity: "warning",
  },
};

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/notifications` with the service Bearer.
 * See plan.md's contract:
 *   { recipientId, originApp:"refund", severity, title, body, link:{href} }
 *
 * Never throws — every failure path (token unobtainable, network, non-2xx) is
 * caught and logged internally. `transport` is for tests.
 */
export async function notifyDecision(
  input: NotifyDecisionInput,
  transport?: NotifyTransport,
): Promise<void> {
  const copy = COPY[input.outcome];

  try {
    const response = await postToNotify(
      "/system/notifications",
      {
        recipientId: input.recipientId,
        originApp: "refund",
        severity: copy.severity,
        title: copy.title,
        body: copy.body,
        link: { href: `/refund/requests/${input.requestId}` },
      },
      transport,
    );

    if (!response.ok) {
      console.error(
        `[notify] POST /system/notifications responded with HTTP ${response.status} ` +
          `for refund request ${input.requestId} (${input.outcome}) — decision NOT rolled back`,
      );
    }
  } catch (error) {
    console.error(
      `[notify] failed to reach notify-api for refund request ${input.requestId} ` +
        `(${input.outcome}) — decision NOT rolled back:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// ─── Mark-paid fan-out (T6, specs/008-refund-monthly-processing, US-5) ─────

export interface NotifyPaidInput {
  readonly recipientId: string;
  readonly requestId: string;
}

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/notifications` (service Bearer) — one call per included
 * request's OWNER (`recipientId`), fired after mark-paid's transaction has
 * committed (batches/decide.routes.ts). Copy is deliberately generic — "no
 * amount/other-employee detail in the push" (plan.md § Email, ADR-0017
 * posture); the concrete `paid` state + `paidAt` live behind the already
 * access-controlled `GET /requests/:id`.
 *
 * Never throws — every failure path is caught and logged internally (same
 * contract as `notifyDecision` above).
 */
export async function notifyPaid(
  input: NotifyPaidInput,
  transport?: NotifyTransport,
): Promise<void> {
  try {
    const response = await postToNotify(
      "/system/notifications",
      {
        recipientId: input.recipientId,
        originApp: "refund",
        severity: "success",
        title: "Refund paid",
        body: "Your refund request has been paid.",
        link: { href: `/refund/requests/${input.requestId}` },
      },
      transport,
    );

    if (!response.ok) {
      console.error(
        `[notify] POST /system/notifications responded with HTTP ${response.status} ` +
          `for refund request ${input.requestId} (paid) — mark-paid NOT rolled back`,
      );
    }
  } catch (error) {
    console.error(
      `[notify] failed to reach notify-api for refund request ${input.requestId} ` +
        "(paid) — mark-paid NOT rolled back:",
      error instanceof Error ? error.message : error,
    );
  }
}
