/**
 * The one place refund-api talks to notify-api's `/system` routes (T9,
 * specs/016-notify-service-credentials; AC-1.1, AC-1.2, AC-4.3, ADR-0044/0049).
 *
 * `notify.ts` (push, scope `notifications.push`) and `notifyEmail.ts` (email,
 * scope `emails.send`) both go through `postToNotify`, so the credential
 * handling exists once: `Authorization: Bearer <service JWT>` from
 * `serviceToken.ts`, never the retired `X-Internal-Token`.
 *
 * One 401 from notify-api drops the cached token and retries ONCE with a fresh
 * one (the token may have been rotated or revoked under us); a second 401 is a
 * configuration fault and is returned to the caller, not looped on. Any other
 * status (429, 5xx) is returned as is and never retried.
 *
 * The function THROWS when the token cannot be obtained or the request fails
 * at the network level; callers own the best-effort policy (log + swallow, or
 * map to `{status:"failed"}`). Messages that surface here are a
 * `ServiceTokenError` (status only, no secret, no token) or the runtime's
 * fetch error text.
 */

import { env } from "./env";
import { serviceTokens, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;

export interface NotifyTransport {
  readonly baseUrl?: string;
  readonly tokens?: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * The transport every call site uses when it is not handed one. Under
 * NODE_ENV=test `serviceTokens` is the disabled provider, so no test can reach
 * a real notify-api through it. A route test that needs the push to be
 * observable at the (faked) HTTP boundary swaps `tokens` for a stub in
 * `beforeAll` and puts it back in `afterAll`; nothing in `src/` writes to it.
 */
export const notifyTransport: { baseUrl: string; tokens: ServiceTokenProvider } = {
  baseUrl: env.NOTIFY_INTERNAL_URL,
  tokens: serviceTokens,
};

/** POST `payload` to `{notify-api}{path}` as refund-api itself. Returns the final response (body unread). */
export async function postToNotify(
  path: "/system/notifications" | "/system/emails",
  payload: unknown,
  transport: NotifyTransport = {},
): Promise<Response> {
  const baseUrl = transport.baseUrl ?? notifyTransport.baseUrl;
  const tokens = transport.tokens ?? notifyTransport.tokens;
  const timeoutMs = transport.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch = transport.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    const token = await tokens.getToken();
    const response = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      // The request carries a credential; a redirect would replay it elsewhere.
      redirect: "error",
    });
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel().catch(() => {});
      tokens.invalidate(token);
      continue;
    }
    return response;
  }
}
