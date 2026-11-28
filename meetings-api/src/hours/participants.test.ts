import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import { operaiParticipantIds } from "./participants";

// `operaiParticipantIds` (plan amendment 2026-11-25, S2): the ONE reader of a meeting's Operai participants, used by the notice's
// body and by the lock-time snapshot. Its order is the database's order of `userId` (decisions T8): the wire's order and, through
// hours-api's `desiredEntries`, the order automatic entries are created in. Real database (`meetings_test`).

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting", "hours_notice" CASCADE');
});
afterAll(async () => {
  await db.$disconnect();
});

/** `zed-1`, `Bob-2`, `amy-3` (in that insertion order) and an external participant, who has no user id. */
async function seedMeeting() {
  const meeting = await db.meeting.create({
    data: {
      title: "Budget review",
      format: "online",
      startsAt: new Date("2026-11-24T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: "creator-1",
      durationMs: 1_800_000,
    } as never,
  });
  for (const userId of ["zed-1", "Bob-2"]) await db.meetingParticipant.create({ data: { meetingId: meeting.id, userId, addedBy: "creator-1" } });
  await db.meetingParticipant.create({ data: { meetingId: meeting.id, externalName: "External Eve", addedBy: "creator-1" } });
  await db.meetingParticipant.create({ data: { meetingId: meeting.id, userId: "amy-3", addedBy: "creator-1" } });
  return meeting;
}

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** The order the database sorts `userId` in (the test databases use `en_US.utf8`: `amy-3` < `Bob-2` < `zed-1`). */
const databaseOrder = async (tx: Tx, meetingId: string) =>
  (await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "meeting_participant" WHERE "meetingId" = ${meetingId} AND "userId" IS NOT NULL ORDER BY "userId"`).map(
    (r) => r.userId,
  );

describe("operaiParticipantIds", () => {
  it("lists the Operai participants' user ids in the database's order, never an external participant, never re-sorted", async () => {
    const m = await seedMeeting();
    const { ids, inDatabaseOrder } = await db.$transaction(async (tx) => ({ ids: await operaiParticipantIds(tx, m.id), inDatabaseOrder: await databaseOrder(tx, m.id) }));

    // Guards the test itself: where the collation agrees with a JavaScript sort this proves nothing, so it must fail.
    expect(inDatabaseOrder).not.toEqual([...inDatabaseOrder].sort());
    expect(inDatabaseOrder).toHaveLength(3);
    expect(ids).toEqual(inDatabaseOrder);
  });

  it("gets that order from the database's ORDER BY, not from the plan: with every index scan off the order is still the database's", async () => {
    // The unique index (meetingId, userId) hands the rows back already in the database's order, so a reader that dropped its
    // `orderBy` would still look right. With the index scans off Postgres reads the heap, in insertion order (`zed-1` first), and
    // only an ORDER BY puts the ids in order. `SET LOCAL` ends with the transaction.
    const m = await seedMeeting();
    const { ids, inDatabaseOrder, withoutOrderBy } = await db.$transaction(async (tx) => {
      for (const setting of ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]) await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
      const withoutOrderBy = (await tx.meetingParticipant.findMany({ where: { meetingId: m.id, userId: { not: null } }, select: { userId: true } })).map((p) => p.userId);
      return { ids: await operaiParticipantIds(tx, m.id), inDatabaseOrder: await databaseOrder(tx, m.id), withoutOrderBy };
    });

    // Guards the test itself: the heap order must differ from the database's, or this case cannot tell the two apart.
    expect(withoutOrderBy).not.toEqual(inDatabaseOrder);
    expect(ids).toEqual(inDatabaseOrder);
  });
});
