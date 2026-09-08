/**
 * refund-api → notify-api internal compilation-email client (T5,
 * specs/008-refund-monthly-processing, plan.md § Email, ADR-0021).
 *
 * Mirrors `notify.ts`'s pattern for calling out to another Operai service —
 * isolated in its own module so `batches/email.ts` and its tests can
 * `mock.module()` this one function rather than mocking global `fetch`.
 *
 * Calls the internal, NON-user-JWT `POST /system/emails` (ADR-0011),
 * authenticated by the shared `NOTIFY_INTERNAL_TOKEN` (`X-Internal-Token`) —
 * refund-api becomes a SECOND caller of this endpoint (alongside `auth`'s
 * invitation emails), using the SAME shared secret (ADR-0011's named
 * "second internal caller" escalation trigger, knowingly not acted on yet —
 * see ADR-0017's identical posture for `/system/notifications`).
 *
 * The email body carries an APP DEEP LINK (`batchUrl`), never a presigned
 * S3 URL and never a PDF attachment (AC-3.5, ADR-0021 — "no standalone,
 * unauthenticated, or permanent access"). The recipient must sign in and
 * pass the SAME `request:review` authz check as any in-app batch view
 * before a short-lived presigned GET is ever minted (GET
 * /batches/:id/pdf-url, T4).
 *
 * BEST-EFFORT (ADR-0011 posture): this function NEVER throws. A non-2xx
 * response, a malformed body, or a network failure is caught and mapped to
 * `{status:"failed", deliveryId:null}` — no financial/PII detail in the
 * log, only the batch id and outcome. The caller (`batches/email.ts`)
 * awaits this AFTER the compile transaction has already committed and must
 * never roll back or fail the HTTP response because of an email failure
 * (AC-3.1/3.3) — refund-api's own database (`emailStatus`) is the source of
 * truth for "was an email attempted and how did it go", surfaced in-app.
 */

import { env } from "./env";

export interface NotifyBatchCompiledInput {
  readonly batchId: string;
  /** The batch's own id, used as its human-facing reference (plan.md's `batchReference: "<id>"`). */
  readonly batchReference: string;
  readonly cutoff: Date;
  readonly generatedAt: Date;
  readonly requestCount: number;
  /** The single configured distribution address — specs/011-refund-settings, resolved LIVE from the `accounting-distribution-email` refund_setting at each attempt (ADR-0029, never a per-employee address, never a value baked in at a previous deploy). */
  readonly recipientEmail: string;
}

export interface NotifyBatchCompiledOutcome {
  readonly status: "sent" | "failed";
  readonly deliveryId: string | null;
}

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/emails` with `X-Internal-Token`. See
 * plan.md's contract:
 *   { to, template:"refund_batch_compiled",
 *     data: { batchUrl, batchReference, cutoff, generatedAt, requestCount } }
 *
 * Never throws — every failure path is caught and mapped to a "failed"
 * outcome.
 */
export async function notifyBatchCompiled(
  input: NotifyBatchCompiledInput,
): Promise<NotifyBatchCompiledOutcome> {
  try {
    const response = await fetch(`${env.NOTIFY_INTERNAL_URL}/system/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.NOTIFY_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        to: input.recipientEmail,
        template: "refund_batch_compiled",
        data: {
          batchUrl: `${env.REFUND_APP_BASE_URL}/refund/batches/${input.batchId}`,
          batchReference: input.batchReference,
          cutoff: input.cutoff.toISOString(),
          generatedAt: input.generatedAt.toISOString(),
          requestCount: input.requestCount,
        },
      }),
    });

    if (!response.ok) {
      console.error(
        `[notifyEmail] POST /system/emails responded with HTTP ${response.status} ` +
          `for refund batch ${input.batchId} — compile/resend NOT rolled back`,
      );
      return { status: "failed", deliveryId: null };
    }

    const body = (await response.json()) as {
      deliveryId: string;
      status: "sent" | "failed";
      error?: string;
    };
    return { status: body.status, deliveryId: body.deliveryId };
  } catch (error) {
    console.error(
      `[notifyEmail] failed to reach notify-api for refund batch ${input.batchId} — ` +
        "compile/resend NOT rolled back:",
      error instanceof Error ? error.message : error,
    );
    return { status: "failed", deliveryId: null };
  }
}

// ─── Decision emails (specs/007-refund-service AC-3.6, email channel) ───────

export interface NotifyDecisionEmailInput {
  readonly requestId: string;
  /**
   * The request owner's address. Taken from the `ownerEmail` SNAPSHOT stored
   * on the request at creation time, not resolved live from `auth`.
   *
   * That is the deliberate choice, and it is the opposite of what estimai-api
   * does for collaborator display (ADR-0039's live id→identity lookup). The
   * reasoning differs because the use differs: ADR-0039 resolves live so a
   * shared estimate never implies an ACTIVE account that no longer exists;
   * here the address is a delivery target for a financial decision about a
   * request THIS person filed, and the snapshot is the address they filed it
   * under. Resolving live would also put `auth` on the decision path, which
   * ADR-0036's "no hard runtime dependency" posture avoids, and would make a
   * decision email fail for a soft-deleted employee who still has money owed.
   */
  readonly recipientEmail: string;
  readonly decidedAt: Date;
  /** Approved total per currency, integer minor units. Approved decisions only. */
  readonly approvedTotals: readonly { currency: string; amountCents: number }[];
}

export interface NotifyDecisionEmailOutcome {
  readonly status: "sent" | "failed";
  readonly deliveryId: string | null;
}

/**
 * The approve/reject decision email — a SECOND channel for the same event
 * `notify.ts`'s in-app push already covers (AC-3.6). Both are best-effort and
 * independent: an email failure must not suppress the in-app notification,
 * and neither may touch the decision, which has already committed by the time
 * this runs (ADR-0017 §4).
 *
 * Never throws — every failure path is caught and mapped to a "failed"
 * outcome, mirroring `notifyBatchCompiled` above. Unlike a batch's
 * `emailStatus`, this outcome is NOT persisted: a decision has no per-attempt
 * delivery-provenance column and no resend surface, so the return value is
 * for the caller's log line only. Adding a resend later means adding that
 * column first.
 *
 * The rejected variant sends no amount and no motivation (see
 * notify-api's `emails.schemas.ts`) — `approvedTotals` is ignored for it
 * rather than being an optional field on a shared shape, so a rejection can
 * never carry a figure even by mistake.
 */
export async function notifyDecisionEmail(
  outcome: "approved" | "rejected",
  input: NotifyDecisionEmailInput,
): Promise<NotifyDecisionEmailOutcome> {
  const requestUrl = `${env.REFUND_APP_BASE_URL}/refund/requests/${input.requestId}`;
  const body =
    outcome === "approved"
      ? {
          to: input.recipientEmail,
          template: "refund_decision_approved",
          data: {
            requestUrl,
            decidedAt: input.decidedAt.toISOString(),
            approvedTotals: input.approvedTotals,
          },
        }
      : {
          to: input.recipientEmail,
          template: "refund_decision_rejected",
          data: { requestUrl, decidedAt: input.decidedAt.toISOString() },
        };

  try {
    const response = await fetch(`${env.NOTIFY_INTERNAL_URL}/system/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.NOTIFY_INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // The request id identifies the row; the recipient address and the
      // approved figures are deliberately NOT logged (CLAUDE.md "Data
      // residency" — no business data in the hosting provider's logs).
      console.error(
        `[notifyEmail] POST /system/emails responded with HTTP ${response.status} ` +
          `for refund request ${input.requestId} (${outcome}) — decision NOT rolled back`,
      );
      return { status: "failed", deliveryId: null };
    }

    const parsed = (await response.json()) as {
      deliveryId: string;
      status: "sent" | "failed";
      error?: string;
    };
    return { status: parsed.status, deliveryId: parsed.deliveryId };
  } catch (error) {
    console.error(
      `[notifyEmail] failed to reach notify-api for refund request ${input.requestId} ` +
        `(${outcome}) — decision NOT rolled back:`,
      error instanceof Error ? error.message : error,
    );
    return { status: "failed", deliveryId: null };
  }
}
