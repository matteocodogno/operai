/**
 * refund-api → notify-api internal cross-user in-app push client (T13,
 * specs/007-refund-service, plan.md "On decision → notify the employee"
 * (AC-3.6), ADR-0017).
 *
 * Deliberately isolated in its own module — mirrors `auth/src/lib/notify.ts`'s
 * pattern for calling out to another Operai service (and this service's own
 * `authz/resolveClient.ts`, T6) — so `decide.routes.ts` and its tests can
 * `mock.module()` this single function rather than mocking global `fetch`.
 *
 * Calls the internal, NON-user-JWT `POST /system/notifications` (ADR-0017),
 * authenticated by the shared `NOTIFY_INTERNAL_TOKEN` (`X-Internal-Token`) —
 * deliberately NOT the deciding accounting user's own Bearer JWT, because the
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
 * Copy is bilingual (IT + EN in one string, mirroring `auth`'s hosted
 * invite-page convention — signin/invite copy has no per-user locale to
 * select from either) and deliberately generic: no rejection motivation or
 * amount is included in the push body (ADR-0017 Compliance notes — "no
 * attachment content or full financial detail, only a status summary and a
 * link"); the full outcome is only ever visible after the employee opens the
 * already access-controlled `GET /requests/:id`.
 */

import { env } from "./env";

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
    title: "Rimborso approvato · Refund approved",
    body:
      "La tua richiesta di rimborso è stata approvata. · " +
      "Your refund request has been approved.",
    severity: "success",
  },
  rejected: {
    title: "Rimborso respinto · Refund rejected",
    body:
      "La tua richiesta di rimborso è stata respinta. · " +
      "Your refund request has been rejected.",
    severity: "warning",
  },
};

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/notifications` with `X-Internal-Token`.
 * See plan.md's contract:
 *   { recipientId, originApp:"refund", severity, title, body, link:{href} }
 *
 * Never throws — every failure path is caught and logged internally.
 */
export async function notifyDecision(input: NotifyDecisionInput): Promise<void> {
  const copy = COPY[input.outcome];

  try {
    const response = await fetch(`${env.NOTIFY_INTERNAL_URL}/system/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.NOTIFY_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        recipientId: input.recipientId,
        originApp: "refund",
        severity: copy.severity,
        title: copy.title,
        body: copy.body,
        link: { href: `/refund/requests/${input.requestId}` },
      }),
    });

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
