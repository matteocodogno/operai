/**
 * The one reader of a meeting's Operai participants for hours-api (specs/20261112-meeting-hours; plan amendment 2026-11-25, S2).
 * Used by `readHoursFacts` (the snapshot a write compares against, `record.ts`) and by the notice's body (built at send time,
 * `delivery.ts`), so the two cannot order the same fact differently.
 */

import type { Prisma } from "../lib/generated/prisma/client";

/**
 * The distinct user ids of a meeting's Operai participants (an external participant has none), in the order the database sorts
 * `userId`: the order of the notice body (decisions T8) and, through hours-api's `desiredEntries`, the order automatic entries are
 * created in. Never re-sorted in JavaScript (a code-unit sort differs from the database's for mixed case). Reads only, no lock:
 * `readHoursFacts` has locked the meeting before it, the delivery reads in its own repeatable-read snapshot.
 */
export async function operaiParticipantIds(tx: Prisma.TransactionClient, meetingId: string): Promise<string[]> {
  const people = await tx.meetingParticipant.findMany({
    where: { meetingId, userId: { not: null } },
    select: { userId: true },
    orderBy: { userId: "asc" },
  });
  return [...new Set(people.flatMap((p) => (p.userId !== null ? [p.userId] : [])))];
}
