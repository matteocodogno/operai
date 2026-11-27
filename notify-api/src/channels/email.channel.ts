/**
 * email channel (T2, specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust).
 *
 * Addresses a RAW email address (never a `sub`) — there is no Notification
 * row and no SSE push for this channel; it renders no template itself (the
 * caller, T3's /system/emails route, renders the bilingual subject/html and
 * hands this channel the finished `subject`/`html` plus a `template` label
 * used only for the EmailDelivery audit column). Sends via Resend
 * (src/lib/resend.ts) and ALWAYS records one EmailDelivery row per attempt,
 * whether the send succeeds, fails, or is stubbed.
 *
 * EMAIL_ENABLED=false (test/local default, ADR 20260714-notify-api-email-channel-service-trust): the real Resend call is
 * skipped entirely — the send is stubbed and recorded as "sent" with a
 * SYNTHETIC providerId (prefixed `stub_`, never a real Resend message id), so
 * tests and local dev never need a Resend account and never make a real
 * network call. The EmailDelivery row itself always has a real DB-generated
 * `id` — only `providerId` is synthetic in this mode.
 *
 * Failure handling (plan.md §API contracts, ADR 20260714-notify-api-email-channel-service-trust): a Resend/network
 * failure is a SOFT failure — recorded as EmailDelivery.status="failed" and
 * returned as `{ status: "failed", error }`, never thrown/never a 5xx. Only a
 * failure to WRITE the EmailDelivery row itself (a genuine DB outage) throws,
 * matching notifications.repo.ts's convention of surfacing DB failures as an
 * uncaught Error for app.onError to turn into a 500.
 */

import { unexpectedDbFailure } from "@/lib/dbFailure";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/resend";
import type { IdempotencyScope } from "@/notifications/notifications.repo";
import type { Channel } from "./channel";
import {
  DeliveryAlreadySent,
  findSentDelivery,
  recordEmailDelivery,
  type RecordEmailDeliveryInput,
} from "./emailDelivery.repo";

export const EMAIL_TEMPLATES = [
  "invitation",
  "invitation_resend",
  // specs/20260719-refund-monthly-processing T7 (ADR 20260719-refund-batch-signed-link-email-delivery) — the compiled-batch
  // notification email. Carries an in-app deep link only (never an
  // attachment, never a raw presigned URL) — same fixed/escaped shape as the
  // invitation templates above, just a different per-template `data`
  // (emails.schemas.ts).
  "refund_batch_compiled",
  // specs/20260716-refund-service AC-3.6 extension — the approve/reject decision
  // emails. AC-3.6 already required a PUSH the employee cannot miss; the
  // in-app notification (ADR 20260716-system-notifications-cross-user-trigger) satisfied it, and these add email as a
  // SECOND channel for the same event, exactly as ADR 20260714-notify-api-email-channel-service-trust intended the
  // channel split. Two templates rather than one with an `outcome` field:
  // only the approved variant carries money, so a split keeps each `data`
  // shape closed and fixed (emails.schemas.ts's stated security property)
  // instead of making the totals conditionally-present.
  "refund_decision_approved",
  "refund_decision_rejected",
  // specs/20261101-crm-notifications (ADR 20261101-notify-api-resolves-email-notice-address-from-auth) — the email twin of an in-app
  // notification, built by notify-api itself from the row it just stored.
  // Listed here so the delivery log can name it, but deliberately NOT in
  // SendEmailRequestSchema: /system/emails takes the address from the
  // caller, this template's address comes only from `auth`.
  "notification_notice",
  // specs/20261117-legal-entities T57 (AC-9.11-9.13) — the notice of a protected change to a legal entity. A closed,
  // typed `data` (emails.schemas.ts) that can carry no value beyond an IBAN's last 4 characters; bound to
  // `system:auth` (emails.routes.ts, EMAIL_TEMPLATE_POLICY).
  "legal_entity_change",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export type EmailSendInput = {
  to: string;
  template: EmailTemplate;
  subject: string;
  html: string;
  /**
   * Repeat protection (specs/20261117-legal-entities T56, AC-9.14), for the system caller that sent a key: a
   * `sent` delivery already recorded for the pair is returned as it is and nothing is sent; after `failed`
   * attempts alone the send is tried again. The pair is recorded on every attempt, and `<sub>:<key>` goes to
   * Resend as its idempotency key (it keeps keys 24 hours).
   */
  idempotency?: IdempotencyScope | undefined;
};

export type EmailSendResult =
  | { deliveryId: string; status: "sent"; replayed?: true }
  | { deliveryId: string; status: "failed"; error: string };

/** Resend refuses keys over 256 characters; a longer pair (an unusually long `sub`) is hashed, not truncated. */
const RESEND_KEY_MAX = 256;

/** The key Resend receives: `<sub>:<key>` — scoped like notify-api's own, so two callers never share one. */
export const resendIdempotencyKey = (scope: IdempotencyScope): string => {
  const key = `${scope.callerSub}:${scope.idempotencyKey}`;
  return key.length <= RESEND_KEY_MAX
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex")}`;
};

const persistDelivery = async (
  input: RecordEmailDeliveryInput,
): Promise<{ id: string; replayed: boolean }> => {
  const exit = await Effect.runPromiseExit(recordEmailDelivery(input));
  if (exit._tag === "Failure") {
    // A concurrent call with the same key recorded its `sent` first: that row is the answer.
    const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    if (failure instanceof DeliveryAlreadySent) return { id: failure.delivery.id, replayed: true };
    throw unexpectedDbFailure("Unexpected database failure recording email delivery", exit.cause);
  }
  return { id: exit.value.id, replayed: false };
};

const sentFor = (row: { id: string; replayed: boolean }): EmailSendResult =>
  row.replayed
    ? { deliveryId: row.id, status: "sent", replayed: true }
    : { deliveryId: row.id, status: "sent" };

export const emailChannel: Channel<EmailSendInput, EmailSendResult> = {
  send: async (input) => {
    const scope = input.idempotency;

    if (scope) {
      const exit = await Effect.runPromiseExit(findSentDelivery(scope));
      if (exit._tag === "Failure") {
        throw unexpectedDbFailure("Unexpected database failure looking up email delivery", exit.cause);
      }
      if (exit.value) return { deliveryId: exit.value.id, status: "sent", replayed: true };
    }

    if (!env.EMAIL_ENABLED) {
      const row = await persistDelivery({
        to: input.to,
        template: input.template,
        status: "sent",
        providerId: `stub_${randomUUID()}`,
        ...(scope ? { scope } : {}),
      });
      return sentFor(row);
    }

    const result = await sendEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(scope ? { idempotencyKey: resendIdempotencyKey(scope) } : {}),
    });

    if (result.ok) {
      const row = await persistDelivery({
        to: input.to,
        template: input.template,
        status: "sent",
        providerId: result.providerId,
        ...(scope ? { scope } : {}),
      });
      return sentFor(row);
    }

    const row = await persistDelivery({
      to: input.to,
      template: input.template,
      status: "failed",
      error: result.error,
      ...(scope ? { scope } : {}),
    });
    return { deliveryId: row.id, status: "failed", error: result.error };
  },
};
