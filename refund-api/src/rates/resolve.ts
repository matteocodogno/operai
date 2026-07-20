/**
 * Pure, DB-free effective-rate resolution (T3, specs/009-mileage-rate,
 * AC-2.1, AC-2.3, AC-2.4, AC-4.4).
 *
 * "In effect" (spec Domain language): for a given entity and date D, the
 * rate entry with the latest `validFrom` that is <= D. If no entry for that
 * entity has a `validFrom` on or before D, no rate is in effect (US-2,
 * AC-2.2) — this function returns `null`, never throws.
 *
 * Dates are compared as `YYYY-MM-DD` STRINGS, not `Date` objects — ISO
 * 8601 date-only strings sort correctly under plain string comparison
 * (lexical order == chronological order for a fixed-width, zero-padded
 * format), which sidesteps any timezone/UTC-midnight ambiguity entirely.
 * Callers (rates/repo.ts) are responsible for converting a Prisma
 * `@db.Date` column (returned as a UTC-midnight `Date`) to this shape —
 * mirrors `requests.service.ts`'s own `isoDateOnly` helper.
 *
 * Independent per-entity series (AC-2.3): this function only ever compares
 * entries whose `entity` matches the requested `entity` — configuring,
 * changing, or leaving unconfigured one entity's history has zero effect on
 * another entity's resolution, by construction (the `entity !== entity`
 * branch below skips non-matching rows outright).
 *
 * Future entries ignored (AC-4.4): an entry whose `validFrom` is AFTER `date`
 * is never selected, however recently it was added — a backdated OR
 * future-dated entry only ever affects resolution for dates on or after its
 * own `validFrom`.
 */

export interface RateEntryLike {
  readonly entity: string;
  /** ISO 8601 date-only, `YYYY-MM-DD`. */
  readonly validFrom: string;
}

/**
 * Returns the entry in effect for `(entity, date)`, or `null` if none
 * qualifies (AC-2.2). On a `validFrom` tie between two entries for the same
 * entity, the LATER element in `entries` wins — callers should pass entries
 * ordered oldest-created-first (rates/repo.ts's chronological listing) so a
 * tie resolves to the most-recently-added entry, though a legitimate tie is
 * not expected in practice (nothing in the spec forbids two entries sharing
 * a `validFrom`).
 */
export function resolveEffectiveRate<T extends RateEntryLike>(
  entries: readonly T[],
  entity: string,
  date: string,
): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (entry.entity !== entity) continue;
    if (entry.validFrom > date) continue; // future entry — never retroactive (AC-4.4)
    if (best === null || entry.validFrom >= best.validFrom) {
      best = entry;
    }
  }
  return best;
}
