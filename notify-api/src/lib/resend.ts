/**
 * Resend client wrapper (T2, specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust).
 *
 * A thin seam around the `resend` SDK so `src/channels/email.channel.ts` never
 * imports the SDK directly — keeps the provider swappable and gives the
 * channel a single narrow function to mock in tests.
 *
 * The client is constructed lazily (not at module-eval time): when
 * `EMAIL_ENABLED` is false (test/local default, ADR 20260714-notify-api-email-channel-service-trust/T2), `RESEND_API_KEY`
 * is typically unset, and `new Resend(undefined)` would be a footgun waiting
 * to be called by mistake. `sendEmail()` is also never invoked in that mode —
 * the email channel stubs the send before this module's function is called —
 * but constructing the client lazily makes that invariant hold even if a
 * future change gets the gating wrong.
 */

import { Resend } from "resend";
import { env } from "./env";

let client: Resend | undefined;

const getClient = (): Resend => {
  if (!client) {
    if (!env.RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY is not configured — sendEmail() must not be called while EMAIL_ENABLED is false",
      );
    }
    client = new Resend(env.RESEND_API_KEY);
  }
  return client;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  /**
   * Passed to Resend as its `Idempotency-Key` (specs/20261117-legal-entities T56, AC-9.14): a second send with the
   * same key, within the 24 hours Resend remembers it, is answered with the first message's id and delivers
   * nothing. The SDK (resend 6.17.2) takes it as `emails.send(payload, { idempotencyKey })` and sets the header
   * itself, so no raw header is needed. Absent: no header, as before.
   */
  idempotencyKey?: string | undefined;
};

export type SendEmailResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

/**
 * Sends one transactional email via Resend. Never throws — network/API
 * failures are translated into `{ ok: false, error }` so callers (the email
 * channel) can record `EmailDelivery.status = "failed"` and return a soft
 * failure rather than propagating a 5xx (plan.md §API contracts, ADR 20260714-notify-api-email-channel-service-trust).
 *
 * `error` is a short, safe-to-store reason string — never the raw SDK/network
 * error object (log-hygiene posture shared with the rest of notify-api: no
 * bodies, no secrets, no stack traces with embedded request details).
 */
export const sendEmail = async (
  input: SendEmailInput,
): Promise<SendEmailResult> => {
  if (!env.RESEND_FROM) {
    return { ok: false, error: "RESEND_FROM is not configured" };
  }

  try {
    const { data, error } = await getClient().emails.send(
      {
        from: env.RESEND_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
      },
      input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : undefined,
    );

    if (error) {
      return { ok: false, error: error.message ?? "Resend API error" };
    }

    if (!data) {
      return { ok: false, error: "Resend returned no data" };
    }

    return { ok: true, providerId: data.id };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown error";
    return { ok: false, error: message };
  }
};
