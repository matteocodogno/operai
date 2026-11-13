/**
 * One time entry as a viewer reads it (specs/029 T13; plan § API contracts "Views"; AC-2.6, AC-2.9, AC-4.7,
 * AC-4.8, AC-4.10). The shape every route that returns an entry shares: `POST` / `PATCH /time-entries`
 * (one entry), `GET /time-entries` (a page), and the rows of the export.
 *
 * The entry's own columns (day, minutes, note, the category and work type) come from the row. Everything
 * that belongs to another service — the person's name, the project, deal or meeting, the activity, and
 * the deal a meeting's hours count for — is read live through `src/labels/` AS THE VIEWER and shows only
 * what the viewer may read: a thing they may not read keeps its type and its minutes and loses its name, link,
 * subject and, unless the entry is the viewer's own, its id (AC-4.10, D44); a source that did not answer
 * degrades only the part it covers and is named in `unavailable` (AC-4.7). The entry is always listed and counted.
 *
 * THE ID RULE (D44, owasp-report.md F1; ADR-0089 A1): the id of a project, deal or meeting, and of an activity,
 * travels only when the viewer may read the record (`visibility: "visible"`) or the entry is the viewer's own
 * (`row.userId === viewerId`: they booked it, they know what it is on). Otherwise it is `null`. A hidden id
 * handed out by a list is what the `dealId` / `meetingId` / `projectId` filters turn into a probe for which
 * hidden meetings are linked to which hidden deal, so the viewer is given nothing to feed them. Not an id
 * rule: `on.deal`, the category of an entry on no entity (hours-api's own list), the work type, the person.
 */

import { z } from "@hono/zod-openapi";
import type { Prisma } from "../lib/generated/prisma/client";
import { resolveLabels, type LabelNeeds, type Labels } from "../labels/resolve";
import type { EntityLabel, UnavailableSources, Visibility } from "../labels/types";

export const ENTRY_INCLUDE = { category: true, workType: true } as const satisfies Prisma.TimeEntryInclude;
export type EntryRow = Prisma.TimeEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

// ─── The wire shape ──────────────────────────────────────────────────────────
// Strict throughout: a member the contract does not name (a deal id on a hidden deal, above all) fails the
// schema instead of travelling quietly. An id that may be withheld is `string | null`, never absent: the member
// stays, so a client reads `null` as "not yours to know" and not as a shape it does not recognise.

const VisibilitySchema = z.enum(["visible", "hidden", "unavailable"]);

const PersonSchema = z.object({ id: z.string(), name: z.string().nullable(), status: z.enum(["active", "deleted", "unknown"]) }).strict();

/**
 * A project, deal or meeting as the viewer reads it: `label` and `href` (a suite path) only while `visible`;
 * `id` only while `visible` or when the entry is the viewer's own (D44), else `null`.
 */
const entityParts = { id: z.string().nullable(), label: z.string().nullable(), href: z.string().nullable(), visibility: VisibilitySchema };

/** The deal a meeting's hours count for: its id only with `visibility: "visible"` (ADR-0058, ADR-0089). */
export const MeetingDealSchema = z.union([
  z.object({ state: z.literal("linked"), visibility: z.literal("visible"), id: z.string(), label: z.string(), href: z.string() }).strict(),
  z.object({ state: z.literal("linked"), visibility: z.enum(["hidden", "unavailable"]) }).strict(),
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);

const OnSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project"), ...entityParts }).strict(),
  z.object({ type: z.literal("deal"), ...entityParts }).strict(),
  z.object({ type: z.literal("meeting"), ...entityParts, deal: MeetingDealSchema }).strict(),
  z.object({ type: z.literal("none"), category: z.object({ id: z.string(), name: z.string(), retired: z.boolean() }).strict() }).strict(),
]);

export const TimeEntryViewSchema = z
  .object({
    id: z.string(),
    /** `YYYY-MM-DD`. */
    day: z.string(),
    minutes: z.number().int(),
    /** `null`: no note. Never blank (plan § Entries, "A blank note"). */
    note: z.string().nullable(),
    person: PersonSchema,
    on: OnSchema,
    workType: z.object({ id: z.string(), name: z.string(), retired: z.boolean() }).strict().nullable(),
    /**
     * `null`: it points at none, or the activity is gone (AC-2.9). `subject` only while `visible`; `id` only while
     * `visible` or when the entry is the viewer's own (D44), else `null`.
     */
    activity: z.object({ id: z.string().nullable(), subject: z.string().nullable(), visibility: VisibilitySchema }).strict().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .openapi("TimeEntryView");

export type TimeEntryView = z.infer<typeof TimeEntryViewSchema>;
type EntryOn = TimeEntryView["on"];

export interface EntryViews {
  readonly items: TimeEntryView[];
  /** The sources that were asked and did not answer (AC-4.7). */
  readonly unavailable: UnavailableSources;
}

/** The ids of every kind a set of entries needs labelled. */
export function needsOf(rows: readonly EntryRow[]): LabelNeeds {
  const idsOf = (target: EntryRow["target"], pick: (row: EntryRow) => string | null): string[] =>
    rows.flatMap((row) => {
      const id = row.target === target ? pick(row) : null;
      return id === null ? [] : [id];
    });
  const meetingIds = idsOf("meeting", (row) => row.meetingId);
  return {
    userIds: rows.map((row) => row.userId),
    projectIds: idsOf("project", (row) => row.projectId),
    dealIds: idsOf("deal", (row) => row.dealId),
    // The title is read as the viewer, the current deal with hours-api's own credential: two sources, one id list.
    meetingIds,
    meetingDealIds: meetingIds,
    activityIds: rows.flatMap((row) => (row.activityId === null ? [] : [row.activityId])),
  };
}

/** A column the row's target requires: the schema's CHECK guarantees it, so its absence is corruption, not a case. */
function required(row: EntryRow, value: string | null, what: string): string {
  if (value === null) throw new Error(`entry ${row.id} is on ${what}`);
  return value;
}

/**
 * The id of a record, for a viewer (D44): the viewer's own entry names it whatever they may read, anyone else's
 * only while they may read the record. `unavailable` is not "may read" (its owner did not say), so it is withheld
 * like `hidden`: failing closed, and a source that comes back changes the answer on the next read.
 */
function idFor(id: string, visibility: Visibility, own: boolean): string | null {
  return own || visibility === "visible" ? id : null;
}

/** What the entry is on, and the label of its project or deal (the target of an activity pointer), if it has one. */
function onOf(row: EntryRow, labels: Labels, own: boolean): { on: EntryOn; pointable: EntityLabel | null } {
  switch (row.target) {
    case "project": {
      const id = required(row, row.projectId, "a project and has no project id");
      const label = labels.project(id);
      return { on: { type: "project", id: idFor(id, label.visibility, own), ...label }, pointable: label };
    }
    case "deal": {
      const id = required(row, row.dealId, "a deal and has no deal id");
      const label = labels.deal(id);
      return { on: { type: "deal", id: idFor(id, label.visibility, own), ...label }, pointable: label };
    }
    case "meeting": {
      const id = required(row, row.meetingId, "a meeting and has no meeting id");
      const label = labels.meeting(id);
      return { on: { type: "meeting", id: idFor(id, label.visibility, own), ...label, deal: labels.meetingDeal(id) }, pointable: null };
    }
    case "none": {
      if (row.category === null) throw new Error(`entry ${row.id} is on no entity and has no category`);
      const { id, name, retiredAt } = row.category;
      return { on: { type: "none", category: { id, name, retired: retiredAt !== null } }, pointable: null };
    }
  }
}

/**
 * One entry as `labels` lets this viewer read it. Pure: every label was read beforehand. `viewerId` is the verified
 * `sub` of the caller whose `Authorization` read them: an entry is the viewer's own when they wrote it, and only
 * then does it keep the id of a record they may not read (D44). Required, never defaulted: a call site that
 * forgets it does not compile, instead of quietly handing out ids.
 */
export function toView(row: EntryRow, labels: Labels, viewerId: string): TimeEntryView {
  const own = row.userId === viewerId;
  const { on, pointable } = onOf(row, labels, own);
  const activity = row.activityId !== null && pointable !== null ? labels.activity(row.activityId, pointable) : null;
  return {
    id: row.id,
    day: row.day.toISOString().slice(0, 10),
    minutes: row.minutes,
    // A blank note is no note, and a view never carries one: the write path stores `null`, so this only guards a row that holds one anyway.
    note: row.note === null || row.note.trim() === "" ? null : row.note,
    person: labels.person(row.userId),
    on,
    workType: row.workType ? { id: row.workType.id, name: row.workType.name, retired: row.workType.retiredAt !== null } : null,
    // Only an entry on a project or a deal can point at an activity (the CHECK `time_entry_activity_target`).
    // Its id follows the activity's own visibility, which already follows the target's (labels/resolve.ts).
    activity: activity === null ? null : { id: idFor(activity.id, activity.visibility, own), subject: activity.subject, visibility: activity.visibility },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Entries as `authorization`'s owner reads them: every name from the service that holds it, as the viewer
 * where that service can answer as one, each source failing soft and named in `unavailable` when it did not
 * answer (AC-4.7). `rows` come from `db.timeEntry.findMany({ include: ENTRY_INCLUDE })`; the order is kept.
 * `viewerId` is the caller's verified `sub` (the route's `c.get("userId")`), never read from `authorization` here:
 * the id rule (D44) keys on it.
 */
export async function viewEntries(authorization: string, rows: readonly EntryRow[], viewerId: string): Promise<EntryViews> {
  const labels = await resolveLabels(authorization, needsOf(rows));
  return { items: rows.map((row) => toView(row, labels, viewerId)), unavailable: labels.unavailable };
}
