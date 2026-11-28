/**
 * `blockDeletedEntry` — the rule that keeps a deleted automatic entry deleted (specs/20261112-meeting-hours T5, T24; plan
 * § "The person's writes"; plan amendment 2026-11-25 S5; ADR
 * 20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it).
 *
 * AC-2.5: an automatic entry its person deletes is never recorded again for them on its meeting. Called by the DELETE route
 * (src/entries/entries.routes.ts) INSIDE ITS OWN TRANSACTION, right after the delete statement, with what that statement
 * returned: the block commits with the delete, so the committed state holds the entry or the block, never neither, and
 * apply()'s one-statement read (`readState`, src/meetingHours/apply.ts) sees one of them. It takes no lock and reads nothing
 * (a lock here would invert apply()'s order, decisions T5). Nothing for an entry its person typed (`sourceMeetingId` is null:
 * the CHECK `time_entry_origin_shape` sets it exactly for an automatic entry, and it survives its person moving the entry
 * elsewhere); a block already there is kept with its reason (`ON CONFLICT DO NOTHING`).
 *
 * A failure is not caught: it fails the route's transaction, which takes the delete back with it (a 500, the entry still there).
 */

import type { Prisma } from "../lib/generated/prisma/client";

/** The block `deleted` for (meeting, person), on `tx` (the DELETE's own transaction, never the shared client). */
export async function blockDeletedEntry(
  tx: Prisma.TransactionClient,
  deleted: { readonly userId: string; readonly sourceMeetingId: string | null },
): Promise<void> {
  if (deleted.sourceMeetingId === null) return;
  await tx.meetingHoursBlock.createMany({
    data: [{ meetingId: deleted.sourceMeetingId, userId: deleted.userId, reason: "deleted" }],
    skipDuplicates: true,
  });
}
