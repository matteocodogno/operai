/**
 * Resend client wrapper (T2, specs/006-user-invitations, ADR-0011).
 *
 * A thin seam around the `resend` SDK so `src/channels/email.channel.ts` never
 * imports the SDK directly — keeps the provider swappable and gives the
 * channel a single narrow function to mock in tests.
 *
 * The client is constructed lazily (not at module-eval time): when
 * `EMAIL_ENABLED` is false (test/local default, ADR-0011/T2), `RESEND_API_KEY`
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
};

export type SendEmailResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

/**
 * Sends one transactional email via Resend. Never throws — network/API
 * failures are translated into `{ ok: false, error }` so callers (the email
 * channel) can record `EmailDelivery.status = "failed"` and return a soft
 * failure rather than propagating a 5xx (plan.md §API contracts, ADR-0011).
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
    const { data, error } = await getClient().emails.send({
      from: env.RESEND_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });

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
