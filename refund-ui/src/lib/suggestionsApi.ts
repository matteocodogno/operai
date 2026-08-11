/**
 * suggestionsApi — refund-ui's client for `refund-api`'s one new read,
 * `GET /line-suggestions?type=travel_km` (T9, specs/014-motivo-autocomplete/
 * tasks.md; plan.md "## API contracts" + "### Client contract").
 *
 * The endpoint is parameterless beyond a single-member `type` enum and is
 * self-scoped server-side to the verified JWT `sub` (plan D1/D4, AC-4.1–4.3):
 * there is no `q`, no `userId`, no cursor. The text the employee types NEVER
 * reaches the network — the whole corpus is fetched once per composing session
 * and matched in the browser (`lib/tripSuggestions.ts`), which is what makes
 * AC-4.4 true by construction rather than by log hygiene.
 *
 * THIS LAYER STAYS HONEST. It throws `ApiError`/`DOMException` like every
 * other `refundApi` call — resolving to `[]` on failure is deliberately NOT
 * its job. `MotivoSuggestField` is the single place that swallows every
 * failure mode (AC-5.2), so a future non-composer caller does not silently
 * inherit a swallow it never asked for (plan.md "### Client contract").
 *
 * The response is `Cache-Control: no-store` server-side (plan D7) and the
 * parsed corpus is held in component memory only — never `localStorage`/
 * `sessionStorage`/IndexedDB (ADR-0001's posture applied to personal data,
 * and the spec's own explicit non-goal).
 */

import type { Entity } from '../components/EntityBadge'
import { getJson } from './refundApi'

/**
 * One trip signature — a derived view over the caller's own past `travel_km`
 * lines, never a stored record (spec.md Domain language; ADR-0013 lineage).
 * Mirrors `TripSuggestionSchema` in plan.md "## API contracts" exactly.
 */
export type TripSuggestion = {
  /** The group's MOST RECENT line's motivo, verbatim as typed — never folded (AC-2.5). */
  motivo: string
  /** The SERVER's fold of `motivo`. The client matches its folded query against this, and never re-folds a candidate (plan D3, risk R2). */
  normalisedMotivo: string
  km: number
  entity: Entity
  /** How many past lines share this trip signature within the 24-month window (AC-1.7/2.3). */
  count: number
  /** The group's most recent expense date, ISO date-only `YYYY-MM-DD` (AC-1.7/2.3). */
  lastUsedOn: string
}

/** `GET /line-suggestions`'s 200 body (plan.md `SuggestionsResponseSchema`). */
type SuggestionsResponse = {
  type: 'travel_km'
  /** 0..200, already ranked count desc → lastUsedOn desc → … (plan D8). The client never re-sorts. */
  suggestions: TripSuggestion[]
}

/**
 * Fetches the caller's own ranked `travel_km` trip corpus.
 *
 * `signal` is required, not optional: every caller must own a cancellation
 * path (plan D2 — an `AbortController` releases the socket on unmount, on the
 * field being disabled, and on the 5 s timeout that implements AC-5.2's "does
 * not answer in reasonable time"). Aborting rejects this promise with a
 * `DOMException` named `AbortError`, which the caller treats exactly like any
 * other failure.
 */
export const getTripSuggestions = async (signal: AbortSignal): Promise<TripSuggestion[]> => {
  const body = await getJson<SuggestionsResponse>('/line-suggestions?type=travel_km', { signal })
  return body.suggestions
}
