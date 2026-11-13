/**
 * The local rules of an entry (specs/029 T14; plan § Entries, § Errors): what hours-api decides from the
 * request and its own tables alone, before any owner is asked. Pure — no database, no clock, no owner —
 * so the route, the list and the totals share ONE implementation of each (T17 and T18 import
 * `isCalendarDay` for `from` and `to`; plan amendment 4, 2026-11-13).
 */

import { unprocessable, type ProblemError } from "../lib/problem";

/**
 * A rule broken: 422 with the `code` a screen switches on (plan § Errors) and the `field` it lands on.
 * The detail names the rule, never the value sent (a note is what someone worked on).
 */
const refusal = (code: string, field: string, detail: string): ProblemError => unprocessable(detail, { field }, code);

// ─── A day (plan § Entries, "A day"; AC-1.3) ─────────────────────────────────

/** The earliest day hours-api takes: the product's bound, not the database's (Postgres holds every year from 0100). */
export const FIRST_DAY = "2000-01-01";

/** `YYYY-MM-DD`, ASCII digits only (`\d` is `[0-9]` in JavaScript, with or without the `u` flag; `$` is end of input). */
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar day from `2000-01-01`: exactly `YYYY-MM-DD` that comes back unchanged through `Date.UTC`
 * and is not before the floor. The round trip refuses what a parser would quietly turn into another day
 * (`new Date("2026-02-30")` is 2 March in Bun) and the floor refuses the years `Date.UTC` reads as 19xx
 * (`0050-01-01`) and the year 0 Postgres' `date` refuses (`0000-01-01`, a 500). The ceiling is the format's
 * own: `9999-12-31` is held by `Date.UTC` and by Postgres alike.
 *
 * Decided from the string alone — never from the time or from stored data — so it is a 400 wherever a day
 * travels (a body, `from`, `to`), and a day inside the rule but after today is a different answer, 422
 * `future_day`, raised by the route.
 */
export function isCalendarDay(text: string): boolean {
  if (!DAY_FORMAT.test(text)) return false;
  // The format is fixed-width, so a string comparison is a date comparison. It also keeps every year
  // `Date.UTC` would misread (0-99) out of the round trip below.
  if (text < FIRST_DAY) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === text;
}

/**
 * 422 `future_day` when `day` (already a calendar day) is after `today` (a day in `Europe/Zurich`,
 * src/entries/today.ts). Both are fixed-width `YYYY-MM-DD`, so a string comparison is a date comparison.
 * Nobody can record hours that have not been worked (AC-1.3); any day before today is allowed (AC-1.5).
 */
export function assertNotFuture(day: string, today: string): void {
  if (day > today) throw refusal("future_day", "day", "A day cannot be after today");
}

// ─── The category of an entry on no entity (AC-2.1, AC-3.4) ─────────────────

export interface CategoryFacts {
  readonly requiresNote: boolean;
  /** Set once the category is retired (restoring clears it). */
  readonly retiredAt: Date | null;
}

/**
 * The category a new or moved entry on no entity is given: one that exists (422 `category_not_found`) and is
 * not retired (422 `category_retired`; restored, it is offered again). An entry already on a retired
 * category keeps it — this is asked only of a category being CHOSEN (AC-3.4).
 */
export function chosenCategory<T extends CategoryFacts>(category: T | null): T {
  if (category === null) throw refusal("category_not_found", "on.categoryId", "No category has this id");
  if (category.retiredAt !== null) throw refusal("category_retired", "on.categoryId", "This category is retired and is no longer offered");
  return category;
}

// ─── What an entry may not carry (AC-2.1, AC-2.7, AC-3.5) ───────────────────

/** 422 `work_type_not_allowed`: a meeting and no entity carry none, and a project or a deal only its own list's. */
export const workTypeNotAllowed = (): ProblemError =>
  refusal("work_type_not_allowed", "workTypeId", "A work type fits only a project or a deal, from the list of that kind");

/** 422 `work_type_not_found`: no work type has this id (a well-formed id keeps the answer of an unknown one). */
export const workTypeNotFound = (): ProblemError => refusal("work_type_not_found", "workTypeId", "No work type has this id");

/** 422 `work_type_retired`: a retired work type is no longer offered; restored, it is offered again. */
export const workTypeRetired = (): ProblemError => refusal("work_type_retired", "workTypeId", "This work type is retired and is no longer offered");

/** The list of work types an entry on `target` takes from: its own kind's; a meeting and no entity take none. */
export const workTypeListOf = (target: "project" | "deal" | "meeting" | "none"): "project" | "deal" | null =>
  target === "project" || target === "deal" ? target : null;

/** 422 `activity_not_allowed`: only a project or a deal entry can point at an activity, and at one of its own. */
export const activityNotAllowed = (): ProblemError =>
  refusal("activity_not_allowed", "activityId", "An activity can only be pointed at from a project or a deal, and must belong to it");

// ─── A duration (AC-1.2, A9; the database CHECK `time_entry_minutes` enforces the same) ──────────────────

export const MINUTES_STEP = 30;
export const MINUTES_MAX = 1440;

/** A whole number of half-hours, 30 minutes to 24 hours. A duration only: the contract has no start or end (AC-1.8). */
export function isValidMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MINUTES_STEP && minutes <= MINUTES_MAX && minutes % MINUTES_STEP === 0;
}

/** 422 `invalid_minutes` unless `minutes` is a whole number of half-hours from 30 to 1440. */
export function assertMinutes(minutes: number): void {
  if (!isValidMinutes(minutes)) {
    throw refusal("invalid_minutes", "minutes", "A duration is a whole number of half-hours, from 30 minutes to 24 hours");
  }
}

// ─── A note (AC-1.7, AC-3.6; plan § Entries, "Counting a note and a name" and "A blank note") ───────────

export const NOTE_MAX_CODE_POINTS = 1000;

/**
 * Unicode code points, what the CHECK `time_entry_note_length` counts (`char_length`) and what OpenAPI's
 * `maxLength` means. Never `.length` (UTF-16 units: an emoji would count twice, and 501 of them would be
 * refused though the database holds 1000).
 */
export const countCodePoints = (text: string): number => [...text].length;

/** Blank: `trim` leaves nothing (spaces, tabs, line breaks, no-break spaces). A blank note is no note. */
export const isBlank = (text: string): boolean => text.trim() === "";

/**
 * The note as it is stored: none (`null`) when it is absent, `null` or blank, else exactly as sent — not
 * trimmed, because it is the person's text, exported whole (AC-4.6). Never `""`: one value for "no note".
 * Applied AFTER the length check (a long blank note is refused, not stored as none).
 */
export function storedNote(note: string | null | undefined): string | null {
  return note === undefined || note === null || isBlank(note) ? null : note;
}

/**
 * 422 `note_required` when the category the entry will have requires a note and the note it will have is
 * none. `note` is what will be STORED (`storedNote`): a note of spaces says nothing, so it never satisfies
 * the rule (AC-3.6). Whether this is asked at all on a `PATCH` is D50 (plan § Entries, "A blank note"):
 * the caller decides; this only judges.
 */
export function assertNoteRequired(category: Pick<CategoryFacts, "requiresNote"> | null, note: string | null): void {
  if (category?.requiresNote === true && note === null) {
    throw refusal("note_required", "note", "This category needs a note");
  }
}

/**
 * 422 `note_too_long` beyond 1000 code points. A blank note is measured too, so that hours-ui's "n of 1000"
 * counter and the server agree on every input (plan § Entries, "A blank note").
 */
export function assertNoteLength(note: string): void {
  if (countCodePoints(note) > NOTE_MAX_CODE_POINTS) {
    throw refusal("note_too_long", "note", `A note is at most ${NOTE_MAX_CODE_POINTS} characters`);
  }
}
