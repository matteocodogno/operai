/**
 * Google credentials for meetings-api (specs/021-meetings plan.md § Amendment 2026-11-05 G-6, ADR-0069):
 * ONE service account, from the explicit key in `MEETINGS_GCP_SERVICE_ACCOUNT_KEY`, never Application
 * Default Credentials. ADC would pick up whatever the host happens to hold (a developer's `gcloud login`, a
 * metadata server), which is exactly the "a setting nobody made in our code" failure ADR-0061 names.
 *
 * Built on google-auth-library's `JWT` client: it signs the assertion, exchanges it at
 * `oauth2.googleapis.com` (carries no content) and caches the access token until shortly before it expires.
 * The same client is handed to `@anthropic-ai/vertex-sdk` as its `authClient`, so Vertex and the REST calls
 * (Speech, Cloud Storage) share one token.
 *
 * Failures are mapped to `GoogleApiError` (transient or not), never to provider text: the message of a token
 * error can carry the key id or the service account's email.
 */

import { JWT, gaxios } from "google-auth-library";
import { parseServiceAccountKey, type ServiceAccountKey } from "../residency";

/** One scope covers Speech, Cloud Storage and Vertex; a single token is cached for all three. */
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The token exchange carries no content; fail fast rather than hold a job's slot. */
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * A failed call to a Google API. `transient` = worth retrying (network, timeout, 408, 429, 5xx); otherwise the
 * same request will be refused again (revoked key, missing permission, bad request). Carries a status and
 * nothing else: the adapters map it into their own closed failure codes (plan § G-8).
 */
export class GoogleApiError extends Error {
  constructor(
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(`google api call failed: ${transient ? "transient" : "permanent"}${status !== undefined ? ` (HTTP ${status})` : ""}`);
    this.name = "GoogleApiError";
  }
}

/** Plan § G-8: network and 408/429/5xx are transient, every other status is a refusal. */
export const isTransientStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** An error from a fetch or a token call, reduced to `GoogleApiError`. A status, when there is one; never text. */
export function toGoogleApiError(error: unknown): GoogleApiError {
  if (error instanceof GoogleApiError) return error;
  const status = statusOf(error);
  return status === undefined ? new GoogleApiError(true) : new GoogleApiError(isTransientStatus(status), status);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const nested = (error as { response?: { status?: unknown } }).response?.status;
  return typeof nested === "number" ? nested : undefined;
}

export interface GoogleAuth {
  /** A valid access token (cached; refreshed shortly before it expires). Throws `GoogleApiError`. */
  accessToken(): Promise<string>;
  /** The same credentials as a google-auth-library client, for `@anthropic-ai/vertex-sdk`. */
  readonly client: JWT;
}

export interface GoogleAuthOptions {
  readonly key: ServiceAccountKey;
  /** Tests pass a stub; the token endpoint is never reached otherwise. */
  readonly fetchImpl?: typeof fetch;
}

export function createGoogleAuth(options: GoogleAuthOptions): GoogleAuth {
  const transporter = new gaxios.Gaxios({
    timeout: TOKEN_TIMEOUT_MS,
    // The job runner owns retry (ADR-0062); a hidden retry here would multiply it.
    retry: false,
    retryConfig: { retry: 0 },
    ...(options.fetchImpl ? { fetchImplementation: options.fetchImpl } : {}),
  });
  const client = new JWT({
    email: options.key.clientEmail,
    key: options.key.privateKey,
    scopes: [CLOUD_PLATFORM_SCOPE],
    transporter,
  });

  return {
    client,
    async accessToken() {
      let token: string | null | undefined;
      try {
        token = (await client.getAccessToken()).token;
      } catch (error) {
        throw toGoogleApiError(error);
      }
      // An answer with no token is a broken exchange, not a refusal: try again.
      if (!token) throw new GoogleApiError(true);
      return token;
    },
  };
}

let current: GoogleAuth | null = null;

/**
 * The credentials for this process, built from the environment on first use. Only the real providers call it
 * (env.ts requires the key with `MEETINGS_AI_PROVIDER=real`); a fake run never reaches it.
 */
export async function googleAuth(): Promise<GoogleAuth> {
  if (current) return current;
  const { env } = await import("../env");
  const parsed = parseServiceAccountKey(env.MEETINGS_GCP_SERVICE_ACCOUNT_KEY ?? "", env.MEETINGS_GCP_PROJECT_ID);
  if (!parsed.key) throw new Error("MEETINGS_GCP_SERVICE_ACCOUNT_KEY is not configured");
  current = createGoogleAuth({ key: parsed.key });
  return current;
}

/** Tests only: install credentials (or `null` to rebuild from the environment). */
export function setGoogleAuthForTests(replacement: GoogleAuth | null): void {
  current = replacement;
}

// ─── Authorized REST calls ───────────────────────────────────────────────────

/** `fetch`, looked up per call so a test (or Bun) can replace `globalThis.fetch`. */
export const defaultFetch = ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch;

export interface GoogleFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Blob | Uint8Array | string;
  /** The job's lease signal: a lost lease aborts the call. */
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** Statuses returned to the caller instead of thrown (e.g. 404 on a delete). */
  readonly allow?: readonly number[];
}

/**
 * One authorized REST call: Bearer token from `auth`, no redirects, a timeout. A network failure, timeout or
 * abort is a transient `GoogleApiError`; a non-2xx status is a `GoogleApiError` classified by § G-8 unless the
 * caller lists it in `allow`. The error never carries the URL, the body or the provider's text.
 */
export async function googleFetch(
  auth: GoogleAuth,
  fetchImpl: typeof fetch,
  url: string,
  init: GoogleFetchInit,
): Promise<Response> {
  const token = await auth.accessToken();
  const timeout = AbortSignal.timeout(init.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      ...(init.body !== undefined ? { body: init.body as RequestInit["body"] } : {}),
      signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      redirect: "error",
    });
  } catch {
    // Timeout, abort, DNS, TLS, reset: all the same to the caller. The error text is dropped.
    throw new GoogleApiError(true);
  }
  if (response.ok || init.allow?.includes(response.status)) return response;
  await response.body?.cancel().catch(() => {});
  throw new GoogleApiError(isTransientStatus(response.status), response.status);
}
