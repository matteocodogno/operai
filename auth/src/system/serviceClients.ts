/**
 * Parsing and validation of the `SERVICE_CLIENTS` env value (T4, specs/20261006-
 * hardware-inventory — ADR 20261006-scoped-service-jwt-fourth-notify-caller): the per-client entries that
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
 *   minimum) and <= 256.
 * - client id `auth` is reserved (specs/20261013-notify-service-credentials): `auth` mints its own credential
 *   in process as `system:auth`, so no configured client may claim that `sub`.
 * - scope: space-delimited, each entry from {@link KNOWN_SERVICE_SCOPES}. A
 *   typo or an invented scope refuses to start rather than minting a token
 *   whose scope no resource server understands (or, worse, one it widens).
 *
 * Revoking a client is removing its entry; tokens already minted expire within
 * {@link SERVICE_TOKEN_TTL_SECONDS}.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Scopes a service token may carry. Adding one is a deliberate code change, not an env edit.
 * - `notifications.push` / `emails.send`: the notify-api capabilities (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).
 * - `users.contact`: resolve one active user's `{id, email, name}` through
 *   `POST /system/users/contact` (specs/20261101-crm-notifications, D-1). notify-api holds it; refund-api only during the production accounting
 *   release window, for the script's one-off read of the names of employees whose old requests carry none (specs/20261119-accounting T84).
 * - `estimate-notices.send`: tell crm-api an EstimAI estimate was closed or
 *   reopened (`POST /system/estimate-notices`, specs/20261101-crm-sales-flow AC-3.3, ADR 20261105-estimai-closes-the-estimate-crm-follows).
 *   Only estimai-api holds it.
 * - `host-notices.send`: post a meeting's link/change/delete notice to a host
 *   app's `/system/meeting-host/v1/notices` (specs/20261104-meetings, AC-11.8). crm-api
 *   verifies it; the sub allowlist there names `system:meetings-api`.
 * - `deal-link-notices.send`: post a deal-link notice (linked/unlinked) to
 *   estimai-api's `/system/deal-link-notices` (specs/20261108-estimate-list-oversight, ADR 20261108-crm-pushes-deal-links-to-estimai).
 *   estimai-api verifies it; its sub allowlist names `system:crm-api`.
 * - `crm.companies.read`: read CRM companies through crm-api's
 *   `GET /system/companies` (specs/20261103-projects, ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential). Only projects-api holds it.
 * - `activities.write`: write to activities-api's `/system/v1/*` routes — the
 *   estimate-request task, completion, meeting-host state and contact erasure
 *   (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082). Only crm-api holds it; activities-api's sub
 *   allowlist names `system:crm-api`.
 * - `crm.deals.read`: read won deals through crm-api's `GET /system/deals` (specs/20261103-projects-handoff).
 *   Only projects-api holds it.
 * - `estimai.estimates.read`: read an estimate's man-days through estimai-api's
 *   `GET /system/estimates/{id}/summary` (specs/20261103-projects-handoff). Only projects-api holds it.
 * - `crm.contacts.read`: read a company's contacts, or contacts by id (the referent of a
 *   purchase order), through crm-api's `GET /system/contacts` (specs/20261103-projects-handoff, D49). Only
 *   projects-api holds it.
 * - `projects.purchase-orders.read`: read the purchase orders of given deals through
 *   projects-api's `GET /system/purchase-orders` (specs/20261103-projects-handoff; was `projects.contracts.read`,
 *   retired with "contract", D38). Only crm-api holds it.
 * - `letterhead:render`: render a document's pages through the letterhead service
 *   (specs/20261116-letterhead-service, AC-3.1, AC-9.3). Held by a calling tool's api
 *   (crm-api first); the letterhead service verifies it.
 * - `legal-entities:read`: read the group's legal entities through auth's `GET /system/legal-entities[/{entity}]`
 *   (specs/20261117-legal-entities, AC-3.2; auth verifies it itself). Held by crm-api and letterhead-api.
 * - `accounting.reference.read`: read an entity's ledger accounts, VAT codes (with their active state) and the
 *   monthly exchange rates in effect through accounting-api's `GET /system/v1/*`
 *   (specs/20261119-accounting, AC-3.8; ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…).
 *   accounting-api verifies it, and also checks the `sub` against its own allowlist `SYSTEM_READERS`. Only
 *   `refund-api` holds it. It never allows a write: a consumer that must write to Accounting is a new scope.
 * - `meetings.hosts.read`: read which host record (today a CRM deal) each meeting is linked to,
 *   through meetings-api's `GET /system/meetings/hosts` (specs/20261112-time-tracking, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). Only hours-api
 *   holds it; meetings-api's sub allowlist names `system:hours-api`. It answers `{id, host}` and
 *   nothing else — no title, participant or duration.
 */
export const KNOWN_SERVICE_SCOPES = [
  "notifications.push",
  "emails.send",
  "users.contact",
  "estimate-notices.send",
  "host-notices.send",
  "deal-link-notices.send",
  "crm.companies.read",
  "activities.write",
  "crm.deals.read",
  "crm.contacts.read",
  "estimai.estimates.read",
  "projects.purchase-orders.read",
  "letterhead:render",
  "legal-entities:read",
  "accounting.reference.read",
  "meetings.hosts.read",
] as const;

/**
 * The scope sets prescribed for clients added after the original four (the
 * deploy contract in `tools/env-doctor`'s manifest repeats them). Documentation
 * pinned by a test, never read at runtime: the live set is the `SERVICE_CLIENTS`
 * env value, validated by {@link parseServiceClients}.
 * - `meetings-api` (specs/20261104-meetings): pushes in-app notifications and relays host
 *   notices to crm-api; it never sends email (AC-12.4), so no `emails.send`.
 * - `projects-api` (specs/20261103-projects, 026): reads CRM companies, won deals and a PO's
 *   referent contacts, an estimate's man-days, and pushes the ops-manager's
 *   notification; it sends no email, so no `emails.send` (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired one scope per
 *   capability; env-doctor's manifest holds the same five).
 * - `crm-api` (specs/20261103-projects-handoff, specs/20261110-activities, specs/20261117-legal-entities): its notify
 *   and deal-link scopes, the purchase orders of its deals (`projects.purchase-orders.read`), `activities.write`
 *   the issuer's details (`legal-entities:read`) and the rendering of a document's pages (`letterhead:render`,
 *   specs/20261116-letterhead-service; production holds it).
 * - `activities-api` (specs/20261110-activities): `notifications.push emails.send` — its task notices
 *   (AC-6.1/6.3) are email notices, and notify-api requires `emails.send` as well as
 *   `notifications.push` for `email: true` (ADR 20261101-notify-api-resolves-email-notice-address-from-auth). No `activities.write`: it is the
 *   service that scope writes to.
 * - `letterhead-api` (specs/20261117-legal-entities, AC-3.2): `legal-entities:read` only — it reads the issuer's
 *   details itself; it verifies `letterhead:render` but does not hold it, and sends no notices.
 * - `hours-api` (specs/20261112-time-tracking): `meetings.hosts.read` only — it asks meetings-api which deal a
 *   meeting is linked to (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). Everything else it asks of the other services is asked as
 *   the caller, with the user's JWT, so it holds no other scope and sends no notification.
 */
export const DOCUMENTED_CLIENT_SCOPES = {
  "meetings-api": "notifications.push host-notices.send",
  "projects-api": "crm.companies.read crm.deals.read crm.contacts.read estimai.estimates.read notifications.push",
  "crm-api":
    "notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read legal-entities:read letterhead:render",
  "activities-api": "notifications.push emails.send",
  "letterhead-api": "legal-entities:read",
  "hours-api": "meetings.hosts.read",
} as const;

/**
 * Client id `auth` itself mints under (`sub="system:auth"`, in process — specs/20261013-notify-service-credentials).
 * Reserved so no `SERVICE_CLIENTS` entry can authenticate as the issuer.
 */
export const RESERVED_SERVICE_CLIENT_ID = "auth";

/** `sub` prefix of every service principal — what `notify-api` checks for. */
export const SERVICE_SUB_PREFIX = "system:";

/** Lifetime of a minted service token (ADR 20261006-scoped-service-jwt-fourth-notify-caller: 5 minutes). */
export const SERVICE_TOKEN_TTL_SECONDS = 300 as const;

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
