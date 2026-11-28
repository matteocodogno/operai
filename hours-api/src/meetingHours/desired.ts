/**
 * `desiredEntries` — what a meeting's facts say its automatic entries should be (specs/20261112-meeting-hours T4;
 * plan § "Applying a notice" step 3; ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it).
 *
 * PURE: no database, no network, no clock. Today is an argument, so the same facts, release day and today
 * always give the same answer, and a test never has to fix a clock. `apply()` (T6) calls it with the facts of a
 * notice, the release day (`meeting_hours_release.since`) and `today()`, then makes the meeting's untouched
 * entries match the answer. Whether a person already has an entry, deleted theirs or changed theirs is NOT
 * decided here: those are facts about rows, and `apply()` reads them.
 */

import type { MeetingHoursFacts } from "../lib/meetingHoursWire";
import { MINUTES_MAX, MINUTES_STEP } from "../entries/rules";
import { BUSINESS_ZONE, todayIn } from "../entries/today";

/** What one person's automatic entry on the meeting should say: the same for everyone who took part. */
export interface DesiredEntry {
  /** `YYYY-MM-DD`, the meeting's calendar day in Europe/Zurich (A35). */
  readonly day: string;
  /** A whole number of half-hours, 30 to 1440: what the `time_entry_minutes` CHECK holds (A36). */
  readonly minutes: number;
}

const STEP_MS = MINUTES_STEP * 60_000;

/**
 * The duration to the nearest half hour, a half step rounding UP (45 min → 1 h, 1 h 15 → 1 h 30), never below
 * 30 minutes (15 min → 30) and never above 24 hours (A36). `durationMs` is finite and above 0 here.
 */
function roundedMinutes(durationMs: number): number {
  return Math.min(MINUTES_MAX, Math.max(MINUTES_STEP, Math.floor((durationMs + STEP_MS / 2) / STEP_MS) * MINUTES_STEP));
}

/**
 * The automatic entries a meeting's facts call for, keyed by the person (a creator who is also listed as a
 * participant is one key: AC-1.2), in the order creator then participants. EMPTY — nobody — when:
 * - `facts` is null: the meeting no longer exists (AC-3.4);
 * - `durationMs` is null (not known: a typed meeting, or one not processed yet, AC-1.3) or 0 (a recording with
 *   no audio: "not known", not the 30-minute floor, D-P4);
 * - the meeting's Zurich day is before `since`, the release day (AC-1.5), or after `today` (A37: nobody can
 *   record hours that have not been worked, so the entry waits for its day).
 * `since` and `today` are `YYYY-MM-DD` days, compared as strings (fixed width), both inclusive.
 *
 * Throws a `RangeError` for a `startsAt` that is not an instant or a `durationMs` that is not a finite number:
 * the wire (`meetingHoursWire.ts`) refuses both before this is called, and an empty answer for garbage would be
 * read by `apply()` as "remove every untouched entry".
 */
export function desiredEntries(facts: MeetingHoursFacts | null, since: string, today: string): ReadonlyMap<string, DesiredEntry> {
  if (facts === null || facts.durationMs === null) return new Map();
  const { durationMs } = facts;
  if (!Number.isFinite(durationMs)) throw new RangeError("desiredEntries: durationMs is not a number");
  const startsAt = new Date(facts.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new RangeError("desiredEntries: startsAt is not an instant");
  if (durationMs <= 0) return new Map();

  const day = todayIn(BUSINESS_ZONE, startsAt);
  if (day < since || day > today) return new Map();

  const minutes = roundedMinutes(durationMs);
  const people = new Set([facts.creatorId, ...facts.participantIds]);
  return new Map([...people].map((userId) => [userId, { day, minutes }]));
}
