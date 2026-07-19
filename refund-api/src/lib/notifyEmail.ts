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
  /** The single configured distribution address (`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`, snapshotted on the batch at compile time — AC-3.4, never a per-employee address). */
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
