/**
 * The totals of a set of entries (specs/029 T18; plan § Totals, § Views, ADR-0089 amendment A1; AC-1.4, AC-2.6, AC-4.4,
 * AC-4.5, AC-4.7, AC-4.8, AC-4.10).
 *
 * `totalsOf` takes the database's question (`where`, built by src/entries/filters.ts `entryWhere` from the request),
 * groups the matching entries in SQL, then names the groups through the labels layer (src/labels/) asking ONLY the
 * sources the grouping needs. Whose entries `where` selects is not decided here: the route builds it (the caller's own
 * until T19), so the same aggregation serves everyone's.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { resolveLabels } from "../labels/resolve";
import type { EntityLabel } from "../labels/types";
import { Tally, byKeyDesc, byLabel, byMinutesThenLabel, type Grouping, type TotalsAnswer } from "./groups";

const dayText = (day: Date): string => day.toISOString().slice(0, 10);

const sumOf = (row: { readonly _sum: { readonly minutes: number | null } }): number => row._sum.minutes ?? 0;

/** One group per day with entries, or per calendar month: both read nothing but this service's own table. */
async function byDay(where: Prisma.TimeEntryWhereInput, key: (day: string) => string): Promise<TotalsAnswer> {
  const rows = await db.timeEntry.groupBy({ by: ["day"], where, _sum: { minutes: true } });
  const tally = new Tally();
  for (const row of rows) tally.addKeyed({ key: key(dayText(row.day)), label: null }, sumOf(row));
  return { totalMinutes: tally.totalMinutes, groups: tally.groups(byKeyDesc, []), unavailable: [] };
}

/**
 * One group per person with entries, named as `auth` names them NOW (AC-4.8; nothing about a name is stored). A person
 * `auth` cannot name stays counted with `label: null` and `status: "unknown"`, and `identities` is named (AC-4.7).
 */
async function byPerson(where: Prisma.TimeEntryWhereInput, authorization: string): Promise<TotalsAnswer> {
  const rows = await db.timeEntry.groupBy({ by: ["userId"], where, _sum: { minutes: true } });
  const labels = await resolveLabels(authorization, { userIds: rows.map((row) => row.userId) });
  const tally = new Tally();
  for (const row of rows) {
    const person = labels.person(row.userId);
    tally.addKeyed({ key: row.userId, label: person.name, status: person.status }, sumOf(row));
  }
  return { totalMinutes: tally.totalMinutes, groups: tally.groups(byLabel, []), unavailable: labels.unavailable };
}

/**
 * Counts `minutes` under the entity `id` when the viewer may read it (its own group, named as they read it), else in
 * the ONE merged group that says why they cannot: `hidden` (may not read it) or `unavailable` (its owner did not
 * answer). A group per unreadable id would be a column of identical rows (plan § Totals, "What the viewer cannot name").
 */
function placeEntity(tally: Tally, label: EntityLabel, id: string, minutes: number): void {
  if (label.visibility === "visible") tally.addKeyed({ key: id, label: label.label }, minutes);
  else tally.addBucket(label.visibility, minutes);
}

/**
 * One group per project the viewer can read, read from projects-api as the viewer; every project they cannot read is
 * ONE `hidden` group, every one whose owner did not answer ONE `unavailable` group (AC-4.7, AC-4.10); the entries
 * that are not on a project (a deal, a meeting, no entity) are `none`.
 */
async function byProject(where: Prisma.TimeEntryWhereInput, authorization: string): Promise<TotalsAnswer> {
  const rows = await db.timeEntry.groupBy({ by: ["projectId"], where, _sum: { minutes: true } });
  const labels = await resolveLabels(authorization, { projectIds: rows.flatMap((row) => (row.projectId === null ? [] : [row.projectId])) });
  const tally = new Tally();
  for (const row of rows) {
    if (row.projectId === null) tally.addBucket("none", sumOf(row));
    else placeEntity(tally, labels.project(row.projectId), row.projectId, sumOf(row));
  }
  return { totalMinutes: tally.totalMinutes, groups: tally.groups(byMinutesThenLabel, ["hidden", "unavailable", "none"]), unavailable: labels.unavailable };
}

/**
 * One group per deal the viewer can read: the entries on the deal PLUS the entries on the meetings linked to it NOW
 * (AC-2.6), so a relinked meeting's hours move with it (nothing about the deal is stored on an entry). A deal and a
 * meeting's deal pass through the same read of the viewer's access (AC-4.10, ADR-0089 A1): the link is read with
 * hours-api's own credential, so it is named only to a viewer who may read the deal it names — never by id or by name
 * otherwise — and what they may not read is ONE `hidden` group, what crm-api did not answer ONE `unavailable` group.
 *
 * A meeting whose current deal could not be read (`meeting-deals` did not answer) is `deal-unknown`, and stays
 * counted: a total never loses entries (AC-4.7). `none` is what has no deal: a project or no-entity entry, a meeting
 * linked to no deal or to a host that is not a CRM deal, or one meetings-api no longer holds.
 */
async function byDeal(where: Prisma.TimeEntryWhereInput, authorization: string): Promise<TotalsAnswer> {
  const rows = await db.timeEntry.groupBy({ by: ["dealId", "meetingId"], where, _sum: { minutes: true } });
  // The title of a meeting is not needed, only its deal: `meetingDealIds`, never `meetingIds`.
  const labels = await resolveLabels(authorization, {
    dealIds: rows.flatMap((row) => (row.dealId === null ? [] : [row.dealId])),
    meetingDealIds: rows.flatMap((row) => (row.meetingId === null ? [] : [row.meetingId])),
  });
  const tally = new Tally();
  for (const row of rows) {
    const minutes = sumOf(row);
    if (row.dealId !== null) {
      placeEntity(tally, labels.deal(row.dealId), row.dealId, minutes);
    } else if (row.meetingId !== null) {
      const deal = labels.meetingDeal(row.meetingId);
      switch (deal.state) {
        case "linked":
          if (deal.visibility === "visible") tally.addKeyed({ key: deal.id, label: deal.label }, minutes);
          else tally.addBucket(deal.visibility, minutes);
          break;
        case "unknown":
          tally.addBucket("deal-unknown", minutes);
          break;
        case "none":
          tally.addBucket("none", minutes);
          break;
      }
    } else {
      tally.addBucket("none", minutes);
    }
  }
  return {
    totalMinutes: tally.totalMinutes,
    groups: tally.groups(byMinutesThenLabel, ["hidden", "unavailable", "deal-unknown", "none"]),
    unavailable: labels.unavailable,
  };
}

/**
 * One group per category used (the entries on no entity); every entry on a project, a deal or a meeting is `none`.
 * The name is the list's own, as typed (AC-3.8), and it is shown even when the category is retired (AC-3.4).
 * Categories are this service's table, so no other service is asked.
 */
async function byCategory(where: Prisma.TimeEntryWhereInput): Promise<TotalsAnswer> {
  const rows = await db.timeEntry.groupBy({ by: ["categoryId"], where, _sum: { minutes: true } });
  const ids = rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId]));
  const categories = new Map((await db.timeCategory.findMany({ where: { id: { in: ids } } })).map((category) => [category.id, category]));
  const tally = new Tally();
  for (const row of rows) {
    if (row.categoryId === null) {
      tally.addBucket("none", sumOf(row));
      continue;
    }
    // The foreign key forbids a category that is gone, so a missing one is corruption, not a case.
    const category = categories.get(row.categoryId);
    if (category === undefined) throw new Error(`entries are on category ${row.categoryId}, which does not exist`);
    tally.addKeyed({ key: category.id, label: category.name, retired: category.retiredAt !== null }, sumOf(row));
  }
  return { totalMinutes: tally.totalMinutes, groups: tally.groups(byMinutesThenLabel, ["none"]), unavailable: [] };
}

/**
 * The entries `where` selects, grouped by `groupBy`.
 * `authorization` is the viewer's own `Authorization` header value: every name is read as the viewer (plan § Views).
 */
export async function totalsOf(groupBy: Grouping, where: Prisma.TimeEntryWhereInput, authorization: string): Promise<TotalsAnswer> {
  switch (groupBy) {
    case "person":
      return byPerson(where, authorization);
    case "project":
      return byProject(where, authorization);
    case "deal":
      return byDeal(where, authorization);
    case "day":
      return byDay(where, (day) => day);
    case "month":
      return byDay(where, (day) => day.slice(0, 7));
    case "category":
      return byCategory(where);
  }
}
