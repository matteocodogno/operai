/**
 * Row lock for one asset (T13-T16, specs/015-hardware-inventory).
 *
 * Every write that decides from an asset's CURRENT state (edit, status
 * transition, assignment create/confirm/decline/cancel) takes this first, in
 * its own transaction, and then reads the row fresh. A second writer queues
 * here until the first commits and then sees the first one's result, so the
 * decision is a compare-and-set in effect: exactly one of two competing
 * transitions applies, the other finds the new status and is refused.
 *
 * Lock order, where both are needed: the entity advisory lock (ADR-0046) FIRST,
 * the asset row second. A dated write takes both in that order; a write that
 * takes only the row cannot form a cycle with it.
 */

import type { Tx } from "../fiscal-years/guard";

/** Locks the asset row until the surrounding transaction ends; a no-op if it does not exist. */
export async function lockAsset(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "asset" WHERE "id" = ${id} FOR UPDATE`;
}
