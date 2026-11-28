/**
 * The summary of a record's hours (specs/20261112-project-hours T9; plan § Who may see what, § API contracts; ADR
 * 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states).
 *
 * The hours on a record are what EVERYONE recorded on it: the entries on the project or deal itself plus those on the meetings linked to it NOW
 * (src/entries/filters.ts `projectCondition` / `dealCondition`: meetings-api, hours-api's own credential, refused 503 while it cannot say, so a figure
 * is never shown low). Who may see them is decided here, in this order, each step asked of the one that owns the fact and never remembered:
 *
 *   1. May the caller read the record at all? projects-api / crm-api, AS THE CALLER (the forwarded JWT). `reader: false` and a record the owner does
 *      not hold are ONE answer, 404; an owner that does not answer is 503 `host_unavailable`, never a guess.
 *   2. Which meetings are linked to it now? meetings-api. Not answering is 503 as well.
 *   3. May the caller see the hours PER PERSON? Only the record's manager (`projectManagerId === sub`) or owner (`ownerUserId === sub`), a fact the
 *      owner states in the answer of step 1 and which costs no further call; for anyone else, only a holder of `time-entry:read-all`, asked live of
 *      `auth` (src/oversight/oversight.ts: refusals remembered 30 s, a grant never). `auth` not answering withholds the figure (`byPerson: null`,
 *      `"authz"` in `unavailable`) and never guesses; the totals still show.
 *
 * The rest is one snapshot of this service's own table (reads only, in a transaction at REPEATABLE READ, so the window's figure, the work types' and
 * the people's are all one moment) and the names of the people, read as the viewer. Nothing in the answer is an entry, a note, a meeting's id or
 * title, an activity's subject or an amount: only groups of minutes.
 */

import { dealCondition, projectCondition } from "../entries/filters";
import { dayDate } from "../entries/rules";
import { resolveDeals } from "../clients/crm";
import { resolveProjects } from "../clients/projects";
import { resolveLabels } from "../labels/resolve";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { ProblemError } from "../lib/problem";
import { holdsReadAll, OversightUnavailableError, type Session } from "../oversight/oversight";
import { hostUnavailable } from "../targets/errors";
import type { PersonStatus } from "../labels/types";
import { byLabel, byMinutesThenLabel } from "../totals/groups";
import type { SummaryRecord, SummaryRequest } from "./query";

/** What the summary says of itself to a client that may have to say "unavailable": the sources it asked and that did not answer. */
export type SummaryUnavailable = ("identities" | "authz")[];

/** A work type's hours (the totals' `TotalsGroup`, `keyed` with `retired`, or `none`). The name is as typed and is shown even when the type is retired. */
export type WorkTypeGroup =
  | { readonly kind: "keyed"; readonly key: string; readonly label: string; readonly minutes: number; readonly retired: boolean }
  | { readonly kind: "none"; readonly minutes: number };

/** A person's hours (the totals' `TotalsGroup`, `keyed` with `status`). `label` is the name `auth` gives them now, `null` for one it cannot name. */
export interface PersonGroup {
  readonly kind: "keyed";
  readonly key: string;
  readonly label: string | null;
  readonly minutes: number;
  readonly status: PersonStatus;
}

export interface SummaryAnswer {
  readonly on: SummaryRecord;
  /** All time: the entries on the record and on the meetings linked to it now. */
  readonly totalMinutes: number;
  /** The same, the days of the window only; `null` without a window. */
  readonly windowMinutes: number | null;
  /** By work type, the most hours first; the hours without one are one `none` group, last. Adds up to `totalMinutes`. */
  readonly byWorkType: WorkTypeGroup[];
  /** By person; `null` when the caller may not see it. Adds up to `totalMinutes` when present. */
  readonly byPerson: PersonGroup[] | null;
  readonly unavailable: SummaryUnavailable;
}

// ─── The record, as the caller reads it ──────────────────────────────────────

/** 404 `not_found`: no record the caller may read has this id. ONE body for a record that does not exist and one the caller may not read. */
const recordNotFound = (): ProblemError => new ProblemError({ status: 404, code: "not_found", detail: "There is no project or deal with this id that you can read" });

/** What the owner said of a record the caller reads: who holds the role that sees its people. `null`: nobody does (a project awaiting its manager). */
interface ReadRecord {
  readonly roleHolder: string | null;
}

/**
 * Asks the record's owner, as the caller, whether the caller reads it, and who holds the role that sees its people. 404 for `reader: false` and for a
 * record the owner does not hold, one body for both; 503 when the owner could not say. A role the owner did not state (an owner that predates the
 * fact, plan § Deploy order) is nobody's: never a grant.
 */
async function readRecord(record: SummaryRecord, authorization: string): Promise<ReadRecord> {
  const unavailable = () => hostUnavailable(`The tool that owns this ${record.type} could not be asked whether you may read it, so its hours are not shown`);
  if (record.type === "project") {
    const outcome = await resolveProjects(authorization, [record.id]);
    if (outcome.state === "unavailable") throw unavailable();
    if (outcome.state === "not_reader") throw recordNotFound();
    const item = outcome.items.get(record.id);
    if (item === undefined || item.state === "missing") throw recordNotFound();
    return { roleHolder: item.projectManagerId ?? null };
  }
  const outcome = await resolveDeals(authorization, [record.id]);
  if (outcome.state === "unavailable") throw unavailable();
  if (outcome.state === "not_reader") throw recordNotFound();
  const item = outcome.items.get(record.id);
  if (item === undefined || item.state === "missing") throw recordNotFound();
  return { roleHolder: item.ownerUserId ?? null };
}

// ─── Who sees the people ─────────────────────────────────────────────────────

type PeopleRight = "granted" | "refused" | "unknown";

/**
 * May the caller see the hours per person? The record's own role first (`roleHolder` is the caller: no call at all), then `time-entry:read-all` asked
 * live of `auth`. `unknown` is `auth` not answering: the figure is withheld, never shown on a guess (fail closed, AC-2.5).
 */
async function peopleRight(read: ReadRecord, session: Session): Promise<PeopleRight> {
  if (read.roleHolder !== null && read.roleHolder === session.sub) return "granted";
  try {
    return (await holdsReadAll(session)) ? "granted" : "refused";
  } catch (err) {
    if (err instanceof OversightUnavailableError) return "unknown";
    throw err;
  }
}

// ─── The figures ─────────────────────────────────────────────────────────────

interface Figures {
  readonly windowMinutes: number | null;
  /** One row per work type (or none) per person; per work type alone when the people are not wanted (`userId` is then `null`). */
  readonly rows: ReadonlyArray<{ readonly workTypeId: string | null; readonly userId: string | null; readonly minutes: number }>;
  readonly workTypes: ReadonlyMap<string, { readonly name: string; readonly retired: boolean }>;
}

/** The minutes of `where` per work type (and per person when `withPeople`), and inside `window`: one snapshot, so every figure is one moment. */
async function figuresOf(where: Prisma.TimeEntryWhereInput, window: SummaryRequest["window"], withPeople: boolean): Promise<Figures> {
  return db.$transaction(
    async (tx) => {
      const grouped = await tx.timeEntry.groupBy({ by: withPeople ? ["workTypeId", "userId"] : ["workTypeId"], where, _sum: { minutes: true } });
      const rows = grouped.map((row) => ({
        workTypeId: row.workTypeId,
        userId: "userId" in row ? (row.userId as string) : null,
        minutes: row._sum?.minutes ?? 0,
      }));
      const inWindow =
        window === null ? null : await tx.timeEntry.aggregate({ where: { AND: [where, { day: { gte: dayDate(window.from), lte: dayDate(window.to) } }] }, _sum: { minutes: true } });
      const ids = [...new Set(rows.flatMap((row) => (row.workTypeId === null ? [] : [row.workTypeId])))];
      const found = await tx.workType.findMany({ where: { id: { in: ids } } });
      return {
        windowMinutes: inWindow === null ? null : (inWindow._sum.minutes ?? 0),
        rows,
        workTypes: new Map(found.map((workType) => [workType.id, { name: workType.name, retired: workType.retiredAt !== null }])),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

/** Per work type: its name as typed, whether it is retired (shown all the same), and the hours with none as one group. */
function byWorkType(figures: Figures): WorkTypeGroup[] {
  const minutesOf = new Map<string, number>();
  let without = 0;
  for (const row of figures.rows) {
    if (row.workTypeId === null) without += row.minutes;
    else minutesOf.set(row.workTypeId, (minutesOf.get(row.workTypeId) ?? 0) + row.minutes);
  }
  const keyed = [...minutesOf].map(([key, minutes]): Extract<WorkTypeGroup, { kind: "keyed" }> => {
    // The foreign key forbids a work type that is gone, so a missing one is corruption, not a case.
    const workType = figures.workTypes.get(key);
    if (workType === undefined) throw new Error(`entries are on work type ${key}, which does not exist`);
    return { kind: "keyed", key, label: workType.name, minutes, retired: workType.retired };
  });
  // The most hours first, then by name; what has no work type is one group of its own, last, only when it holds minutes.
  return [...keyed.sort(byMinutesThenLabel), ...(without > 0 ? [{ kind: "none" as const, minutes: without }] : [])];
}

/** Per person, named as `auth` names them NOW as the viewer: a person it cannot name stays counted, `label: null`, `status: "unknown"`. */
async function byPerson(figures: Figures, authorization: string): Promise<{ groups: PersonGroup[]; unavailable: SummaryUnavailable }> {
  const minutesOf = new Map<string, number>();
  for (const row of figures.rows) if (row.userId !== null) minutesOf.set(row.userId, (minutesOf.get(row.userId) ?? 0) + row.minutes);
  const labels = await resolveLabels(authorization, { userIds: minutesOf.keys() });
  const groups = [...minutesOf].map(([key, minutes]): PersonGroup => {
    const person = labels.person(key);
    return { kind: "keyed", key, label: person.name, minutes, status: person.status };
  });
  return { groups: groups.sort(byLabel), unavailable: labels.unavailable.includes("identities") ? ["identities"] : [] };
}

// ─── The answer ──────────────────────────────────────────────────────────────

/**
 * The summary of `request`'s record for the caller `session`. Throws 404 `not_found` (the record is missing or not the caller's to read) and 503
 * `host_unavailable` (its owner, or meetings-api, could not say), both before any hour is read.
 */
export async function summaryOf(request: SummaryRequest, session: Session): Promise<SummaryAnswer> {
  const { record, window } = request;
  const read = await readRecord(record, session.authorization);
  const { condition } = record.type === "project" ? await projectCondition(record.id) : await dealCondition(record.id);
  const right = await peopleRight(read, session);

  const figures = await figuresOf(condition, window, right === "granted");
  const workTypes = byWorkType(figures);
  const people = right === "granted" ? await byPerson(figures, session.authorization) : null;

  return {
    on: record,
    // The sum of what was grouped, never a second query that could see another moment (as src/totals/groups.ts `Tally`).
    totalMinutes: workTypes.reduce((sum, group) => sum + group.minutes, 0),
    windowMinutes: figures.windowMinutes,
    byWorkType: workTypes,
    byPerson: people === null ? null : people.groups,
    unavailable: right === "unknown" ? ["authz"] : (people?.unavailable ?? []),
  };
}
