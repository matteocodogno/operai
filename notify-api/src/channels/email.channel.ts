/**
 * email channel (T2, specs/006-user-invitations, ADR-0011).
 *
 * Addresses a RAW email address (never a `sub`) — there is no Notification
 * row and no SSE push for this channel; it renders no template itself (the
 * caller, T3's /system/emails route, renders the bilingual subject/html and
 * hands this channel the finished `subject`/`html` plus a `template` label
 * used only for the EmailDelivery audit column). Sends via Resend
 * (src/lib/resend.ts) and ALWAYS records one EmailDelivery row per attempt,
 * whether the send succeeds, fails, or is stubbed.
 *
 * EMAIL_ENABLED=false (test/local default, ADR-0011): the real Resend call is
 * skipped entirely — the send is stubbed and recorded as "sent" with a
 * SYNTHETIC providerId (prefixed `stub_`, never a real Resend message id), so
 * tests and local dev never need a Resend account and never make a real
 * network call. The EmailDelivery row itself always has a real DB-generated
 * `id` — only `providerId` is synthetic in this mode.
 *
 * Failure handling (plan.md §API contracts, ADR-0011): a Resend/network
 * failure is a SOFT failure — recorded as EmailDelivery.status="failed" and
 * returned as `{ status: "failed", error }`, never thrown/never a 5xx. Only a
 * failure to WRITE the EmailDelivery row itself (a genuine DB outage) throws,
 * matching notifications.repo.ts's convention of surfacing DB failures as an
 * uncaught Error for app.onError to turn into a 500.
 */

import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/resend";
import type { Channel } from "./channel";
import {
  recordEmailDelivery,
  type RecordEmailDeliveryInput,
} from "./emailDelivery.repo";

export const EMAIL_TEMPLATES = ["invitation", "invitation_resend"] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export type EmailSendInput = {
  to: string;
  template: EmailTemplate;
  subject: string;
  html: string;
};

export type EmailSendResult =
  | { deliveryId: string; status: "sent" }
  | { deliveryId: string; status: "failed"; error: string };

const persistDelivery = async (
  input: RecordEmailDeliveryInput,
): Promise<{ id: string }> => {
  const exit = await Effect.runPromiseExit(recordEmailDelivery(input));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure recording email delivery");
  }
  return exit.value;
};

export const emailChannel: Channel<EmailSendInput, EmailSendResult> = {
  send: async (input) => {
    if (!env.EMAIL_ENABLED) {
      const row = await persistDelivery({
        to: input.to,
        template: input.template,
        status: "sent",
        providerId: `stub_${randomUUID()}`,
      });
      return { deliveryId: row.id, status: "sent" };
    }

    const result = await sendEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
    });

    if (result.ok) {
      const row = await persistDelivery({
        to: input.to,
        template: input.template,
        status: "sent",
        providerId: result.providerId,
      });
      return { deliveryId: row.id, status: "sent" };
    }

    const row = await persistDelivery({
      to: input.to,
      template: input.template,
      status: "failed",
      error: result.error,
    });
    return { deliveryId: row.id, status: "failed", error: result.error };
  },
};
