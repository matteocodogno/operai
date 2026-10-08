/**
 * Closed-year guard and per-entity write lock (T9, specs/015-hardware-
 * inventory; AC-1.7, plan.md "Other decisions → Closed-year guard", ADR-0046).
 *
 * A fiscal year is closed for an entity exactly when a `fiscal_year` row exists
 * for it, and years close strictly in order (T20's `previous_year_open`), so
 * the closed years of an entity are always `…, max(year)`:
 *
 *     isClosed(entity, year)  ⇔  year <= max(fiscal_year.year where entity)
 *
 * Every DATED write — register, edit price/date, dispose, create a rule — and
 * the close itself must, in ONE transaction:
 *
 *   1. `lockEntity(tx, entity)`            take the entity's advisory lock,
 *   2. `assertYearOpen(tx, entity, year)`  then read the closed boundary.
 *
 * The order is the whole point. Closing takes the same lock, so a write that
 * got there second waits for the close to commit and THEN reads the boundary,
 * and sees it; a write that got there first has committed before the close can
 * start computing. Reading first and locking afterwards would let a backdated
 * write slip in under a close that is already running. (Under READ COMMITTED
 * every statement takes a fresh snapshot, which is what makes "lock, then read"
 * sufficient without SERIALIZABLE.)
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { ProblemError } from "../lib/problem";

/** A transaction handle from `db.$transaction(async (tx) => …)`. */
export type Tx = Prisma.TransactionClient;

/**
 * First half of the two-int advisory-lock key ("inventory entity lock"); the
 * second half is a hash of the entity. A distinct namespace means this can
 * never collide with another feature's advisory locks in the same database.
 */
const ENTITY_LOCK_NAMESPACE = 0x1a7e;

/**
 * Takes `pg_advisory_xact_lock` for `entity` and holds it until the surrounding
 * transaction commits or rolls back — there is nothing to release, and a
 * crashed request cannot leak the lock. Writers for the same entity queue;
 * writers for the other entity do not wait.
 */
export async function lockEntity(tx: Tx, entity: string): Promise<void> {
  // `pg_advisory_xact_lock` returns void; $executeRaw does not try to read the
  // (unreadable) column the way $queryRaw would.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENTITY_LOCK_NAMESPACE}::int, hashtext(${entity}))`;
}

/**
 * The latest closed year of `entity`, or `null` while none is closed. Years
 * `<=` it are closed.
 */
export async function lastClosedYear(
  tx: Tx,
  entity: string,
): Promise<number | null> {
  const row = await tx.fiscalYear.aggregate({
    where: { entity: entity as "welld_ch" | "welld_it" },
    _max: { year: true },
  });
  return row._max.year;
}

/** `year <= max(fiscal_year.year)` for the entity. */
export async function isClosed(
  tx: Tx,
  entity: string,
  year: number,
): Promise<boolean> {
  const closed = await lastClosedYear(tx, entity);
  return closed !== null && year <= closed;
}

/**
 * Throws the 409 `fiscal_year_closed` problem (top-level `year` member) when
 * `year` is closed for `entity`. Call after `lockEntity` in the same
 * transaction; the throw is also what rolls the transaction back.
 */
export async function assertYearOpen(
  tx: Tx,
  entity: string,
  year: number,
): Promise<void> {
  if (await isClosed(tx, entity, year)) {
    throw new ProblemError({
      status: 409,
      code: "fiscal_year_closed",
      detail: `Fiscal year ${year} is closed for this entity`,
      extras: { year },
    });
  }
}

/**
 * The calendar year of a `@db.Date` value. Prisma hands these back as a `Date`
 * at UTC midnight, so the UTC year is the date's year in every server timezone
 * (`getFullYear()` would read the previous year west of UTC on 1 January).
 */
export const yearOf = (date: Date): number => date.getUTCFullYear();
