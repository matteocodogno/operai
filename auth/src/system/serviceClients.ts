/**
 * Parsing and validation of the `SERVICE_CLIENTS` env value (T4, specs/015-
 * hardware-inventory — ADR-0044): the per-client entries that
 * `POST /system/service-token` authenticates against.
 *
 * Kept free of any import from `../lib/env` (which imports THIS file to
 * validate the variable at startup) so there is no cycle, and free of any
 * secret-bearing output: a parse failure names the client id and the rule that
 * failed, never a secret value or a slice of the raw JSON.
 *
 * Format — a JSON object keyed by client id:
 *
 *   {"inventory-api":{"secret":"<random, >= 32 chars>","scope":"notifications.push"}}
 *
 * - client id: lower-case alphanumerics and single hyphens, <= 64 chars. It
 *   becomes the token's `sub` as `system:<clientId>`, so it must be impossible
 *   to confuse with a user id.
 * - secret: >= 32 chars (mirrors `inventory-api`'s own `SERVICE_CLIENT_SECRET`
 *   minimum and `NOTIFY_INTERNAL_TOKEN`'s) and <= 256.
 * - client id `auth` is reserved (specs/016): `auth` mints its own credential
 *   in process as `system:auth`, so no configured client may claim that `sub`.
 * - scope: space-delimited, each entry from {@link KNOWN_SERVICE_SCOPES}. A
 *   typo or an invented scope refuses to start rather than minting a token
 *   whose scope no resource server understands (or, worse, one it widens).
 *
 * Revoking a client is removing its entry; tokens already minted expire within
 * {@link SERVICE_TOKEN_TTL_SECONDS}.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Scopes a service token may carry. Adding one is a deliberate code change, not an env edit. */
export const KNOWN_SERVICE_SCOPES = ["notifications.push", "emails.send"] as const;

/**
 * Client id `auth` itself mints under (`sub="system:auth"`, in process — specs/016).
 * Reserved so no `SERVICE_CLIENTS` entry can authenticate as the issuer.
 */
export const RESERVED_SERVICE_CLIENT_ID = "auth";

/** `sub` prefix of every service principal — what `notify-api` checks for. */
export const SERVICE_SUB_PREFIX = "system:";

/** Lifetime of a minted service token (ADR-0044: 5 minutes). */
export const SERVICE_TOKEN_TTL_SECONDS = 300;

export interface ServiceClient {
  readonly secret: string;
  readonly scopes: readonly string[];
}

/** A `Map`, never a plain object: a presented client id of `__proto__`/`constructor` must not resolve. */
export type ServiceClients = ReadonlyMap<string, ServiceClient>;

export type ParseServiceClientsResult =
  | { ok: true; clients: ServiceClients }
  | { ok: false; errors: string[] };

const CLIENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CLIENT_ID_LENGTH = 64;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;

/** Parses `raw` (the env value; absent or blank means "no clients"). Never throws. */
export function parseServiceClients(raw: string | undefined): ParseServiceClientsResult {
  if (raw === undefined || raw.trim() === "") return { ok: true, clients: new Map() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["SERVICE_CLIENTS must be valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ["SERVICE_CLIENTS must be a JSON object keyed by client id"] };
  }

  const errors: string[] = [];
  const clients = new Map<string, ServiceClient>();

  for (const [clientId, entry] of Object.entries(parsed)) {
    if (clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)) {
      errors.push(
        `SERVICE_CLIENTS: client id "${clientId.slice(0, 40)}" must be lower-case alphanumerics and single hyphens, at most ${MAX_CLIENT_ID_LENGTH} chars`,
      );
      continue;
    }
    if (clientId === RESERVED_SERVICE_CLIENT_ID) {
      errors.push(`SERVICE_CLIENTS: client id "${clientId}" is reserved for the issuer's own credential`);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`SERVICE_CLIENTS: entry for "${clientId}" must be an object {secret, scope}`);
      continue;
    }

    const { secret, scope, ...rest } = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      errors.push(`SERVICE_CLIENTS: entry for "${clientId}" has unknown keys: ${unknownKeys.join(", ")}`);
    }
    if (
      typeof secret !== "string" ||
      secret.length < MIN_SECRET_LENGTH ||
      secret.length > MAX_SECRET_LENGTH
    ) {
      errors.push(
        `SERVICE_CLIENTS: secret for "${clientId}" must be a string of ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters`,
      );
    }

    const scopes = typeof scope === "string" ? scope.split(" ").filter((s) => s !== "") : [];
    const known: readonly string[] = KNOWN_SERVICE_SCOPES;
    const unknownScopes = scopes.filter((s) => !known.includes(s));
    if (scopes.length === 0 || unknownScopes.length > 0) {
      errors.push(
        `SERVICE_CLIENTS: scope for "${clientId}" must be a space-delimited, non-empty subset of: ${KNOWN_SERVICE_SCOPES.join(", ")}`,
      );
    }

    if (typeof secret === "string" && errors.length === 0) {
      clients.set(clientId, { secret, scopes: Array.from(new Set(scopes)) });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, clients };
}

// ─── Authentication ──────────────────────────────────────────────────────────

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

// Compared against when the client id is unknown, so that path does the same
// hash + constant-time compare as the wrong-secret path.
const UNKNOWN_CLIENT_DIGEST = sha256("service-token:unknown-client");

/**
 * Looks up `clientId` and checks `presentedSecret` against its stored secret.
 * Returns the client on success, `null` on EVERY failure (unknown client, wrong
 * secret, empty input) so the caller cannot tell them apart.
 *
 * Both secrets are reduced to SHA-256 digests first, so `timingSafeEqual`
 * always compares two equal-length buffers: no length leak, and no early exit
 * on the first differing byte. The unknown-client path runs the same work
 * against a fixed digest instead of returning early.
 */
export function authenticateServiceClient(
  clients: ServiceClients,
  clientId: string,
  presentedSecret: string,
): ServiceClient | null {
  const client = clients.get(clientId);
  const expected = client ? sha256(client.secret) : UNKNOWN_CLIENT_DIGEST;
  const matches = timingSafeEqual(sha256(presentedSecret), expected);
  return client && matches ? client : null;
}
