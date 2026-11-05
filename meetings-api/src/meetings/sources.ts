/**
 * The retained SOURCES of a meeting's audio (the saved chunks, the uploaded original): the one
 * query behind the retry rule's `oldestSourceAt` (AC-6.9), used by the retry route and the view.
 */

import type { Prisma } from "../lib/generated/prisma/client";

type Client = Pick<Prisma.TransactionClient, "recordingChunk" | "meetingUpload">;

/** The oldest stored-at instant among the kept sources, or null when none is kept. */
export async function oldestSourceAt(client: Client, meetingId: string): Promise<Date | null> {
  const [chunks, upload] = await Promise.all([
    client.recordingChunk.aggregate({ where: { meetingId, storedAt: { not: null } }, _min: { storedAt: true } }),
    client.meetingUpload.findUnique({ where: { meetingId }, select: { mintedAt: true } }),
  ]);
  return upload?.mintedAt ?? chunks._min.storedAt ?? null;
}
