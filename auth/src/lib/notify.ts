/**
 * notify-api internal email client (T6, specs/006-user-invitations —
 * plan.md "auth → notify-api internal email send", "Service-to-service auth"
 * ADR candidate, risk R2/R5).
 *
 * Calls notify-api's internal, NON-user-JWT endpoint `POST /system/emails`,
 * authenticated as `auth` itself: `Authorization: Bearer <service JWT>`,
 * `sub="system:auth"`, `scope="emails.send"`, minted in process (specs/016 T7,
 * ADR-0048, ADR-0049). It is deliberately NOT the calling admin's session JWT
 * (plan.md: forwarding the admin's token would conflate the admin's identity
 * with a system send and let any admin-scoped token reach the email surface),
 * and no longer the shared `X-Internal-Token`. `NOTIFY_INTERNAL_URL` is
 * validated at startup (`lib/env.ts`).
 *
 * The token provider is injected by `src/index.ts` (`setNotifyTokenProvider`)
 * rather than imported: it needs the better-auth signer, and importing
 * `auth.config` here would make this module behave differently depending on
 * which test files `mock.module` it (see serviceToken.routes.ts).
 *
 * Failure handling (plan.md "Resend + i18n + failure"): this function NEVER
 * throws for a delivery failure — a non-2xx response, an unexpected body
 * shape, or a network error are all surfaced as `{ status: "failed", error }`
 * so the caller (`invitations.routes.ts`) can store `lastEmailStatus` and
 * still return 201/200 to the admin. The invitation itself is created FIRST,
 * this call happens SECOND — a failed send is never allowed to roll back or
 * block the invitation (that would make an outbound-email outage block the
 * entire invite feature, which the spec's "no background retry" model
 * explicitly avoids by making resend the retry path instead).
 */

import { env } from "./env";

/** The slice of `SelfServiceTokenProvider` this client needs. */
export interface NotifyTokenProvider {
  getToken(): Promise<string>;
}

let tokenProvider: NotifyTokenProvider | undefined;

/** Wired once at startup in `src/index.ts`; tests replace it. */
export function setNotifyTokenProvider(provider: NotifyTokenProvider | undefined): void {
  tokenProvider = provider;
}

export type InvitationEmailTemplate = "invitation" | "invitation_resend";

export interface SendInvitationEmailInput {
  readonly to: string;
  readonly template: InvitationEmailTemplate;
  readonly inviteUrl: string;
  readonly inviterName: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export type SendInvitationEmailResult =
  | { status: "sent"; deliveryId: string }
  | { status: "failed"; error: string };

interface SystemEmailsResponseBody {
  deliveryId?: string;
  status?: string;
  error?: string;
}

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/emails` with `Authorization: Bearer`. See
 * plan.md's contract:
 *   request:  { to, template, data: { inviteUrl, inviterName, expiresAt } }
 *   response: { deliveryId, status } | { status: "failed", error }
 */
export async function sendInvitationEmail(
  input: SendInvitationEmailInput,
): Promise<SendInvitationEmailResult> {
  try {
    if (!tokenProvider) throw new Error("notify token provider is not configured");
    // A mint failure lands in the catch below: reported as `failed`, never thrown,
    // so the invitation (already created) is not rolled back (AC-4.3).
    const token = await tokenProvider.getToken();
    const response = await fetch(`${env.NOTIFY_INTERNAL_URL}/system/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: input.to,
        template: input.template,
        data: {
          inviteUrl: input.inviteUrl,
          inviterName: input.inviterName,
          expiresAt: input.expiresAt,
        },
      }),
    });

    if (!response.ok) {
      return {
        status: "failed",
        error: `notify-api responded with HTTP ${response.status}`,
      };
    }

    const body = (await response.json().catch(() => null)) as
      | SystemEmailsResponseBody
      | null;

    if (body?.status === "sent" && typeof body.deliveryId === "string") {
      return { status: "sent", deliveryId: body.deliveryId };
    }

    return {
      status: "failed",
      error: body?.error ?? "notify-api did not report a successful delivery",
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error calling notify-api",
    };
  }
}
