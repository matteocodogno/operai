/**
 * Activities and tasks (specs/20261110-activities US-1, US-3, US-5, US-6, US-8; plan § API
 * contracts). The CRM's rules of specs/20261101-crm US-4 carried over unchanged, plus the project
 * module's: every route here is the same code for both hosts, and what differs (who edits, who
 * completes, which types exist, who may be assigned) is the host registry's DATA and the
 * host's ANSWER about this entity for this caller (ADR 20261110-activities-service-access-delegated-to-host), never a branch on the app.
 *
 * No permission is held here. Each route asks the host that owns the entity, as the caller
 * (`HostSession`): a host that cannot answer is 503 `host_unavailable` and nothing is
 * written (AC-8.2); a caller the host does not let read, and an entity it does not know, are
 * the same 404 as an activity that does not exist (AC-8.3). No If-Match: a single author (or
 * manager) edits, so there is nobody to race (plan D-7).
 *
 * `GET /activities?ids=` (specs/20261112-time-tracking T6) is the one list that names activities rather
 * than an entity: see `listByIds`.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { db } from "../lib/db";
import { assertContactNotErased } from "../lib/erasedContacts";
import { Prisma } from "../lib/generated/prisma/client";
import {
  DateOnlySchema,
  IdParams,
  NUL_MESSAGE,
  idText,
  noNul,
  commonErrors,
  fromDateOnly,
  optionalText,
  pageOf,
  pageQuery,
  requiredText,
  skipTake,
} from "../lib/http";
import { requireAppUsers } from "../lib/identities";
import { announce } from "../lib/notify";
import type { NotifyActivity, NotifyTarget } from "../lib/notificationCopy";
import { ProblemError, unprocessable, validationHook } from "../lib/problem";
import type { ActivityHost, HostApp } from "../hosts/registry";
import { HostSession, type OpenEntity } from "./access";
import { authorizationOf, ifStillThere, loadFor, type Caller } from "./load";
import { MAX_BLOCKERS, announceUnblocked, assertBlockers, assertUnblocked, newBlockerRows, replaceBlockers } from "./blockers";
import { changeRefused, completeRefused, createRefused, hostReadOnly, mayChange, mayComplete, mayCreate } from "./rules";
import { staggered } from "./stagger";
import { DescriptionSchema, imageIdsOf, isEmptyDoc, textToDoc, type Doc } from "../files/description";
import { assertImagesOf, cleanUpAfterDescription, deleteActivitiesWithFiles } from "../files/files";
import { ACTIVITY_TYPES, ActivitySchema, DETAILS_VISIBILITIES, relatedIdsOf, toView, toViews, withRefs, type ActivityRow } from "./view";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const TypeSchema = z.enum(ACTIVITY_TYPES);
const UserIdSchema = idText();
const EntityIdSchema = idText();
/** The tasks this one waits on (US-6): the whole set, replacing any previous one. */
const BlockedByIdsSchema = z.array(idText()).max(MAX_BLOCKERS);
/** The wellD colleagues who took part (US-8, specs/20261110-activities US-5): the whole set, replacing any previous one. */
export const MAX_PARTICIPANTS = 10;
const ParticipantIdsSchema = z.array(UserIdSchema).max(MAX_PARTICIPANTS);
/** US-9: who sees the details; only on a host that lets the author restrict them (the CRM). */
const DetailsVisibilitySchema = z.enum(DETAILS_VISIBILITIES);

/** A request names its entity by the field that belongs to the host: the registry row it maps to. */
const TARGET_FIELDS = {
  companyId: { app: "crm", entityType: "company" },
  projectId: { app: "projects", entityType: "project" },
} as const satisfies Record<string, { app: HostApp; entityType: string }>;
type TargetField = keyof typeof TARGET_FIELDS;
const TARGET_NAMES = Object.keys(TARGET_FIELDS) as TargetField[];

const CreateActivitySchema = z
  .object({
    type: TypeSchema,
    subject: requiredText(200),
    body: optionalText(10_000),
    /** A task's rich description (ADR 20261113-task-description-files-in-activities-api-bucket); refused on any other type. */
    description: DescriptionSchema.nullable().optional(),
    companyId: EntityIdSchema.optional(),
    projectId: EntityIdSchema.optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    contactId: EntityIdSchema.nullable().optional(),
    dealId: EntityIdSchema.nullable().optional(),
    dueDate: DateOnlySchema.nullable().optional(),
    assigneeUserId: UserIdSchema.optional(),
    blockedByIds: BlockedByIdsSchema.optional(),
    participantIds: ParticipantIdsSchema.optional(),
    detailsVisibility: DetailsVisibilitySchema.optional(),
  })
  .strict();

const UpdateActivitySchema = z
  .object({
    subject: requiredText(200).optional(),
    body: optionalText(10_000),
    description: DescriptionSchema.nullable().optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    dueDate: DateOnlySchema.nullable().optional(),
    assigneeUserId: UserIdSchema.optional(),
    blockedByIds: BlockedByIdsSchema.optional(),
    participantIds: ParticipantIdsSchema.optional(),
    // 017 AC-4.2: the contact and the deal can be changed or cleared, always among the company's own.
    contactId: EntityIdSchema.nullable().optional(),
    dealId: EntityIdSchema.nullable().optional(),
    /** US-9: the author only. */
    detailsVisibility: DetailsVisibilitySchema.optional(),
  })
  .strict();

/** `?ids=`: how many activities one call may ask for, and the longest id (the bound every id input has). */
const MAX_IDS = 50;
const MAX_ID_LENGTH = 64;

const ListActivitiesQuery = z.object({
  companyId: z.string().max(64).refine(noNul, NUL_MESSAGE).optional(),
  contactId: z.string().max(64).refine(noNul, NUL_MESSAGE).optional(),
  dealId: z.string().max(64).refine(noNul, NUL_MESSAGE).optional(),
  projectId: z.string().max(64).refine(noNul, NUL_MESSAGE).optional(),
  // The fifth filter (specs/20261112-time-tracking T6): up to MAX_IDS activity ids, comma-separated. The raw string is
  // bounded first so a long one is a 422 before it is split; the elements are checked in `parseIds`.
  ids: z.string().max(MAX_IDS * (MAX_ID_LENGTH + 1)).optional(),
  // `type=task&open=true`: the open tasks a task may be blocked by (US-6 picker).
  type: TypeSchema.optional(),
  open: z.enum(["true"]).optional(),
  ...pageQuery(),
});

// ─── Checks ──────────────────────────────────────────────────────────────────


const taskFieldsOnNonTask = (field: string) =>
  unprocessable("Due date and assignee belong to tasks only", { field }, "task_fields_on_non_task");

/**
 * A task has one text, its description (ADR 20261113-task-description-files-in-activities-api-bucket). What a request gives for it: the description
 * itself, or (an older client, crm-api's estimate task) a plain `body`, kept as paragraphs.
 * `undefined` = not touched; `null` = cleared. An empty document is stored as null.
 */
function taskDescriptionOf(input: { body?: string | null | undefined; description?: Doc | null | undefined }): Doc | null | undefined {
  if (input.description !== undefined) return input.description === null || isEmptyDoc(input.description) ? null : input.description;
  if (input.body !== undefined) return input.body === null ? null : textToDoc(input.body);
  return undefined;
}

/** Prisma's way to write a JSON column's SQL NULL. */
const jsonOrNull = (doc: Doc | null) => (doc === null ? Prisma.DbNull : (doc as Prisma.InputJsonValue));


/** US-9: a host that does not let the author restrict the details (Projects) refuses the field outright. */
function assertDetailsVisibilityApplies(host: ActivityHost, value: string | undefined): void {
  if (value !== undefined && !host.restrictsDetails) {
    throw unprocessable("Details visibility is not available here", { field: "detailsVisibility" }, "field_not_allowed");
  }
}

/** A contact or deal only exists where the host has them: the CRM's company, never a project. */
function assertRefsApply(host: ActivityHost, contactId: string | null | undefined, dealId: string | null | undefined): void {
  const applies = (type: "contact" | "deal") => host.relatedTypes.includes(type);
  const refuse = (field: string) => unprocessable("This kind of record has no contacts or deals", { field }, "field_not_allowed");
  if (contactId != null && !applies("contact")) throw refuse("contactId");
  if (dealId != null && !applies("deal")) throw refuse("dealId");
}

/** 017 AC-4.1: the referenced contact and deal must be the host's, under the activity's own company. */
function assertRefs(
  session: HostSession,
  hostId: string,
  contactId: string | null | undefined,
  dealId: string | null | undefined,
): void {
  if (contactId && !session.relatedOf("contact", contactId, hostId)) {
    throw unprocessable("The contact does not belong to this company", { field: "contactId" }, "contact_not_in_company");
  }
  if (dealId && !session.relatedOf("deal", dealId, hostId)) {
    throw unprocessable("The deal does not belong to this company", { field: "dealId" }, "deal_not_in_company");
  }
}

/** US-8 / specs/20261110-activities AC-5.1: distinct ids, each an active user of the host's app (the caller needs no check). */
async function assertParticipants(c: Caller, host: ActivityHost, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  await requireAppUsers(
    c,
    host.accessAppId,
    unique.filter((id) => id !== c.get("userId")).map((id) => ({ id, field: "participantIds" })),
  );
  return unique;
}

/**
 * Whether an edit that names an assignee has it checked. A host that lists its assignees (a
 * project, AC-3.7) checks only a CHANGED one: one resent unchanged, who has since left the
 * team, is accepted. A host that does not (the CRM, specs/20261101-crm-sales-flow AC-2.2) checks the one an edit
 * names every time, changed or not, exactly as crm-api did (specs/20261110-activities US-1: the CRM keeps
 * behaving as today). The caller naming themselves is never asked (`requireAppUsers`).
 */
const assigneeToCheck = (host: ActivityHost, named: string, current: string | null): boolean =>
  host.assignees === "host_list" ? named !== current : true;

/**
 * Who a task may be given to (AC-3.1): a host that lists them (a project: manager + team)
 * accepts only those, a host that does not (the CRM) accepts any active user of its app. Asked
 * only when the assignee is set or CHANGED, never on a resent unchanged one (AC-3.7).
 */
async function assertAssignable(c: Caller, host: ActivityHost, entity: OpenEntity, assigneeUserId: string): Promise<void> {
  if (host.assignees === "host_list") {
    if (!entity.assignees?.includes(assigneeUserId)) {
      throw unprocessable(
        "The assignee must be on this project: its manager or a team member",
        { field: "assigneeUserId" },
        "assignee_not_on_project",
      );
    }
    return;
  }
  await requireAppUsers(c, host.accessAppId, [{ id: assigneeUserId, field: "assigneeUserId" }]);
}

// ─── Notifications ───────────────────────────────────────────────────────────

const notifyActivity = (row: ActivityRow): NotifyActivity => ({
  id: row.id,
  type: row.type,
  subject: row.subject,
  dueDate: row.dueDate,
});

/** What the notification copy shows of where the activity lives: labels the host gave, nothing else. */
function notifyTarget(session: HostSession, host: ActivityHost, row: Pick<ActivityRow, "hostId" | "dealId">): NotifyTarget {
  const entity = session.entity(host, row.hostId);
  const label = entity?.state === "open" ? entity.label : "";
  if (host.entityType === "project") return { host: "projects", project: { id: row.hostId, name: label } };
  const deal = row.dealId ? session.relatedOf("deal", row.dealId, row.hostId) : undefined;
  return {
    host: "crm",
    company: { id: row.hostId, name: label },
    deal: row.dealId && deal ? { id: row.dealId, title: deal.label } : null,
  };
}

/** E5: a task handed to a colleague. */
const announceTask = (c: Caller, session: HostSession, host: ActivityHost, row: ActivityRow) =>
  announce(c, {
    kind: "task_assigned",
    activityId: row.id,
    recipientIds: [row.assigneeUserId],
    activity: notifyActivity(row),
    target: notifyTarget(session, host, row),
  });

/** US-8: a colleague added to an activity hears it in-app (the actor is dropped). */
const announceParticipants = (c: Caller, session: HostSession, host: ActivityHost, row: ActivityRow, userIds: readonly string[]) =>
  userIds.length === 0
    ? Promise.resolve()
    : announce(c, {
        kind: "activity_participant_added",
        activityId: row.id,
        recipientIds: userIds,
        activity: notifyActivity(row),
        target: notifyTarget(session, host, row),
      });

// ─── Listing by ids (specs/20261112-time-tracking T6) ───────────────────────────────────────────

/** The ids of `?ids=a,b,c`: each 1..64 characters with no NUL, at most MAX_IDS as sent (not as distinct). One given twice is still one row. */
function parseIds(raw: string): string[] {
  const parts = raw.split(",");
  const refuse = (detail: string) => unprocessable(detail, { field: "ids" });
  if (parts.length > MAX_IDS) throw refuse(`Give at most ${MAX_IDS} ids`);
  for (const part of parts) {
    if (part === "") throw refuse("An id must not be empty");
    if (part.length > MAX_ID_LENGTH) throw refuse(`An id has at most ${MAX_ID_LENGTH} characters`);
    if (!noNul(part)) throw refuse(NUL_MESSAGE);
  }
  return parts;
}

/**
 * The activities among `ids` that the caller still reads, newest first, in one page (hours-api
 * asks it of every entry that points at an activity, and reads an absent id as "deleted, or not
 * yours", AC-2.9 / D47). Three rules make that reading safe:
 *
 *   - Every host that owns some of the rows is asked about them, as the caller (ADR 20261110-activities-service-access-delegated-to-host). The
 *     host that says the caller is no reader, and the entity it no longer knows, are one outcome
 *     with an id that never existed: the activity is left out, with no status, field or count that
 *     tells the three apart (`total` counts what is returned, never what was left out).
 *   - A host that cannot answer is the existing 503 `host_unavailable`, never a shorter list: an
 *     omission must always mean "not readable", so a failure never looks like one. Only the hosts
 *     that own a requested row are asked, so a lookup of CRM activities does not depend on Projects.
 *   - It is never cut: at most MAX_IDS rows exist, so there is one page, whatever `page` or
 *     `pageSize` the caller sent (the page of 25 every other list defaults to would silently drop
 *     half of 50 asked ids, and the caller would read those as deleted).
 */
async function listByIds(c: Caller, session: HostSession, ids: readonly string[], extra: Prisma.ActivityWhereInput) {
  const rows = await db.activity.findMany({
    where: { id: { in: [...ids] }, ...extra },
    include: withRefs,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  await Promise.all(
    session.registry.all().map(async (host) => {
      const mine = rows.filter((row) => row.hostApp === host.app && row.hostType === host.entityType);
      if (mine.length === 0) return;
      try {
        await session.load(
          host,
          mine.map((row) => row.hostId),
          relatedIdsOf(mine),
        );
      } catch (error) {
        // The host answered, and the caller is no reader of it: none of its activities is theirs to see.
        if (error instanceof ProblemError && error.status === 404) return;
        throw error;
      }
    }),
  );
  const readable = rows.filter((row) => {
    const entity = session.entity(hostOf(session, row), row.hostId);
    return entity?.state === "open";
  });
  return { items: await toViews(c, readable, session), total: readable.length, page: 1, pageSize: MAX_IDS };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/activities",
  tags: ["Activities"],
  summary:
    "Activities of one company, contact, deal or project, newest first; or, with `ids` (at most 50), those of them the caller still reads, " +
    "all in one page: an id that does not exist, that the caller may not read or whose record the host no longer knows is simply left out",
  middleware: [jwtMiddleware],
  request: { query: ListActivitiesQuery },
  responses: { 200: { description: "A page of activities", ...json(pageOf(ActivitySchema)) }, ...commonErrors },
});

const createActivityRoute = createRoute({
  method: "post",
  path: "/activities",
  tags: ["Activities"],
  summary: "Log an activity or create a task",
  middleware: [jwtMiddleware],
  request: { body: { content: { "application/json": { schema: CreateActivitySchema } }, required: true } },
  responses: { 201: { description: "Created", ...json(ActivitySchema) }, ...commonErrors },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/activities/{id}",
  tags: ["Activities"],
  summary: "Edit an activity (the host decides who: the author of a CRM one, a manager of a project's)",
  middleware: [jwtMiddleware],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateActivitySchema } }, required: true },
  },
  responses: { 200: { description: "Updated", ...json(ActivitySchema) }, ...commonErrors },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/activities/{id}",
  tags: ["Activities"],
  summary: "Delete an activity (same gate as editing)",
  middleware: [jwtMiddleware],
  request: { params: IdParams },
  responses: { 204: { description: "Deleted" }, ...commonErrors },
});

type TaskAction = "complete" | "reopen" | "start" | "stop";
const TASK_ACTION_SUMMARY: Record<TaskAction, string> = {
  complete: "Complete a task",
  reopen: "Reopen a task (it becomes open, never in progress)",
  start: "Start a task: it is in progress (US-10)",
  stop: "Stop a task: from in progress back to open (US-10)",
};

/** 409: a done task is reopened, never started or stopped (US-10 AC-10.3). */
const taskDone = () => new ProblemError({ status: 409, code: "task_done", detail: "This task is done: reopen it first" });

const completionRoute = (action: TaskAction) =>
  createRoute({
    method: "post",
    path: `/activities/{id}/${action}`,
    tags: ["Activities"],
    summary: TASK_ACTION_SUMMARY[action],
    middleware: [jwtMiddleware],
    request: { params: IdParams },
    responses: { 200: { description: "The task", ...json(ActivitySchema) }, ...commonErrors },
  });

export const activitiesRouter = new OpenAPIHono<{ Variables: JwtVariables }>({
  defaultHook: validationHook,
});

activitiesRouter.openapi(listRoute, async (c) => {
  const { companyId, contactId, dealId, projectId, ids, type, open, page, pageSize } = c.req.valid("query");
  const given = { companyId, contactId, dealId, projectId, ids };
  const filters = Object.entries(given).filter(([, v]) => v !== undefined && v !== "");
  if (filters.length !== 1) {
    throw unprocessable("Give exactly one of companyId, contactId, dealId, projectId or ids", { field: "companyId" });
  }
  const session = new HostSession(authorizationOf(c));
  const extra: Prisma.ActivityWhereInput = { ...(type ? { type } : {}), ...(open ? { completedAt: null } : {}) };
  if (ids) return c.json(await listByIds(c, session, parseIds(ids), extra), 200);

  let target: Prisma.ActivityWhereInput;
  if (companyId || projectId) {
    // An entity of a host: that host must let the caller read it (404 otherwise, AC-8.3).
    const field: TargetField = companyId ? "companyId" : "projectId";
    const ref = TARGET_FIELDS[field];
    const host = session.registry.get(ref.app, ref.entityType)!;
    const hostId = (companyId ?? projectId)!;
    await session.load(host, [hostId]);
    session.open(host, hostId);
    target = { hostApp: host.app, hostType: host.entityType, hostId };
  } else {
    // A contact or a deal belongs to the CRM: the activities about it live under companies, and
    // only those the CRM lets the caller read are listed. Asked even when none match, so a caller
    // who cannot read the CRM gets the same 404 whether or not anything refers to the record.
    const host = session.registry.get(TARGET_FIELDS.companyId.app, TARGET_FIELDS.companyId.entityType)!;
    const about: Prisma.ActivityWhereInput = contactId ? { contactId } : { dealId: dealId! };
    const companies = await db.activity.findMany({
      where: { hostApp: host.app, hostType: host.entityType, ...about },
      distinct: ["hostId"],
      select: { hostId: true },
    });
    await session.load(host, companies.map((row) => row.hostId));
    const readable = companies.map((row) => row.hostId).filter((id) => session.entity(host, id)?.state === "open");
    target = { hostApp: host.app, hostType: host.entityType, hostId: { in: readable }, ...about };
  }

  const where: Prisma.ActivityWhereInput = { ...target, ...extra };
  const [total, rows] = await Promise.all([
    db.activity.count({ where }),
    db.activity.findMany({
      where,
      include: withRefs,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...skipTake(page, pageSize),
    }),
  ]);
  return c.json({ items: await toViews(c, rows, session), total, page, pageSize }, 200);
});

activitiesRouter.openapi(createActivityRoute, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");

  // Exactly one entity, named by the field of its host.
  const named = TARGET_NAMES.filter((field) => body[field] !== undefined);
  if (named.length !== 1) {
    throw unprocessable("Give exactly one of companyId or projectId", { field: "companyId" });
  }
  const field = named[0]!;
  const session = new HostSession(authorizationOf(c));
  const host = session.registry.get(TARGET_FIELDS[field].app, TARGET_FIELDS[field].entityType)!;
  const hostId = body[field]!;

  if (!host.types.includes(body.type)) {
    throw unprocessable("This kind of activity is not available here", { field: "type" }, "type_not_allowed");
  }
  const isTask = body.type === "task";
  if (!isTask && body.dueDate != null) throw taskFieldsOnNonTask("dueDate");
  if (!isTask && body.assigneeUserId !== undefined) throw taskFieldsOnNonTask("assigneeUserId");
  if (!isTask && body.blockedByIds !== undefined) throw taskFieldsOnNonTask("blockedByIds");
  if (!isTask && body.description != null) throw taskFieldsOnNonTask("description");
  assertRefsApply(host, body.contactId, body.dealId);
  assertDetailsVisibilityApplies(host, body.detailsVisibility);
  const description = isTask ? (taskDescriptionOf(body) ?? null) : null;
  // A new task has no files yet: its description cannot show an image.
  if (description) await assertImagesOf(null, imageIdsOf(description));

  await session.load(host, [hostId], {
    contact: body.contactId ? [body.contactId] : [],
    deal: body.dealId ? [body.dealId] : [],
  });
  const entity = session.open(host, hostId);
  if (!mayCreate(entity)) throw createRefused();
  if (!entity.writable) throw hostReadOnly();

  assertRefs(session, hostId, body.contactId, body.dealId);
  const blockerIds = isTask
    ? await assertBlockers({ hostApp: host.app, hostType: host.entityType, hostId }, null, body.blockedByIds ?? [])
    : [];
  const participantIds = await assertParticipants(c, host, body.participantIds ?? []);
  // No assignee given: the author (AC-3.1). One given is checked, even when it is the caller.
  const assigneeUserId = isTask ? (body.assigneeUserId ?? userId) : null;
  if (isTask && body.assigneeUserId !== undefined) await assertAssignable(c, host, entity, body.assigneeUserId);

  // The contact's lock is taken first and held to the commit, so an erasure of it (crm-api) either
  // sees this row and unlinks it, or commits first and this create is refused (AC-8.4, ADR 20261110-caller-chosen-ids-replace-cross-service-transactions).
  const row = await db.$transaction(async (tx) => {
    if (body.contactId) await assertContactNotErased(tx, body.contactId);
    return tx.activity.create({
      data: {
        kind: host.kind,
        type: body.type,
        subject: body.subject,
        body: isTask ? null : (body.body ?? null),
        description: jsonOrNull(description),
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
        hostApp: host.app,
        hostType: host.entityType,
        hostId,
        contactId: body.contactId ?? null,
        dealId: body.dealId ?? null,
        authorUserId: userId,
        detailsVisibility: body.detailsVisibility ?? "everyone",
        dueDate: isTask ? (fromDateOnly(body.dueDate) ?? null) : null,
        assigneeUserId,
        blockedBy: { create: newBlockerRows(blockerIds, userId) },
        participants: {
          create: staggered(participantIds).map(({ id: participantId, createdAt }) => ({ userId: participantId, createdBy: userId, createdAt })),
        },
      },
      include: withRefs,
    });
  });
  if (isTask) await announceTask(c, session, host, row);
  await announceParticipants(c, session, host, row, participantIds);
  return c.json(await toView(c, row, session), 201);
});

activitiesRouter.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const { row: current, session, host, entity } = await loadFor(c, id, { contact: [body.contactId], deal: [body.dealId] });

  if (!mayChange(host, entity, current, userId)) throw changeRefused(host);
  if (!entity.writable) throw hostReadOnly();
  assertDetailsVisibilityApplies(host, body.detailsVisibility);
  // US-9 AC-9.1: who sees the details is the author's choice alone, whatever the host's edit rule.
  if (body.detailsVisibility !== undefined && body.detailsVisibility !== current.detailsVisibility && current.authorUserId !== userId) {
    throw new ProblemError({ status: 403, code: "author_only", detail: "Only the author can change who sees the details" });
  }

  if (current.type !== "task") {
    if (body.dueDate !== undefined) throw taskFieldsOnNonTask("dueDate");
    if (body.assigneeUserId !== undefined) throw taskFieldsOnNonTask("assigneeUserId");
    if (body.blockedByIds !== undefined) throw taskFieldsOnNonTask("blockedByIds");
    if (body.description != null) throw taskFieldsOnNonTask("description");
  }
  const description = current.type === "task" ? taskDescriptionOf(body) : undefined;
  const previousImages = imageIdsOf(current.description);
  const currentImages = description === undefined ? previousImages : imageIdsOf(description);
  if (description) await assertImagesOf(id, currentImages);
  // The entity stays: its contact and deal are checked against it (017 AC-4.1).
  assertRefsApply(host, body.contactId, body.dealId);
  assertRefs(session, current.hostId, body.contactId, body.dealId);
  if (body.assigneeUserId !== undefined && assigneeToCheck(host, body.assigneeUserId, current.assigneeUserId)) {
    await assertAssignable(c, host, entity, body.assigneeUserId);
  }
  const blockerIds =
    body.blockedByIds !== undefined ? await assertBlockers(current, id, body.blockedByIds) : undefined;
  let participantIds: string[] | undefined;
  let addedParticipants: string[] = [];
  if (body.participantIds !== undefined) {
    participantIds = await assertParticipants(c, host, body.participantIds);
    const before = new Set(current.participants.map((participant) => participant.userId));
    addedParticipants = participantIds.filter((participantId) => !before.has(participantId));
  }

  const row = await ifStillThere(() => db.$transaction(async (tx) => {
    // First, so the lock is held from before the link is written to the commit (AC-8.4, ADR 20261110-caller-chosen-ids-replace-cross-service-transactions).
    if (body.contactId) await assertContactNotErased(tx, body.contactId);
    if (blockerIds !== undefined) await replaceBlockers(tx, id, blockerIds, userId);
    if (participantIds !== undefined) {
      await tx.activityParticipant.deleteMany({ where: { activityId: id } });
      await tx.activityParticipant.createMany({
        data: staggered(participantIds).map(({ id: participantId, createdAt }) => ({
          activityId: id,
          userId: participantId,
          createdBy: userId,
          createdAt,
        })),
      });
    }
    return tx.activity.update({
      where: { id },
      data: {
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(current.type === "task"
          ? description !== undefined
            ? { description: jsonOrNull(description), body: null }
            : {}
          : body.body !== undefined
            ? { body: body.body }
            : {}),
        ...(body.occurredAt !== undefined ? { occurredAt: new Date(body.occurredAt) } : {}),
        ...(body.dueDate !== undefined ? { dueDate: fromDateOnly(body.dueDate) ?? null } : {}),
        ...(body.assigneeUserId !== undefined ? { assigneeUserId: body.assigneeUserId } : {}),
        ...(body.contactId !== undefined ? { contactId: body.contactId } : {}),
        ...(body.dealId !== undefined ? { dealId: body.dealId } : {}),
        ...(body.detailsVisibility !== undefined ? { detailsVisibility: body.detailsVisibility } : {}),
      },
      include: withRefs,
    });
  }));
  if (description !== undefined) await cleanUpAfterDescription(id, previousImages, currentImages);
  if (current.type === "task" && row.assigneeUserId !== current.assigneeUserId) await announceTask(c, session, host, row);
  await announceParticipants(c, session, host, row, addedParticipants);
  return c.json(await toView(c, row, session), 200);
});

activitiesRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { row, host, entity } = await loadFor(c, id);
  if (!mayChange(host, entity, row, c.get("userId"))) throw changeRefused(host);
  if (!entity.writable) throw hostReadOnly();
  // Its files first (objects, then rows), so nothing in the bucket outlives the task (ADR 20261113-task-description-files-in-activities-api-bucket).
  await deleteActivitiesWithFiles({ id });
  return c.body(null, 204);
});

/**
 * What a task action writes (US-10): `null` when it changes nothing. Idempotent: completing a completed task keeps who
 * completed it and when, starting a started one who started it; reopening clears both, so a reopened task is open.
 */
function taskActionData(action: TaskAction, current: ActivityRow, userId: string) {
  switch (action) {
    case "complete":
      return current.completedAt ? null : { completedAt: new Date(), completedByUserId: userId };
    case "reopen":
      return { completedAt: null, completedByUserId: null, startedAt: null, startedByUserId: null };
    case "start":
      return current.startedAt ? null : { startedAt: new Date(), startedByUserId: userId };
    case "stop":
      return current.startedAt ? { startedAt: null, startedByUserId: null } : null;
  }
}

for (const action of ["complete", "reopen", "start", "stop"] as const) {
  activitiesRouter.openapi(completionRoute(action), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const { row: current, session, host, entity } = await loadFor(c, id);
    if (current.type !== "task") throw unprocessable("Only a task can be completed", { field: "type" }, "not_a_task");
    // Allowed on a closed or cancelled entity too (AC-3.8): only the assignee or a manager (AC-3.3). US-10: starting
    // and stopping follow the same rule.
    if (!mayComplete(host, entity, current, userId)) throw completeRefused();
    if ((action === "start" || action === "stop") && current.completedAt) throw taskDone();
    // US-6 / US-10 AC-10.2: a task waiting on an open task can be neither completed nor started.
    if (action === "complete" && !current.completedAt) await assertUnblocked(id);
    if (action === "start" && !current.startedAt) await assertUnblocked(id);
    const data = taskActionData(action, current, userId) ?? {};
    const row = await ifStillThere(() => db.activity.update({ where: { id }, data, include: withRefs }));
    if (action === "complete" && !current.completedAt) {
      // Blockers share a host entity, so a freed task lives where this one does; only its deal (CRM)
      // may be one the host was not yet asked about. The notice is best effort: a host that cannot
      // answer now leaves its label out, it does not fail a completion that is already committed.
      await announceUnblocked(c, [id], async (task) => {
        await session.load(host, [task.hostId], { deal: task.dealId ? [task.dealId] : [] }).catch(() => {});
        return notifyTarget(session, host, task);
      });
    }
    return c.json(await toView(c, row, session), 200);
  });
}
