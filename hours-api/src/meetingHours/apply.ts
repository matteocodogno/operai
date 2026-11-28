/**
 * `apply(notice)` — makes a meeting's automatic entries match the facts the newest notice states (specs/20261112-meeting-hours
 * T6; plan § "Applying a notice" steps 1-7; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older,
 * ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it).
 *
 * ONE transaction per notice, with NO outbound call (AC-2.6): it writes only this service's own tables, so a database
 * failure is the only way it fails, and a failure leaves nothing behind (the sender retries, a 500). The entries it
 * writes are ordinary `time_entry` rows of the people they are about (origin `meeting`, `sourceMeetingId` the meeting).
 *
 *   1. The row of `meeting_hours_meeting` is created if it is not there and LOCKED (`SELECT … FOR UPDATE`): every apply
 *      of one meeting waits for the one before it, so two deliveries can neither interleave nor create an entry twice.
 *   2. A notice OLDER than the version held changes nothing (`applied: false`); an EQUAL one is applied again, because
 *      applying is idempotent and the delivery of the day a future meeting begins (A37) sends the version it already sent.
 *   3. `desiredEntries` says who should have an entry, on which day, for how long (pure).
 *   4. One read of what is there: the meeting's entries and its blocks.
 *   5. Each UNTOUCHED entry (`followsMeeting`) follows: removed when its person is no longer wanted, moved or resized when
 *      the day or the minutes differ. Both statements say `AND "followsMeeting"`: it is the compare-and-set against a
 *      person's PATCH that commits after step 4 read the entry as untouched (AC-3.5) — their values stand.
 *   6. Each person wanted who has no automatic entry for this meeting (changed or not, wherever they moved it) and no
 *      block gets one — unless they already hold another entry on the meeting: then they get the block `had_entry` and no
 *      entry (AC-1.4); a person who deleted theirs has the block `deleted` from the DELETE route (AC-2.5).
 *   7. The version held becomes the notice's.
 *
 * The unique index `time_entry_one_automatic_per_meeting` (userId, sourceMeetingId) is the database's "never twice"
 * (AC-4.2); the lock of step 1 makes it unreachable, and a violation would fail the apply loudly instead of being
 * skipped.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { dayDate } from "../entries/rules";
import { today } from "../entries/today";
import type { MeetingHoursNotice } from "../lib/meetingHoursWire";
import { desiredEntries } from "./desired";

export interface ApplyResult {
  /** False only for a notice older than the version already applied: nothing was written. */
  readonly applied: boolean;
}

/** How many entries one apply wrote and how many people it blocked: the numbers of the log line, never who. */
interface Counts {
  created: number;
  moved: number;
  removed: number;
  blocked: number;
}

/** An automatic entry of the meeting as it was read: touched (`followsMeeting` false) or not, wherever its person has put it. */
interface AutomaticEntry {
  readonly id: string;
  readonly userId: string;
  readonly followsMeeting: boolean;
  readonly day: string;
  readonly minutes: number;
}

/** What the meeting has, read in ONE statement (see `readState`). */
interface State {
  readonly automatic: readonly AutomaticEntry[];
  /** People who hold an entry on the meeting that Operai did not write for it (their own, or an automatic one of another meeting they moved here). */
  readonly withOwnEntry: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
}

interface StateRow {
  readonly kind: "entry" | "block";
  readonly id: string | null;
  readonly userId: string;
  readonly sourceMeetingId: string | null;
  readonly followsMeeting: boolean | null;
  readonly day: string | null;
  readonly minutes: number | null;
}

/**
 * The meeting's entries and its blocks, in ONE statement, so that both come from one snapshot. The person's DELETE
 * (`entries.routes.ts`) removes an automatic entry and inserts its block in one transaction, and a snapshot sees that
 * transaction whole or not at all: apply can see the entry, or the block, never neither — which would read as "this person
 * has no entry and may get one", recording again what they just deleted (AC-2.5). Two reads, blocks first, would allow
 * exactly that. (The entries are those on the meeting plus those recorded for it that their person moved away.)
 */
async function readState(tx: Prisma.TransactionClient, meetingId: string): Promise<State> {
  const rows = await tx.$queryRaw<StateRow[]>`
    SELECT 'entry'::text AS "kind", "id", "userId", "sourceMeetingId", "followsMeeting", to_char("day", 'YYYY-MM-DD') AS "day", "minutes"
      FROM time_entry
     WHERE "meetingId" = ${meetingId} OR "sourceMeetingId" = ${meetingId}
    UNION ALL
    SELECT 'block'::text, NULL::text, "userId", NULL::text, NULL::boolean, NULL::text, NULL::integer
      FROM meeting_hours_block
     WHERE "meetingId" = ${meetingId}`;
  const entries = rows.filter((row) => row.kind === "entry");
  return {
    automatic: entries
      .filter((row) => row.sourceMeetingId === meetingId)
      .map((row) => ({ id: row.id!, userId: row.userId, followsMeeting: row.followsMeeting!, day: row.day!, minutes: row.minutes! })),
    withOwnEntry: new Set(entries.filter((row) => row.sourceMeetingId !== meetingId).map((row) => row.userId)),
    blocked: new Set(rows.filter((row) => row.kind === "block").map((row) => row.userId)),
  };
}

export async function apply(notice: MeetingHoursNotice): Promise<ApplyResult> {
  const { id: meetingId, seq, facts } = notice.meeting;
  const counts: Counts = { created: 0, moved: 0, removed: 0, blocked: 0 };

  const applied = await db.$transaction(async (tx) => {
    // 1. The lock of this meeting.
    await tx.meetingHoursMeeting.createMany({ data: [{ meetingId, seq: 0 }], skipDuplicates: true });
    const held = await tx.$queryRaw<Array<{ seq: number }>>`SELECT "seq" FROM meeting_hours_meeting WHERE "meetingId" = ${meetingId} FOR UPDATE`;
    // 2. An older version than the one applied changes nothing; an equal one is applied again.
    if (seq < held[0]!.seq) return false;

    // 3. Who should have an entry. Read after the lock, so the release day and today are those of the apply that runs.
    const release = await tx.meetingHoursRelease.findUniqueOrThrow({ where: { id: 1 } });
    const desired = desiredEntries(facts, release.since.toISOString().slice(0, 10), today());

    // 4. What is there.
    const state = await readState(tx, meetingId);

    // 5. Untouched entries follow.
    const unwanted = state.automatic.filter((entry) => entry.followsMeeting && !desired.has(entry.userId)).map((entry) => entry.id);
    if (unwanted.length > 0) {
      counts.removed += (await tx.timeEntry.deleteMany({ where: { id: { in: unwanted }, followsMeeting: true } })).count;
    }
    for (const entry of state.automatic) {
      const wanted = desired.get(entry.userId);
      if (!entry.followsMeeting || wanted === undefined || (wanted.day === entry.day && wanted.minutes === entry.minutes)) continue;
      counts.moved += (
        await tx.timeEntry.updateMany({ where: { id: entry.id, followsMeeting: true }, data: { day: dayDate(wanted.day), minutes: wanted.minutes } })
      ).count;
    }

    // 6. People wanted who have none: an entry, or the block that says they already had one.
    const hasAutomatic = new Set(state.automatic.map((entry) => entry.userId));
    for (const [userId, { day, minutes }] of desired) {
      if (hasAutomatic.has(userId) || state.blocked.has(userId)) continue;
      if (state.withOwnEntry.has(userId)) {
        counts.blocked += (await tx.meetingHoursBlock.createMany({ data: [{ meetingId, userId, reason: "had_entry" }], skipDuplicates: true })).count;
        continue;
      }
      await tx.timeEntry.create({
        data: {
          userId,
          day: dayDate(day),
          minutes,
          target: "meeting",
          meetingId,
          origin: "meeting",
          sourceMeetingId: meetingId,
          followsMeeting: true,
          note: null,
        },
      });
      counts.created += 1;
    }

    // 7. This is the version held now.
    await tx.meetingHoursMeeting.update({ where: { meetingId }, data: { seq, appliedAt: new Date() } });
    return true;
  });

  // After the commit: a rolled-back apply logs nothing here (the route's error handler logs the failure). The meeting's
  // id and the numbers, never a person: who got an entry is in the database, not in the log.
  console.log("meeting_hours.applied", { noticeId: notice.noticeId, meetingId, seq, applied, ...counts });
  return { applied };
}
