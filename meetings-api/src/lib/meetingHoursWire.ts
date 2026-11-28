/**
 * `meetingHoursWire` — the body of `POST /system/meeting-hours/v1/notices` (specs/20261112-meeting-hours T2;
 * plan § API contracts, "hours-api — `POST /system/meeting-hours/v1/notices`"; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older).
 *
 * meetings-api builds the body with this schema when it sends a notice and hours-api parses it with the same
 * code when it applies one, so the two sides cannot each read the wire their own way and drift (plan R2, R7).
 * This file is a byte-identical copy in `meetings-api/src/lib/meetingHoursWire.ts` and
 * `hours-api/src/lib/meetingHoursWire.ts`; `scripts/check-shared-copies.ts` (`mise run shared:check`, in CI)
 * fails when they differ by a byte. A change to the wire is a change to both files in one commit.
 *
 * STRICT. Every object refuses a key it does not list, so a field added on one side only is a failure and
 * never silently dropped, and a title, an external participant, a host or any content of the meeting can
 * never ride along (AC-4.1). `facts` is required: a body that forgot it is a refusal, never read as "the
 * meeting no longer exists" (that is `facts: null`, written out).
 */

// shared-copy:begin meetingHoursWire
import { z } from "zod";

/** The longest id of a notice, a meeting or a person on the wire. */
export const MEETING_HOURS_ID_MAX = 64;

/**
 * The most Operai participants one notice carries. meetings-api caps a meeting at 30 (its own rule); this is
 * the wire's ceiling, above it, so raising that cap to 100 or fewer never turns a notice into a permanent 400
 * (plan R7).
 */
export const MEETING_HOURS_PARTICIPANTS_MAX = 100;

/** The largest value of a Postgres `integer`: the ceiling of a version and of a duration in milliseconds. */
const INT4_MAX = 2_147_483_647;

const id = z.string().min(1).max(MEETING_HOURS_ID_MAX);

/**
 * What hours-api needs to know about a meeting, as it is when the notice is sent: when it started, how long it
 * lasted, who created it and who else took part. No title, no external participant, no content.
 */
export const meetingHoursFactsWire = z.strictObject({
  /** ISO 8601 date-time WITH an offset (`Z` or `+01:00`): an instant, never a local time of unknown zone. */
  startsAt: z.iso.datetime({ offset: true }),
  /** The duration in milliseconds; `null` is "not known" (a typed meeting, or one not processed yet). */
  durationMs: z.number().int().min(0).max(INT4_MAX).nullable(),
  creatorId: id,
  /** Operai participants only (an external one has no account); the creator may or may not be listed. */
  participantIds: z
    .array(id)
    .max(MEETING_HOURS_PARTICIPANTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, "participantIds must be distinct"),
});
export type MeetingHoursFacts = z.infer<typeof meetingHoursFactsWire>;

export const meetingHoursNoticeWire = z.strictObject({
  /** Identifies one delivery for the logs; hours-api does not store it. */
  noticeId: id,
  meeting: z.strictObject({
    id,
    /** The version of these facts (`Meeting.hoursSeq`); hours-api applies only a version not older than the one it holds. */
    seq: z.number().int().min(1).max(INT4_MAX),
    /** `null`: the meeting no longer exists. */
    facts: meetingHoursFactsWire.nullable(),
  }),
});
export type MeetingHoursNotice = z.infer<typeof meetingHoursNoticeWire>;
// shared-copy:end meetingHoursWire
