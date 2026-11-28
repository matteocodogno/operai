/**
 * Recording a hours notice (specs/20261112-meeting-hours T9; plan § "Where meetings-api records a notice", ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older;
 * AC-1.1, AC-1.3, AC-3.1 to AC-3.4, AC-3.7, A37).
 *
 * meetings-api owns the facts of a meeting that hours-api turns into entries: when it started, how long it lasted, who created
 * it and which Operai users took part. A write that changes one of them calls this module INSIDE ITS OWN TRANSACTION, so the
 * announcement exists exactly when the change does (a rollback takes both):
 *
 *     const before = await readHoursFacts(tx, id);            // the meeting as it is, row locked
 *     … the write …
 *     await recordHoursNotice(tx, id, { before }, now);        // compares, then records or does nothing
 *
 * and a deletion, before the row goes:
 *
 *     await recordHoursNotice(tx, id, { deleted: true }, now);
 *
 * WHEN a notice is recorded is decided HERE, from what changed, not by each caller (seven write paths, one rule):
 *
 *   - a hours fact changed (`startsAt`, `durationMs`, the SET of Operai participant ids; the creator never changes), and
 *   - the meeting has a duration before OR after the write (a typed meeting, an unprocessed one, never has; one whose
 *     duration was taken back by a refused upload had, and hours-api must remove the entries).
 *   - a deletion is announced only when something was announced before (`hoursSeq > 0`): else hours-api knows nothing of it.
 *   - nothing at all while the hours channel is off (`hoursChannel()`: no `HOURS_API_URL` or no service credential).
 *
 * WHAT is recorded: the meeting's `hoursSeq` is bumped (that is also the row lock), one `hours_notice` row
 * `{ meetingId, seq, kind }` and one `deliver_hours_notice` job carrying only the notice's id are written. Neither holds a
 * fact: the body is built from the meeting as it is when it is SENT (`delivery.ts`). The job has no `meetingId`, so the
 * cascade of a deleted meeting does not take it with it, and `hours_notice` has no foreign key to `meeting` for the same reason.
 *
 * A DAY STILL AHEAD (A37): hours-api records nothing for a day after today, so for a `state` notice whose meeting falls on a
 * later Zurich day a SECOND row and job are written, due at 00:01 Zurich of that day. It re-sends the facts of that moment,
 * which hours-api applies again (equal versions are re-applied), and the entries appear the day they may exist.
 *
 * No personal data is logged or stored here, and nothing is logged: the delivery logs what happened to a notice.
 */

import { enqueueJob } from "../jobs/runner";
import type { Prisma } from "../lib/generated/prisma/client";
import { lockMeetingRow } from "../meetings/lock";
import { hoursChannel } from "./client";
import { HOURS_NOTICE_MAX_ATTEMPTS } from "./delivery";
import { operaiParticipantIds } from "./participants";
import { zurichDay, zurichInstant } from "./recordDay";

/** The minute of a Zurich day at which an entry may exist (A37): 00:01. */
const FIRST_MINUTE = 1;

/**
 * The facts hours-api builds entries from, as `readHoursFacts` snapshots them for the lock-time compare. Ids of Operai
 * participants only, distinct, in the database's order of user id (`operaiParticipantIds`). The wire form of the same facts is
 * `MeetingHoursFacts` (`src/lib/meetingHoursWire.ts`): its `startsAt` is an ISO string and it also carries `creatorId`, which
 * is never compared here (the creator never changes).
 */
export interface HoursFacts {
  readonly startsAt: Date;
  readonly durationMs: number | null;
  readonly participantIds: readonly string[];
}

/** What a write path tells `recordHoursNotice`: the meeting is about to be deleted, or what it looked like before the write. */
export type HoursChange = { readonly deleted: true } | { readonly before: HoursFacts | null };

/**
 * The hours facts of a meeting as `tx` sees them, or `null` when there is no such meeting (never the 404 `lockMeeting` throws:
 * `prepare_audio` relies on `null` for a meeting deleted while ffmpeg ran). It TAKES THE MEETING'S ROW LOCK (`lockMeetingRow`,
 * held until `tx` ends): the snapshot a write compares against must not be stale by the time the write lands, or a concurrent
 * change could slip between the two unannounced. Every write path takes that lock for its own change anyway, in the same order.
 */
export async function readHoursFacts(tx: Prisma.TransactionClient, meetingId: string): Promise<HoursFacts | null> {
  if (!(await lockMeetingRow(tx, meetingId))) return null;
  const meeting = await tx.meeting.findUnique({ where: { id: meetingId }, select: { startsAt: true, durationMs: true } });
  if (!meeting) return null;
  return { startsAt: meeting.startsAt, durationMs: meeting.durationMs, participantIds: await operaiParticipantIds(tx, meetingId) };
}

const sameFacts = (a: HoursFacts, b: HoursFacts): boolean =>
  a.startsAt.getTime() === b.startsAt.getTime() &&
  a.durationMs === b.durationMs &&
  a.participantIds.length === b.participantIds.length &&
  a.participantIds.every((id, i) => id === b.participantIds[i]);

/**
 * The next version of the meeting's hours facts, taken with a row lock. `announcedOnly`: only when a version was already
 * announced (`hoursSeq > 0`); `null` when it was not, or the meeting does not exist.
 */
async function nextVersion(tx: Prisma.TransactionClient, meetingId: string, announcedOnly: boolean): Promise<number | null> {
  const rows = await tx.$queryRaw<{ hoursSeq: number }[]>`
    UPDATE "meeting" SET "hoursSeq" = "hoursSeq" + 1
     WHERE "id" = ${meetingId} AND (NOT ${announcedOnly}::boolean OR "hoursSeq" > 0)
    RETURNING "hoursSeq"`;
  return rows[0]?.hoursSeq ?? null;
}

/** One `hours_notice` row and its until-delivered job (`runAfter`: when it may first be claimed). */
async function enqueueNotice(tx: Prisma.TransactionClient, meetingId: string, seq: number, kind: "state" | "deleted", runAfter: Date): Promise<void> {
  const notice = await tx.hoursNotice.create({ data: { meetingId, seq, kind }, select: { id: true } });
  await enqueueJob(tx, { kind: "deliver_hours_notice", noticeId: notice.id, maxAttempts: HOURS_NOTICE_MAX_ATTEMPTS, runAfter });
}

/**
 * Records the notice a write of the meeting owes hours-api, if it owes one. Call it inside the write's transaction, after the
 * write (a deletion: before the row is deleted). Returns whether a notice was recorded.
 */
export async function recordHoursNotice(tx: Prisma.TransactionClient, meetingId: string, change: HoursChange, now: Date = new Date()): Promise<boolean> {
  if (hoursChannel() === null) return false;

  if ("deleted" in change) {
    const seq = await nextVersion(tx, meetingId, true);
    if (seq === null) return false;
    await enqueueNotice(tx, meetingId, seq, "deleted", now);
    return true;
  }

  const after = await readHoursFacts(tx, meetingId);
  if (after === null) return false;
  const { before } = change;
  if (before !== null && sameFacts(before, after)) return false;
  // Nothing for hours-api to build, or to take back, from a meeting that never had a duration (a typed one, an unprocessed one).
  if (before?.durationMs == null && after.durationMs === null) return false;

  const seq = await nextVersion(tx, meetingId, false);
  if (seq === null) return false;
  await enqueueNotice(tx, meetingId, seq, "state", now);

  // A37: a day still ahead records nothing yet; send the facts again the minute it starts to count.
  const day = zurichDay(after.startsAt);
  if (day > zurichDay(now)) await enqueueNotice(tx, meetingId, seq, "state", zurichInstant(day, FIRST_MINUTE));
  return true;
}
