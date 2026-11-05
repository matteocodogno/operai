/**
 * A row lock on one meeting, for the writes that read-then-change it (specs/021-meetings).
 * Two creator edits of the same meeting (a source switch racing a consent, two participant
 * replacements) must not interleave their reads and writes, so each takes this lock first
 * and re-reads what it checks. Held until the transaction ends.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { meetingNotFound } from "./visibility";

/** Locks the row, or throws the identical 404 when it is gone (deleted since the caller opened it). */
export async function lockMeeting(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "meeting" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw meetingNotFound();
}
