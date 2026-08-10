/**
 * addressCoordinates — the AC-2.6 coordinate-staleness rule, as a pure
 * function (T8, specs/012-employee-address/tasks.md, refs AC-2.6, AC-3.4;
 * plan.md "AC-2.6 — the coordinate-staleness rule, as a contract").
 *
 * A suggestion selection captures coordinates (AC-2.5). If the admin then
 * hand-edits ANY of the six structured components without picking a fresh
 * suggestion, the previously-captured coordinates must be dropped rather
 * than silently persisted alongside text they no longer describe (AC-2.6) —
 * stale coordinates have zero downstream consumer in this feature (spec
 * Non-goals), but persisting them anyway would be a quiet correctness bug
 * with no way for a later admin to notice.
 *
 * Deliberately a pure function rather than component state, so this rule
 * gets a real truth table (this file's test) instead of being provable only
 * by exercising `AddressSection`'s full state machine. `AddressSection.tsx`
 * (T11) also clears its own `coords` state eagerly on every relevant
 * `onChange` — belt and braces, per plan.md — but `coordinatesForSave` is
 * the single, authoritative decision point at submit time.
 */

import type { AddressComponents } from './googlePlaces'

export type LatLng = { lat: number; lng: number }

export type CoordinatesForSaveResult = { latitude: number; longitude: number } | { latitude: null; longitude: null }

const NO_COORDINATES: CoordinatesForSaveResult = { latitude: null, longitude: null }

/** The six structured values a coordinate snapshot is compared against — every one must match, byte-identical (plan.md). */
const COMPONENT_KEYS: (keyof AddressComponents)[] = [
  'countryCode',
  'city',
  'street',
  'houseNumber',
  'postalCode',
  'region',
]

/**
 * Returns `coords` only when a suggestion was actually selected (`snapshot`
 * is non-null, `coords` is non-null) AND every one of the six structured
 * components is still byte-identical to what it was at selection time.
 * Otherwise `{ latitude: null, longitude: null }` — including the AC-3.4
 * "never selected a suggestion at all" case, which falls out for free
 * because `snapshot` is `null` from the start.
 */
export const coordinatesForSave = (
  current: AddressComponents,
  snapshot: AddressComponents | null,
  coords: LatLng | null,
): CoordinatesForSaveResult => {
  if (snapshot === null || coords === null) return NO_COORDINATES

  const identical = COMPONENT_KEYS.every((key) => current[key] === snapshot[key])
  if (!identical) return NO_COORDINATES

  return { latitude: coords.lat, longitude: coords.lng }
}
