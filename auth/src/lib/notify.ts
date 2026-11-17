/**
 * notify-api internal email client (T6, specs/20260713-user-invitations —
 * plan.md "auth → notify-api internal email send", "Service-to-service auth"
 * ADR candidate, risk R2/R5).
 *
 * Calls notify-api's internal, NON-user-JWT endpoint `POST /system/emails`,
 * authenticated as `auth` itself: `Authorization: Bearer <service JWT>`,
 * `sub="system:auth"`, `scope="emails.send"`, minted in process (specs/20261013-notify-service-credentials T7,
 * ADR 20261013-auth-mints-own-service-credential-in-process, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). It is deliberately NOT the calling admin's session JWT
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
 *
 * The one exception to "no retry": a 401 drops the cached credential and the
 * request is repeated once with a fresh one (as refund-api's `postToNotify`
 * does). A second 401, or any other status, is the ordinary failed result.
 * The token itself is never logged or placed in an error message.
 */

import { env } from "./env";

/** The slice of `SelfServiceTokenProvider` this client needs. */
export interface NotifyTokenProvider {
  getToken(): Promise<string>;
  /** Drop a cached token notify-api rejected, so the next `getToken` mints anew. */
  invalidate(token: string): void;
}

let tokenProvider: NotifyTokenProvider | undefined;

/** Wired once at startup in `src/index.ts`; tests replace it. */
export function setNotifyTokenProvider(provider: NotifyTokenProvider | undefined): void {
  tokenProvider = provider;
}

/**
 * What a failure reports: the error's name only. A raw `error.message` from `fetch` can
 * carry the internal notify-api host and port, and this value reaches logs and the
 * stored `lastEmailStatus`.
 */
function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
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
    const requestBody = JSON.stringify({
      to: input.to,
      template: input.template,
      data: {
        inviteUrl: input.inviteUrl,
        inviterName: input.inviterName,
        expiresAt: input.expiresAt,
      },
    });
    const post = async (token: string) =>
      fetch(`${env.NOTIFY_INTERNAL_URL}/system/emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: requestBody,
      });

    const token = await tokenProvider.getToken();
    let response = await post(token);
    if (response.status === 401) {
      // The token may have been rotated or revoked under us: drop it and retry
      // ONCE with a fresh one. A second 401 is a configuration fault and takes
      // the ordinary failed path below; nothing else is ever retried.
      await response.body?.cancel().catch(() => {});
      tokenProvider.invalidate(token);
      response = await post(await tokenProvider.getToken());
    }

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
      error: errorName(error),
    };
  }
}

// ─── pushSystemNotification (specs/20261105-signup-gate T4, ADR 20261105-auth-pushes-admin-notifications) ─────────────────────────

/**
 * The slice of notify-api's `POST /system/notifications` body `auth` sends
 * (notify-api/src/system/notifications.schemas.ts). `email: true` asks
 * notify-api to also mail the recipient, resolving the address itself through
 * `auth POST /system/users/contact` (ADR 20261101-notify-api-resolves-email-notice-address-from-auth): `auth` sends no address.
 */
export interface SystemNotificationInput {
  readonly recipientId: string;
  readonly originApp: "admin";
  readonly severity: "info";
  readonly title: string;
  readonly body: string;
  readonly link: { readonly href: string };
  readonly email: boolean;
}

export type PushSystemNotificationResult = { status: "sent" } | { status: "failed"; error: string };

const PUSH_TIMEOUT_MS = 5_000;

/**
 * `POST {NOTIFY_INTERNAL_URL}/system/notifications` as `system:auth` (scope
 * `notifications.push`). Same posture as {@link sendInvitationEmail}: one retry
 * on 401 with a fresh token, a timeout so a stuck notify-api never holds the
 * caller, and it NEVER throws: every failure (mint, network, timeout, non-2xx)
 * is returned as `{ status: "failed" }`. The token is never logged.
 */
export async function pushSystemNotification(
  input: SystemNotificationInput,
  options: { timeoutMs?: number } = {},
): Promise<PushSystemNotificationResult> {
  try {
    if (!tokenProvider) throw new Error("notify token provider is not configured");
    const requestBody = JSON.stringify(input);
    const post = async (token: string) =>
      fetch(`${env.NOTIFY_INTERNAL_URL}/system/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: requestBody,
        signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
      });

    const token = await tokenProvider.getToken();
    let response = await post(token);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      tokenProvider.invalidate(token);
      response = await post(await tokenProvider.getToken());
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: "failed", error: `notify-api responded with HTTP ${response.status}` };
    }
    await response.body?.cancel().catch(() => {});
    return { status: "sent" };
  } catch (error) {
    return {
      status: "failed",
      error: errorName(error),
    };
  }
}

// ─── The legal-entity change notice (specs/20261117-legal-entities T59; plan amendment 2026-11-17 G5, G6) ──────────────

/**
 * Why a notice call did not deliver, from the closed set of `legal_entity_notice.lastReason` (plan G4):
 *   - `notify_unreachable`: no credential, a network error or a timeout (the call may or may not have been stored:
 *     the idempotency key makes the repeat safe);
 *   - `notify_refused`: a 4xx, after the one retry of a 401 (an old notify-api that does not know the template says 400);
 *   - `notify_error`: a 5xx, a redirect, or an answer that is not the contract's;
 *   - `recipient_inactive`: notify-api resolved the person and they are not an active user;
 *   - `email_not_configured`: notify-api's email group or Resend is not set.
 */
export type NoticeFailureReason =
  | "notify_unreachable"
  | "notify_refused"
  | "notify_error"
  | "recipient_inactive"
  | "email_not_configured";

export type NoticeSendResult = { status: "sent" } | { status: "failed"; reason: NoticeFailureReason };

/** What the notice calls take beyond their body: the per-call timeout, and a `fetch` a test replaces. */
export interface NoticeSendOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** `POST /system/notifications` with `idempotencyKey`; no `email` (the email is its own row and call, plan G1.4). */
export interface LegalEntityNotificationInput {
  readonly recipientId: string;
  readonly originApp: "admin";
  readonly severity: "warning";
  readonly title: string;
  readonly body: string;
  readonly it: { readonly title: string; readonly body: string };
  readonly link: { readonly href: string; readonly label?: string };
  readonly idempotencyKey: string;
}

/** `POST /system/emails`, template `legal_entity_change`: one person by `recipientId`, or the outside mailbox by `to`. */
export type LegalEntityEmailInput = {
  readonly template: "legal_entity_change";
  readonly data: object;
  readonly idempotencyKey: string;
} & ({ readonly recipientId: string } | { readonly to: string });

/**
 * One authenticated POST of a JSON body to notify-api: `auth`'s own service token, one retry of a 401 with a fresh
 * one, a timeout, no redirects followed (the bearer token must not travel to another host). Never throws: an answer,
 * or `null` when nothing came back (no credential, network error, timeout). The token and the body are never logged.
 */
async function postToNotify(path: string, body: object, options: NoticeSendOptions): Promise<Response | null> {
  try {
    if (!tokenProvider) throw new Error("notify token provider is not configured");
    const send = options.fetch ?? fetch;
    const requestBody = JSON.stringify(body);
    const post = (token: string) =>
      send(`${env.NOTIFY_INTERNAL_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
      });
    const token = await tokenProvider.getToken();
    let response = await post(token);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      tokenProvider.invalidate(token);
      response = await post(await tokenProvider.getToken());
    }
    return response;
  } catch {
    return null;
  }
}

/** A non-2xx answer as a reason: 4xx is `notify_refused`, everything else (5xx, 3xx) `notify_error`. */
function failureOfStatus(status: number): NoticeFailureReason {
  return status >= 400 && status < 500 ? "notify_refused" : "notify_error";
}

/** The in-app call. 201 (stored) and 200 (a repeat of the same key: stored before) both mean delivered. */
export async function sendLegalEntityNotification(
  input: LegalEntityNotificationInput,
  options: NoticeSendOptions = {},
): Promise<NoticeSendResult> {
  const response = await postToNotify("/system/notifications", input, options);
  if (response === null) return { status: "failed", reason: "notify_unreachable" };
  await response.body?.cancel().catch(() => {});
  if (response.status === 200 || response.status === 201) return { status: "sent" };
  return { status: "failed", reason: failureOfStatus(response.status) };
}

/**
 * The email call. notify-api answers 200 `{ status: "sent" | "skipped" | "failed", reason? }`: a `skipped` is a failure
 * with its reason (AC-9.14: no usable address is retried like any other failure), and so is `failed`.
 */
export async function sendLegalEntityEmail(
  input: LegalEntityEmailInput,
  options: NoticeSendOptions = {},
): Promise<NoticeSendResult> {
  const response = await postToNotify("/system/emails", input, options);
  if (response === null) return { status: "failed", reason: "notify_unreachable" };
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { status: "failed", reason: failureOfStatus(response.status) };
  }
  const body = (await response.json().catch(() => null)) as { status?: unknown; reason?: unknown } | null;
  if (body?.status === "sent") return { status: "sent" };
  if (body?.status === "skipped" && body.reason === "recipient_inactive") return { status: "failed", reason: "recipient_inactive" };
  if (body?.status === "skipped" && body.reason === "not_configured") return { status: "failed", reason: "email_not_configured" };
  return { status: "failed", reason: "notify_error" };
}
