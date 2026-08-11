/**
 * Prisma data-access for `GET /line-suggestions` (T3, specs/014-motivo-autocomplete).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY — THE OWNER SCOPE IS NOT NEGOTIABLE.                            │
 * │                                                                          │
 * │ `ownerUserId` is the caller's verified JWT `sub` and NOTHING ELSE. There │
 * │ is no code path, and no route parameter (suggestions.schemas.ts), by     │
 * │ which a caller can influence it — not their own permissions, not their   │
 * │ entity, not a query string (AC-4.1/4.2/4.3, ADR-0005 pattern).           │
 * │                                                                          │
 * │ In particular this function takes NO authorization context at all. That  │
 * │ is deliberate: an entity/review scope (ADR-0015) is a REVIEW concept,    │
 * │ and this is a self-scoped read, so there is deliberately no parameter    │
 * │ here through which a global `request:review` grant could widen the       │
 * │ result set (ADR-0042). Widening is not merely denied — it is             │
 * │ inexpressible.                                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * NO SCHEMA CHANGE, NO MIGRATION, NO NEW INDEX (plan § Data model). The
 * existing `refund_request(ownerUserId, status)` and `refund_line(requestId)`
 * indexes carry this query at the corpus size the feature targets (an
 * employee has tens of requests and low hundreds to low thousands of lifetime
 * lines). Escalation trigger, recorded so a future author does not have to
 * rediscover it: if a single user's lifetime `refund_line` count approaches
 * ~10 000, or this endpoint's p95 exceeds ~150 ms, add
 * `@@index([requestId, type, date])` — a pure addition with no data change.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";
import type { EntityValue } from "./requests.schemas";
import { suggestionWindowCutoff, type TripTriple } from "./suggestions.service";

/**
 * plan D5's defensive bound on DISTINCT exact triples pulled out of SQL —
 * 10x the 200-signature cap the service then applies, so the bound can only
 * ever bite for a corpus already far past the point where autocomplete helps.
 */
export const MAX_TRIP_TRIPLES = 2000;

// Prisma returns a `@db.Date` column as a Date at UTC midnight — slice the
// ISO string rather than using local-timezone formatting (mirrors
// rates/repo.ts and requests.service.ts's own isoDateOnly helpers).
const isoDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

/**
 * Every distinct exact `(motivo, km, entity)` triple among the caller's OWN
 * `travel_km` lines inside the 24-month suggestion window, with each triple's
 * line count and most recent expense date.
 *
 * Notable non-filters, each a spec requirement rather than an omission:
 *
 *  - **No status filter.** Lines in every status are eligible, `draft`
 *    included (AC-2.6, an accepted trade-off decided by the user: a trip
 *    becomes reusable immediately, at the cost of abandoned draft lines being
 *    suggestible).
 *  - **No entity filter.** `entity` is part of the trip signature (AC-2.2),
 *    not a scope — the caller sees their own lines under both legal entities.
 *  - **No `q`/text filter.** Matching happens in the browser over this
 *    projection; the typed text never reaches this service at all (plan D1,
 *    AC-4.4).
 *
 * `km: { not: null }` is both a correctness filter and a type guard: `km` is
 * nullable at the DB level (validated at the API boundary for `travel_km`,
 * not by a CHECK constraint), so a legacy or hand-inserted `travel_km` row
 * without a distance must not become a suggestion with a missing distance.
 * The TypeScript-side skip below is the belt to that braces.
 */
export function fetchTravelKmTriples(
  ownerUserId: string,
  now: Date = new Date(),
): Effect.Effect<TripTriple[], DatabaseError> {
  const cutoff = suggestionWindowCutoff(now);

  return Effect.tryPromise({
    try: () =>
      db.refundLine.groupBy({
        by: ["motivo", "km", "entity"],
        where: {
          type: "travel_km",
          date: { gte: cutoff },
          km: { not: null },
          // The ONLY scope. A relation filter, so Postgres resolves the
          // owner's request ids via refund_request(ownerUserId, status)'s
          // leading column.
          request: { is: { ownerUserId } },
        },
        _count: { _all: true },
        _max: { date: true },
        // Prisma requires an explicit orderBy whenever groupBy is combined
        // with take. Ordering by group size descending makes the bound
        // truncate the LEAST-used triples, which is the same direction the
        // service's ranking then sorts in — so the cap never silently drops a
        // triple that would have ranked highly.
        orderBy: [{ _count: { motivo: "desc" } }, { motivo: "asc" }],
        take: MAX_TRIP_TRIPLES,
      }),
    catch: toDbErr("Failed to load trip suggestions"),
  }).pipe(
    Effect.map((rows) =>
      rows.flatMap((row): TripTriple[] => {
        const lastUsed = row._max.date;
        // Both are structurally impossible given the `where` above; skipping
        // rather than asserting keeps a data anomaly from turning a read-only
        // enrichment into a 500 (AC-5.2's silent-degradation posture applies
        // to the server side too).
        if (row.km === null || lastUsed === null) return [];
        return [
          {
            motivo: row.motivo,
            km: row.km,
            entity: row.entity as EntityValue,
            count: row._count._all,
            lastUsedOn: isoDateOnly(lastUsed),
          },
        ];
      }),
    ),
  );
}
