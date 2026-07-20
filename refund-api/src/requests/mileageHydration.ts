/**
 * Draft-travel_km live-recompute (T5, specs/009-mileage-rate, Decision 1,
 * ADR-0013, AC-2.4, AC-3.2, Risk R2).
 *
 * `GET /requests/:id` must recompute each DRAFT travel_km line's amount
 * against the CURRENTLY effective rate on every read — never trust the
 * denormalized `requestedAmountCents` cache written at the line's last
 * create/update (Risk R2: "the stale cache is never the authoritative value
 * at any decision point"). A non-draft request (submitted/approved/
 * rejected/paid) is passed through unchanged — its travel_km lines are
 * FROZEN (Decision 1) and read their stored `appliedRateMicros`/
 * `appliedRateValidFrom` snapshot directly (requests.service.ts's
 * `buildMileageInfo`), no DB round-trip needed here.
 *
 * Batched: at most one query PER DISTINCT ENTITY among the request's
 * travel_km lines (rates/repo.ts's `fetchEffectiveRatesForPairs`), never one
 * query per line.
 *
 * IMPORTANT: this returns a NEW array with `requestedAmountCents` OVERWRITTEN
 * to the live-recomputed value for each draft travel_km line — so
 * `computeSubtotals` (which reads straight off `requestedAmountCents`) and
 * `mapLine`'s `mileage.computedAmountCents` can never disagree with each
 * other (both consume the SAME hydrated row).
 */

import { Effect } from "effect";
import type { DatabaseError } from "../lib/errors";
import { entityDateKey, fetchEffectiveRatesForPairs } from "../rates/repo";
import { computeMileageAmountCents } from "../rates/computeMileageAmountCents";
import type { EntityValue } from "./requests.schemas";
import type { LineRow } from "./requests.service";

const isoDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export function hydrateDraftMileageLines(
  lines: readonly LineRow[],
  requestStatus: string,
): Effect.Effect<LineRow[], DatabaseError> {
  if (requestStatus !== "draft") {
    return Effect.succeed(lines as LineRow[]);
  }

  const mileageLines = lines.filter((l) => l.type === "travel_km");
  if (mileageLines.length === 0) {
    return Effect.succeed(lines as LineRow[]);
  }

  const pairs = mileageLines.map((l) => ({
    entity: l.entity as EntityValue,
    date: isoDateOnly(l.date),
  }));

  return fetchEffectiveRatesForPairs(pairs).pipe(
    Effect.map((rateMap) =>
      lines.map((line): LineRow => {
        if (line.type !== "travel_km") return line;
        const key = entityDateKey(line.entity as EntityValue, isoDateOnly(line.date));
        const rate = rateMap.get(key) ?? null;
        const km = line.km ?? 0;
        return {
          ...line,
          requestedAmountCents: rate ? computeMileageAmountCents(km, rate.ratePerKmMicros) : 0,
          liveRate: rate ? { ratePerKmMicros: rate.ratePerKmMicros, validFrom: rate.validFrom } : null,
        };
      }),
    ),
  );
}
