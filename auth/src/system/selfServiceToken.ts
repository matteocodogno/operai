/**
 * `auth`'s own notify credential, minted in process (T2, specs/016; ADR-0048).
 *
 * `auth` is the issuer of service tokens and also a caller of notify-api
 * (`POST /system/emails`, invitation mail), so it does not authenticate to
 * itself with a secret: it signs `sub="system:auth"`, `scope="emails.send"`
 * directly, through the same claim-building and signer as the endpoint
 * (`mintServiceJwt`, one code path). The id `auth` is reserved in
 * `SERVICE_CLIENTS` (`serviceClients.ts`) so no configured client can hold
 * that `sub`.
 *
 * The signer is injected, not imported: `src/index.ts` passes
 * `signWithAuth(auth)`, because test files mock `../auth/auth.config` (see the
 * "WHY A FACTORY" note in serviceToken.routes.ts).
 *
 * Caching mirrors the other callers: one token is reused until 60 s before its
 * `exp`, concurrent callers share one in-flight mint, and a failed mint is
 * neither cached nor swallowed — the caller (`lib/notify.ts`, T7) decides what
 * a failure means.
 */

import { RESERVED_SERVICE_CLIENT_ID } from "./serviceClients";
import { mintServiceJwt, type SignServiceJwt } from "./serviceToken.routes";

/** The scope `auth` presents: invitation email only, never push. */
export const SELF_SERVICE_SCOPES: readonly string[] = ["emails.send"];

/** A cached token is replaced once this close to its expiry. */
export const REFRESH_BEFORE_EXPIRY_SECONDS = 60;

export interface SelfServiceTokenProvider {
  /** A valid `system:auth` service JWT; rejects if minting fails. */
  getToken(): Promise<string>;
  /**
   * Drop the cached token if it is `token` (notify-api answered it 401). A late
   * call for a token that was already replaced is a no-op, so it can never
   * evict the fresh one.
   */
  invalidate(token: string): void;
}

export function createSelfServiceTokenProvider(deps: {
  signJwt: SignServiceJwt;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}): SelfServiceTokenProvider {
  const now = deps.now ?? Date.now;
  let cached: { token: string; exp: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const minted = await mintServiceJwt(deps.signJwt, {
      clientId: RESERVED_SERVICE_CLIENT_ID,
      scopes: SELF_SERVICE_SCOPES,
      nowMs: now(),
    });
    cached = minted;
    return minted.token;
  };

  return {
    async getToken() {
      if (cached && now() / 1000 < cached.exp - REFRESH_BEFORE_EXPIRY_SECONDS) return cached.token;
      inFlight ??= mint().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    invalidate(token) {
      if (cached?.token === token) cached = undefined;
    },
  };
}
