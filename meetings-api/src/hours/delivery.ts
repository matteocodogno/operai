/**
 * Delivering a hours notice (specs/20261112-meeting-hours T8; plan § "Delivering a notice (meetings-api)", ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older;
 * AC-1.1, AC-3.4, AC-4.1, AC-4.2).
 *
 * A change to what hours-api needs to know about a meeting (when it started, how long it lasted, who created it, who else
 * took part) leaves a content-free row in `hours_notice` IN THE CHANGE'S TRANSACTION and a `deliver_hours_notice` job
 * (`src/hours/record.ts`, T9). This module is what the job does with the row:
 *
 *   1. Load the row by id. Gone (delivered) or `failed` (refused for good): nothing to do.
 *   2. Build the body AT SEND TIME, from the meeting as it is now, with the shared wire schema
 *      (`src/lib/meetingHoursWire.ts`): `kind = deleted` or a meeting that no longer exists is `facts: null` at the row's own
 *      version; otherwise the facts of the meeting now at its CURRENT version. Operai participants only, no title, no
 *      external participant, no content (AC-4.1). A snapshot queued earlier could be older than a change it never saw (a lost
 *      update), so nothing is queued but the row.
 *   3. `sendHoursNotice`, then the outcome:
 *        delivered     the row is deleted (settled)
 *        refused       400 / 422, or a body the wire refuses: the row is kept as `failed` with its closed code and logged
 *                      `meeting_hours.notice_refused` (meeting id and code only); the job ends
 *        retry         anything else: `attempts` + 1, the code kept on the row, and the job fails transiently with the
 *                      schedule's delay (`hoursNoticeRetryDelayMs`): 30 s, 2 min, 10 min, then every 30 min, an entry a
 *                      person is waiting for (AC-4.2), and the job's attempt cap (`HOURS_NOTICE_MAX_ATTEMPTS`) never what
 *                      stops it
 *
 * Several pending rows for one meeting are delivered independently and in any order: each sends the facts as they are when
 * it is sent, and hours-api keeps only the newest version, so order, repetition and the loss of all but the last are
 * harmless.
 *
 * The row and its job carry NO personal data: the user ids are read here, when the body is built. Logs name the meeting id,
 * the version and a closed code. Never a user id, a title, a token or a body (specs/20261104-meetings AC-4.10; no user id:
 * this plan § Security).
 */

import { db } from "../lib/db";
import { Prisma } from "../lib/generated/prisma/client";
import type { HoursNotice } from "../lib/generated/prisma/client";
import { meetingHoursNoticeWire } from "../lib/meetingHoursWire";
import { hoursChannel, sendHoursNotice, type HoursNoticeFailureCode } from "./client";
import { operaiParticipantIds } from "./participants";

/** "Until delivered": the runner's attempt cap must never be what stops a hours notice. */
export const HOURS_NOTICE_MAX_ATTEMPTS = 1_000_000;

/** After job claim n fails: 30 s, 2 min, 10 min, then every 30 min. Shorter than host notices': a person is waiting for the entry. */
const RETRY_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/** How long to wait after claim number `attempt` (1-based) failed. */
export function hoursNoticeRetryDelayMs(attempt: number): number {
  return RETRY_SCHEDULE_MS[Math.min(Math.max(attempt, 1) - 1, RETRY_SCHEDULE_MS.length - 1)]!;
}

/** What a row can record as its last error: the client's closed codes and the two that never reach the client. */
export type HoursNoticeRowCode = HoursNoticeFailureCode | "disabled" | "invalid_notice";

export type HoursDeliveryOutcome =
  /** The row was delivered already, or refused for good before: nothing left to do. */
  | { readonly state: "gone" }
  | { readonly state: "delivered"; readonly applied: boolean }
  /** Failed for good: the row is `failed` and the job is over. */
  | { readonly state: "refused"; readonly code: HoursNoticeRowCode }
  /** Failed for now: the row stays `pending` and the job must be run again. */
  | { readonly state: "retry"; readonly code: HoursNoticeRowCode };

// ─── The body, at send time ──────────────────────────────────────────────────

/**
 * The candidate body for a row (validated by the wire schema before it is sent). The meeting and its participants are read in
 * one repeatable-read transaction, so the version and the facts are one picture.
 */
async function bodyFor(row: HoursNotice) {
  const gone = { noticeId: row.id, meeting: { id: row.meetingId, seq: row.seq, facts: null } };
  if (row.kind === "deleted") return gone;

  const found = await db.$transaction(
    async (tx) => {
      const meeting = await tx.meeting.findUnique({
        where: { id: row.meetingId },
        select: { hoursSeq: true, startsAt: true, durationMs: true, creatorUserId: true },
      });
      if (!meeting) return null;
      return { meeting, participantIds: await operaiParticipantIds(tx, row.meetingId) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!found) return gone;

  return {
    noticeId: row.id,
    meeting: {
      id: row.meetingId,
      // The current version, which is at least the row's; never a number below it.
      seq: Math.max(found.meeting.hoursSeq, row.seq),
      facts: {
        startsAt: found.meeting.startsAt.toISOString(),
        durationMs: found.meeting.durationMs,
        creatorId: found.meeting.creatorUserId,
        participantIds: found.participantIds,
      },
    },
  };
}

// ─── One delivery attempt ────────────────────────────────────────────────────

async function refuse(row: HoursNotice, code: HoursNoticeRowCode): Promise<HoursDeliveryOutcome> {
  await db.hoursNotice.updateMany({ where: { id: row.id }, data: { state: "failed", lastErrorCode: code } });
  console.error(`[hours] meeting_hours.notice_refused meeting=${row.meetingId} code=${code}`);
  return { state: "refused", code };
}

/**
 * One attempt to deliver the notice `noticeId`. Never throws for an outcome of the delivery (the job turns `retry` into its
 * transient failure); a database failure does throw, and the runner retries the job.
 */
export async function attemptHoursDelivery(noticeId: string): Promise<HoursDeliveryOutcome> {
  const row = await db.hoursNotice.findUnique({ where: { id: noticeId } });
  // Delivered by an earlier attempt, or refused for good earlier (a second job of the same row): nothing left to send.
  if (!row || row.state === "failed") return { state: "gone" };

  const channel = hoursChannel();
  if (!channel) return refuse(row, "disabled");

  const notice = meetingHoursNoticeWire.safeParse(await bodyFor(row));
  // The facts the meeting holds now are not ones the wire carries (an id over its cap): sending again cannot help.
  if (!notice.success) return refuse(row, "invalid_notice");

  const result = await sendHoursNotice(channel, notice.data);

  if (result.state === "delivered") {
    await db.hoursNotice.deleteMany({ where: { id: row.id } });
    console.log(`[hours] meeting_hours.notice_delivered meeting=${row.meetingId} seq=${notice.data.meeting.seq} applied=${result.applied}`);
    return { state: "delivered", applied: result.applied };
  }
  if (result.permanent) return refuse(row, result.code);

  await db.hoursNotice.updateMany({
    where: { id: row.id, state: "pending" },
    data: { attempts: { increment: 1 }, lastErrorCode: result.code },
  });
  console.warn(`[hours] meeting_hours.notice_retry meeting=${row.meetingId} seq=${row.seq} code=${result.code} attempts=${row.attempts + 1}`);
  return { state: "retry", code: result.code };
}
