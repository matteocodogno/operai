/**
 * Recording, changing and deleting an entry (specs/029 T14; plan § Entries, § Errors; AC-1.1 – AC-1.3,
 * AC-1.5 – AC-1.8, AC-2.1, AC-3.1, AC-3.4 – AC-3.6).
 *
 * Any session may record, change and delete ITS OWN entries — no tool grant, no `auth` call, no owner call for
 * hours on no entity. What a request says is validated first (400, src/entries/schemas.ts and src/lib/errors.ts),
 * then the entry is looked up for the caller (404 for "no such entry" and "not yours" alike, AC-1.6), then the
 * rules hours-api decides alone (422, src/entries/rules.ts), and last what only an owner can answer — whether
 * the caller may book on a project, a deal or a meeting, and whether an activity belongs to it (`askOwners`,
 * T15 and T16). A write is checked against the entry as it WILL be stored: the members sent, else the stored ones.
 *
 * `DELETE` and a `PATCH` that keeps the entry's target ask no owner at all (AC-2.4, AC-2.12, D46): an author who
 * left a project can still correct or delete what they recorded.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { db } from "../lib/db";
import { invalidRequestHook } from "../lib/errors";
import { notFound, type ProblemError } from "../lib/problem";
import { ProblemSchema } from "../lists/errorDocs";
import { IdSchema } from "../lists/idRule";
import { ownerOnly } from "../oversight/errors";
import { isHolderOfSomeoneElsesEntry, type Session } from "../oversight/oversight";
import { assertActivityOf } from "../targets/activity";
import { assertBookable, type Caller } from "../targets/bookability";
import {
  activityNotAllowed,
  assertMinutes,
  assertNoteLength,
  assertNoteRequired,
  assertNotFuture,
  chosenCategory,
  storedNote,
  workTypeListOf,
  workTypeNotAllowed,
  workTypeNotFound,
  workTypeRetired,
  type CategoryFacts,
} from "./rules";
import { CreateEntrySchema, UpdateEntrySchema, type CreateEntry, type On, type UpdateEntry } from "./schemas";
import { today } from "./today";
import { ENTRY_INCLUDE, TimeEntryViewSchema, viewEntries, type EntryRow } from "./view";

const problemDoc = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

/** The answers of the write routes besides their success (plan § Errors) that hours-api decides alone. */
const writeErrors = {
  400: problemDoc(
    "`invalid_request`: an unknown key (`userId`, `start`, `end`…), a member of the wrong shape, an id outside the id rule (`field` names it), " +
      "a `day` that is not a real calendar day from 2000-01-01 (`field: \"day\"`), a NUL or a lone surrogate in `note` (`field: \"note\"`)",
  ),
  401: problemDoc("No valid session"),
  404: problemDoc(
    "`not_found`: no entry of yours has this id — one body for an entry that is someone else's and for one that does not exist " +
      "(a holder of `time-entry:read-all` is told `owner_only` for someone else's, a 403)",
  ),
  422: problemDoc(
    "A rule broken, `field` names the member: `invalid_minutes`, `future_day`, `note_too_long`, `note_required`, `category_not_found`, " +
      "`category_retired`, `work_type_not_allowed`, `work_type_not_found`, `work_type_retired`, `activity_not_allowed`",
  ),
} as const;

const notBookable =
  "`not_on_project`: the project is readable and the caller is neither its project manager nor on its team; " +
  "`not_involved_in_deal`: the deal is readable and the caller is neither its owner, its technical contact, nor the assignee or a participant of one of its activities";

/**
 * A write to an entry that is not the caller's: 404, or — for a holder of `time-entry:read-all`, who can read it
 * anyway — 403 `owner_only`. Reading everyone's hours never becomes a way to change them (AC-1.6).
 */
const notYours =
  "`owner_only`: the entry is someone else's and the caller holds `time-entry:read-all`; the privilege is for looking, so nothing changes. " +
  "Anyone else, and a holder when `auth` cannot say, is told `not_found`";

/**
 * What the owners add to a `POST` and to a `PATCH` that moves the entry or sends a new `activityId` (plan § Errors;
 * T15, T16): whether the caller may book there, and whether the activity belongs to it. `404` replaces the entry's
 * own for these two routes: it also covers the target.
 */
const ownerErrors = {
  403: problemDoc(notBookable),
  404: problemDoc(
    "`not_found`: on a `PATCH`, no entry of yours has this id; on either, the project, deal or meeting does not exist, the caller may not read it, " +
      "or is not its creator or a participant (a meeting) — one body for all of them",
  ),
  503: problemDoc(
    "`host_unavailable`: the tool that owns the project, deal, meeting or activity could not be asked, or answered what is no answer, so nothing was saved",
  ),
} as const;

const createEntryRoute = createRoute({
  method: "post",
  path: "/time-entries",
  tags: ["Entries"],
  summary: "Record hours (any session)",
  description:
    "Records the caller's hours on a day: a duration (whole half-hours, never a start or end time) on a project, a deal, a meeting or no entity. " +
    "Always the caller's own: the author is the session's subject, never client input.",
  request: { body: { content: { "application/json": { schema: CreateEntrySchema } }, required: true } },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: TimeEntryViewSchema } } },
    ...writeErrors,
    ...ownerErrors,
  },
});

const IdParams = z.object({ id: IdSchema.openapi({ param: { name: "id", in: "path" } }) });

const updateEntryRoute = createRoute({
  method: "patch",
  path: "/time-entries/{id}",
  tags: ["Entries"],
  summary: "Change one of your own entries, of any age: any subset of the members of a POST (any session)",
  description:
    "At least one member; one that is not sent keeps what is stored, and `on` is replaced whole. Whether the caller may book on the target is " +
    "asked only when `on` names a target other than the stored one. An `activityId` is asked of activities-api only when it is new or carried " +
    "to another target (`null` and an unchanged one never are). `note_required` is checked when a note is sent or the entry is moved.",
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateEntrySchema } }, required: true },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: TimeEntryViewSchema } } },
    ...writeErrors,
    ...ownerErrors,
    403: problemDoc(`${notBookable}; ${notYours}`),
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/time-entries/{id}",
  tags: ["Entries"],
  summary: "Delete one of your own entries, of any age (any session)",
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    400: writeErrors[400],
    401: writeErrors[401],
    403: problemDoc(notYours),
    404: writeErrors[404],
  },
});

export const entriesRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: invalidRequestHook });

/** One answer for "no such entry" and "not yours": nothing says which (AC-1.6). */
const entryNotFound = () => notFound("No time entry of yours has this id");

/**
 * What a write to an entry that is not the caller's is answered, once the lookup of THEIR entry came back empty
 * (AC-1.6): 403 `owner_only` for a holder of `time-entry:read-all` looking at a real entry of someone else's — they
 * can read it, so the refusal tells them nothing new — and the one 404 for everyone else, and for a holder when
 * `auth` cannot say (src/oversight/oversight.ts). It never says 404 where a holder could be told more, and never
 * says "owner only" to anyone who could not read the entry.
 */
async function entryNotTheCallers(session: Session, id: string): Promise<ProblemError> {
  return (await isHolderOfSomeoneElsesEntry(session, id)) ? ownerOnly() : entryNotFound();
}

// ─── What an entry is on ─────────────────────────────────────────────────────

/** A column the row's target requires: the schema's CHECK guarantees it, so its absence is corruption, not a case. */
function required(row: EntryRow, value: string | null, what: string): string {
  if (value === null) throw new Error(`entry ${row.id} is on ${what}`);
  return value;
}

/** What a stored entry is on, in the shape of the `on` member of a request. */
function targetOf(row: EntryRow): On {
  switch (row.target) {
    case "none":
      return { type: "none", categoryId: required(row, row.categoryId, "no entity and has no category") };
    case "project":
      return { type: "project", id: required(row, row.projectId, "a project and has no project id") };
    case "deal":
      return { type: "deal", id: required(row, row.dealId, "a deal and has no deal id") };
    case "meeting":
      return { type: "meeting", id: required(row, row.meetingId, "a meeting and has no meeting id") };
  }
}

/** Two targets are the same thing: the same type and the same project, deal or meeting — or the same category. */
function sameTarget(a: On, b: On): boolean {
  if (a.type === "none") return b.type === "none" && b.categoryId === a.categoryId;
  return b.type !== "none" && b.type === a.type && b.id === a.id;
}

/** The columns that say what an entry is on: the target's own id and nothing else (the CHECK `time_entry_target_shape`). */
const targetColumns = (on: On) => ({
  target: on.type,
  projectId: on.type === "project" ? on.id : null,
  dealId: on.type === "deal" ? on.id : null,
  meetingId: on.type === "meeting" ? on.id : null,
  categoryId: on.type === "none" ? on.categoryId : null,
});

// ─── The owners ──────────────────────────────────────────────────────────────

/**
 * What a write still has to ask the OWNERS of the things an entry is on, once every local rule held:
 * bookability (AC-2.2, AC-2.3, AC-2.5) and the activity pointer (AC-2.7). Entries on no entity need neither.
 *
 * `askOwners` is the one place they are asked: bookability on a project, a deal and a meeting is
 * src/targets/bookability.ts (T15, T16), the activity pointer src/targets/activity.ts (T16). Each throws the
 * problem that says why on every outcome but "yes", so nothing here can forget to read an answer.
 */
interface OwnerChecks {
  /** Set when the entry is created on, or moved to, a project, a deal or a meeting. */
  readonly bookable: { readonly type: "project" | "deal" | "meeting"; readonly id: string } | null;
  /**
   * Set when the entry will point at an activity nobody checked for this target: a new pointer, or one carried
   * over to another target. `target` is the project or the deal the entry will be on. `null` is never checked.
   */
  readonly activity: { readonly id: string; readonly target: { readonly type: "project" | "deal"; readonly id: string } } | null;
}

async function askOwners(caller: Caller, checks: OwnerChecks): Promise<void> {
  // Bookability first, as the plan's sequences run it: an entry that may not be booked there is never asked
  // about the activity it would point at (a 403 or a 404 must not be hidden behind another answer).
  if (checks.bookable !== null) await assertBookable(caller, checks.bookable);
  if (checks.activity !== null) await assertActivityOf(caller, checks.activity);
}

// ─── The local rules ─────────────────────────────────────────────────────────

/**
 * A write as the rules see it. `POST` is a write with nothing stored whose target is "moved" to the first one
 * (so every rule of a target runs); `PATCH` is a write against a stored entry that is `moved` only when its
 * `on` names another target — an `on` equal to the stored one counts as unchanged, as for bookability (D46).
 */
interface Write {
  /** The entry as it is now; `null` on `POST`. */
  readonly stored: EntryRow | null;
  readonly body: UpdateEntry;
  /** What the entry will be on. */
  readonly target: On;
  /** Created, or moved to another target. */
  readonly moved: boolean;
}

/**
 * The rules about the members a request SENDS — duration, day, note length — the same on `POST` and `PATCH`
 * (a member that is not sent keeps what is stored, which passed them when it was written).
 */
function assertSentMembers(body: UpdateEntry): void {
  if (body.minutes !== undefined) assertMinutes(body.minutes);
  if (body.day !== undefined) assertNotFuture(body.day, today());
  if (typeof body.note === "string") assertNoteLength(body.note);
}

/**
 * Every local rule, in the order a screen meets them: duration, day, note length, then what the entry may
 * carry for what it is on, its category, and the note its category asks for. Returns what still has to be
 * asked of an owner. Nothing is written by this; a refusal is a thrown 422 and the row stays as it was.
 */
async function validateWrite({ stored, body, target, moved }: Write): Promise<OwnerChecks> {
  assertSentMembers(body);

  // The entry as it will be stored: a member that is sent, else the one stored. So an entry carried to another
  // target keeps its work type and activity, and they must fit there — they are never dropped silently (a client
  // that changes the kind of thing an entry is on sends `workTypeId: null` / `activityId: null`, as hours-ui does).
  const workTypeId = body.workTypeId !== undefined ? body.workTypeId : (stored?.workTypeId ?? null);
  const activityId = body.activityId !== undefined ? body.activityId : (stored?.activityId ?? null);

  if (workTypeId !== null) {
    const list = workTypeListOf(target.type);
    if (list === null) throw workTypeNotAllowed();
    // The work type the entry already has is not CHOSEN again: retired since, it stays (AC-3.4); sending it back is no change.
    const unchanged = stored !== null && stored.workTypeId === workTypeId;
    const workType = unchanged ? stored.workType : await db.workType.findUnique({ where: { id: workTypeId } });
    if (workType === null) throw workTypeNotFound();
    if (workType.list !== list) throw workTypeNotAllowed();
    if (!unchanged && workType.retiredAt !== null) throw workTypeRetired();
  }

  if (activityId !== null && (target.type === "none" || target.type === "meeting")) throw activityNotAllowed();

  let category: CategoryFacts | null = null;
  if (target.type === "none") {
    // A category CHOSEN now must be offered; the one an entry already has stays, retired or not (AC-3.4).
    if (stored === null || moved) {
      category = chosenCategory(await db.timeCategory.findUnique({ where: { id: target.categoryId } }));
    } else {
      // The foreign key and the CHECK guarantee it: an entry on no entity has a category.
      if (stored.category === null) throw new Error(`entry ${stored.id} is on no entity and has no category`);
      category = stored.category;
    }
  }

  // D50 (plan § Entries, "A blank note"): `note_required` is asked when the entry is recorded, when a note is
  // sent, or when the entry is moved — against the entry as it will be stored. A PATCH that touches neither
  // (a new duration, a new day) is not refused for a note an older entry never had.
  if (stored === null || moved || body.note !== undefined) {
    assertNoteRequired(category, body.note !== undefined ? storedNote(body.note) : storedNote(stored?.note));
  }

  return {
    bookable: moved && target.type !== "none" ? { type: target.type, id: target.id } : null,
    // A pointer is asked of activities-api only when it is new here: sent and different, or carried to another target (D47: a stored one is never re-asked).
    activity:
      activityId !== null && (target.type === "project" || target.type === "deal") && (stored === null || moved || activityId !== stored.activityId)
        ? { id: activityId, target: { type: target.type, id: target.id } }
        : null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

entriesRouter.openapi(createEntryRoute, async (c) => {
  const body: CreateEntry = c.req.valid("json");
  const authorization = c.req.header("Authorization") ?? "";
  const userId = c.get("userId");
  const owners = await validateWrite({ stored: null, body, target: body.on, moved: true });
  await askOwners({ userId, authorization }, owners);
  const row = await db.timeEntry.create({
    data: {
      userId,
      day: new Date(`${body.day}T00:00:00Z`),
      minutes: body.minutes,
      ...targetColumns(body.on),
      workTypeId: body.workTypeId ?? null,
      activityId: body.activityId ?? null,
      note: storedNote(body.note),
    },
    include: ENTRY_INCLUDE,
  });
  const { items } = await viewEntries(authorization, [row], userId);
  return c.json(items[0]!, 201);
});

entriesRouter.openapi(updateEntryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const authorization = c.req.header("Authorization") ?? "";

  // The caller's own entry, or not: for someone else's the answer is 404, "no such entry", that tells a stranger
  // nothing (AC-1.6) — and 403 `owner_only` for a holder of `time-entry:read-all`, who can read it anyway. Looked up
  // BEFORE any rule, so that a rule's answer (422) can never reveal that an entry exists.
  const stored = await db.timeEntry.findFirst({ where: { id, userId }, include: ENTRY_INCLUDE });
  if (stored === null) throw await entryNotTheCallers({ sub: userId, permEpoch: c.get("permEpoch"), authorization }, id);

  const movedTo = body.on !== undefined && !sameTarget(targetOf(stored), body.on) ? body.on : null;
  const owners = await validateWrite({ stored, body, target: movedTo ?? targetOf(stored), moved: movedTo !== null });
  await askOwners({ userId, authorization }, owners);

  // Last write wins for one person in two tabs (no If-Match: an entry has one writer, ADR-0088). The row is
  // addressed by id AND owner, so the statement itself can never touch another person's entry.
  const row = await db.timeEntry
    .update({
      where: { id, userId },
      data: {
        ...(body.day !== undefined ? { day: new Date(`${body.day}T00:00:00Z`) } : {}),
        ...(body.minutes !== undefined ? { minutes: body.minutes } : {}),
        ...(movedTo !== null ? targetColumns(movedTo) : {}),
        ...(body.workTypeId !== undefined ? { workTypeId: body.workTypeId } : {}),
        ...(body.activityId !== undefined ? { activityId: body.activityId } : {}),
        ...(body.note !== undefined ? { note: storedNote(body.note) } : {}),
      },
      include: ENTRY_INCLUDE,
    })
    .catch((error: unknown) => {
      // Deleted (in another tab) between the lookup and this statement: it is simply no longer there.
      throw (error as { code?: unknown } | null)?.code === "P2025" ? entryNotFound() : error;
    });
  const { items } = await viewEntries(authorization, [row], userId);
  return c.json(items[0]!, 200);
});

entriesRouter.openapi(deleteEntryRoute, async (c) => {
  const { id } = c.req.valid("param");
  // Scoped to the caller in the statement itself, so no other person's entry can be deleted by a race or a
  // forgotten check; deleting needs no bookability (AC-2.4): an author who left a project can still remove it.
  const userId = c.get("userId");
  const { count } = await db.timeEntry.deleteMany({ where: { id, userId } });
  if (count === 0) {
    throw await entryNotTheCallers({ sub: userId, permEpoch: c.get("permEpoch"), authorization: c.req.header("Authorization") ?? "" }, id);
  }
  return c.body(null, 204);
});
