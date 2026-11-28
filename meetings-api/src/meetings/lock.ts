/**
 * A row lock on one meeting, for the writes that read-then-change it (specs/20261104-meetings).
 * Two creator edits of the same meeting (a source switch racing a consent, two participant
 * replacements) must not interleave their reads and writes, so each takes this lock first
 * and re-reads what it checks. Held until the transaction ends.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { meetingNotFound } from "./visibility";

/** Takes one meeting's row lock until the transaction ends; `false` when there is no such row (it never throws for one). */
export async function lockMeetingRow(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "meeting" WHERE "id" = ${id} FOR UPDATE`;
  return rows.length > 0;
}

/** Locks the row, or throws the identical 404 when it is gone (deleted since the caller opened it). */
export async function lockMeeting(tx: Prisma.TransactionClient, id: string): Promise<void> {
  if (!(await lockMeetingRow(tx, id))) throw meetingNotFound();
}
