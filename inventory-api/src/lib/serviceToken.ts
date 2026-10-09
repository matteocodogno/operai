/**
 * Service-token client (T17, specs/015-hardware-inventory; AC-2.8, AC-2.9;
 * ADR-0044). Exchanges `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` for the
 * 5-minute RS256 service JWT `auth POST /system/service-token` mints, and
 * hands it to `notify.ts` as the Bearer credential for notify-api's
 * `/system/notifications`.
 *
 * - Cached in memory; refetched once the token is within 60 s of expiry.
 * - SINGLE-FLIGHT: concurrent callers share one in-flight exchange (a burst of
 *   assignments must not spend `auth`'s rate limit on N identical mints). A
 *   failed exchange is not remembered, so the next call retries.
 * - The exchange has a timeout and refuses redirects: the body carries the
 *   secret, and a redirect would replay it to another host.
 * - NEVER logs, and never puts in an error message, the secret or any token —
 *   errors name the HTTP status only (the response body is not read on a
 *   failure: it could echo what was sent).
 *
 * No `env` import: the provider takes its settings, so tests build their own
 * with a stubbed `fetch` and clock. `serviceTokens` (bottom) is the one wired
 * from the environment.
 */

import { env } from "./env";

/** Refetch this long before the token's own expiry. */
const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ServiceTokenProviderOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface ServiceTokenProvider {
  getToken(): Promise<string>;
  /**
   * Forget `token` (a 401 from notify-api said it is no good). A no-op when a
   * different token is cached now, so a late 401 about an old token cannot
   * discard a fresh one.
   */
  invalidate(token: string): void;
}

export class ServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

export function createServiceTokenProvider(options: ServiceTokenProviderOptions): ServiceTokenProvider {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let cached: { token: string; usableUntil: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}/system/service-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: options.clientId, clientSecret: options.clientSecret }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new ServiceTokenError(
        `service-token request failed (${error instanceof Error ? error.name : "unknown error"})`,
      );
    }
    if (!res.ok) throw new ServiceTokenError(`auth /system/service-token responded with HTTP ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ServiceTokenError("auth /system/service-token returned an unreadable body");
    }
    const { token, expiresInSeconds } = (body ?? {}) as Record<string, unknown>;
    if (typeof token !== "string" || token === "" || typeof expiresInSeconds !== "number" || !(expiresInSeconds > 0)) {
      throw new ServiceTokenError("auth /system/service-token returned an unexpected body");
    }

    const usableUntil = now() + expiresInSeconds * 1000 - REFRESH_MARGIN_MS;
    // A token that lives no longer than the margin is good for this use only.
    cached = usableUntil > now() ? { token, usableUntil } : null;
    return token;
  }

  return {
    async getToken() {
      if (cached && cached.usableUntil > now()) return cached.token;
      inflight ??= exchange().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate(token) {
      if (cached?.token === token) cached = null;
    },
  };
}

export const serviceTokens: ServiceTokenProvider = createServiceTokenProvider({
  baseUrl: env.AUTH_BASE_URL,
  clientId: env.SERVICE_CLIENT_ID,
  clientSecret: env.SERVICE_CLIENT_SECRET,
});
