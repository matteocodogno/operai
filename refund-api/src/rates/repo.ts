/**
 * Prisma data-access layer for mileage rates (T4, specs/009-mileage-rate).
 *
 * `mileage_rate` is append-only (AC-4.7/5.2, the DB-level trigger added by
 * T2's migration) — this module intentionally offers no update/delete
 * function; the enforcement backstop lives at the database layer, not here.
 *
 * `fetchEffectiveRatesForPairs` is the batched resolver reused by the
 * draft-travel_km read/write paths (T5/T6): AT MOST ONE query per DISTINCT
 * entity present among the lines being resolved, regardless of how many
 * lines/dates are being resolved against it — mirrors batches.repo.ts's own
 * "fetch once, resolve in memory" convention for avoiding N+1 queries.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";
import { resolveEffectiveRate } from "./resolve";
import type { CurrencyValue, EntityValue } from "../requests/requests.schemas";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

export interface RateEntryRow {
  readonly id: string;
  readonly entity: EntityValue;
  readonly currency: CurrencyValue;
  readonly ratePerKmMicros: number;
  readonly validFrom: string; // YYYY-MM-DD
  readonly createdAt: Date;
  readonly createdByEmail: string;
}

// Prisma returns a `@db.Date` column as a Date at UTC midnight — slice the
// ISO string to YYYY-MM-DD rather than using local-timezone formatting
// (mirrors requests.service.ts's own isoDateOnly helper).
const isoDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

interface RawRateRow {
  readonly id: string;
  readonly entity: string;
  readonly currency: string;
  readonly ratePerKmMicros: number;
  readonly validFrom: Date;
  readonly createdAt: Date;
  readonly createdByEmail: string;
}

function toRateEntryRow(row: RawRateRow): RateEntryRow {
  return {
    id: row.id,
    entity: row.entity as EntityValue,
    currency: row.currency as CurrencyValue,
    ratePerKmMicros: row.ratePerKmMicros,
    validFrom: isoDateOnly(row.validFrom),
    createdAt: row.createdAt,
    createdByEmail: row.createdByEmail,
  };
}

const rateSelect = {
  id: true,
  entity: true,
  currency: true,
  ratePerKmMicros: true,
  validFrom: true,
  createdAt: true,
  createdByEmail: true,
} as const;

/** Every rate entry, both entities, chronological oldest-first (AC-4.1/5.3). */
export function listAllRateEntries(): Effect.Effect<RateEntryRow[], DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.mileageRate.findMany({
        orderBy: { createdAt: "asc" },
        select: rateSelect,
      }),
    catch: toDbErr("Failed to list mileage rates"),
  }).pipe(Effect.map((rows) => rows.map(toRateEntryRow)));
}

/** One entity's full history, oldest-first — the resolution input (AC-2.1/2.3). */
export function listRateEntriesForEntity(
  entity: EntityValue,
): Effect.Effect<RateEntryRow[], DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.mileageRate.findMany({
        where: { entity },
        orderBy: { createdAt: "asc" },
        select: rateSelect,
      }),
    catch: toDbErr("Failed to list mileage rates for entity"),
  }).pipe(Effect.map((rows) => rows.map(toRateEntryRow)));
}

export interface CreateRateEntryInput {
  readonly entity: EntityValue;
  readonly currency: CurrencyValue;
  readonly ratePerKmMicros: number;
  readonly validFrom: string; // YYYY-MM-DD
  readonly createdByUserId: string;
  readonly createdByEmail: string;
}

/** Appends one immutable rate entry (AC-4.2). */
export function createRateEntry(
  input: CreateRateEntryInput,
): Effect.Effect<RateEntryRow, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.mileageRate.create({
        data: {
          entity: input.entity as never,
          currency: input.currency as never,
          ratePerKmMicros: input.ratePerKmMicros,
          validFrom: new Date(`${input.validFrom}T00:00:00.000Z`),
          createdByUserId: input.createdByUserId,
          createdByEmail: input.createdByEmail,
        },
        select: rateSelect,
      }),
    catch: toDbErr("Failed to create mileage rate entry"),
  }).pipe(Effect.map(toRateEntryRow));
}

/** The rate in effect for a SINGLE (entity, date) pair right now (AC-2.1) — GET /rates/effective. */
export function fetchEffectiveRate(
  entity: EntityValue,
  date: string,
): Effect.Effect<RateEntryRow | null, DatabaseError> {
  return listRateEntriesForEntity(entity).pipe(
    Effect.map((entries) => resolveEffectiveRate(entries, entity, date)),
  );
}

export interface EntityDatePair {
  readonly entity: EntityValue;
  readonly date: string;
}

/** Composite key used by the returned Map — NUL cannot appear in either component. */
export function entityDateKey(entity: EntityValue, date: string): string {
  return `${entity}\0${date}`;
}

/**
 * Batched live-rate resolution for MULTIPLE (entity, date) pairs (T5/T6) —
 * at most one query per DISTINCT entity in `pairs`, however many lines/dates
 * are being resolved. Returns a Map keyed by `entityDateKey`, `null` value
 * meaning "no rate in effect for that pair" (AC-2.2) — never throws for that
 * case.
 */
export function fetchEffectiveRatesForPairs(
  pairs: readonly EntityDatePair[],
): Effect.Effect<Map<string, RateEntryRow | null>, DatabaseError> {
  const distinctEntities = Array.from(new Set(pairs.map((p) => p.entity)));
  return Effect.forEach(distinctEntities, (entity) =>
    listRateEntriesForEntity(entity),
  ).pipe(
    Effect.map((entriesPerEntity) => {
      const byEntity = new Map<EntityValue, RateEntryRow[]>();
      distinctEntities.forEach((entity, i) => {
        byEntity.set(entity, entriesPerEntity[i] ?? []);
      });
      const result = new Map<string, RateEntryRow | null>();
      for (const { entity, date } of pairs) {
        const entries = byEntity.get(entity) ?? [];
        result.set(entityDateKey(entity, date), resolveEffectiveRate(entries, entity, date));
      }
      return result;
    }),
  );
}
