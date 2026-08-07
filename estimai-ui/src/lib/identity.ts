/**
 * identity — the single place that turns a live-resolved `auth` identity
 * (T14, specs/013-estimate-sharing/tasks.md; plan.md "### Display identity")
 * into display text, per AC-10.5's rule: never render stale/misleading
 * identity information implying an account is still active.
 *
 * `estimai-api`'s `POST /authz/users/identities` (plan.md "### Display
 * identity") resolves ids live against `auth` and returns exactly this
 * tri-state shape — `name` is populated only for `status: "active"`. Every
 * screen that shows an owner's or collaborator's name (CollaboratorsDialog,
 * EstimatesPage's shared-row indicator, the "Shared by X" toolbar chip) MUST
 * route through `formatIdentity` rather than reading `.name` directly, the
 * same "single rule, tested once" discipline design.md's Accessibility
 * section applies to `canEdit` — so "active name / deleted placeholder /
 * unknown placeholder" is decided in exactly one place.
 *
 * The three states, matching design.md's Accessibility → "Orphaned-identity
 * rendering":
 *   - "active"  → the resolved name (defensively falls back to the
 *                 "unknown" placeholder if the backend ever sends an active
 *                 status with a blank name, rather than rendering nothing)
 *   - "deleted" → "Former wellD member" — a real, readable placeholder, never
 *                 a blank string, a raw cuid, or a title-only tooltip a
 *                 screen-reader user could miss
 *   - "unknown" → "Unknown wellD member" — used when live resolution itself
 *                 degrades (auth unavailable, id not found, etc.)
 */

import { strings } from '../strings'

export type IdentityStatus = 'active' | 'deleted' | 'unknown'

/** Mirrors `auth POST /authz/users/identities`'s per-id response shape. */
export interface Identity {
  id: string
  status: IdentityStatus
  name: string | null
}

/**
 * Resolves an `Identity` to its display text. Always returns non-empty,
 * human-readable text — never a blank string, a raw id, or `null`.
 */
export function formatIdentity(identity: Identity): string {
  if (identity.status === 'deleted') {
    return strings.sharing.identity.deleted
  }
  if (identity.status === 'active' && identity.name && identity.name.trim().length > 0) {
    return identity.name
  }
  // "unknown", or a malformed "active" with no name — same neutral placeholder either way.
  return strings.sharing.identity.unknown
}
