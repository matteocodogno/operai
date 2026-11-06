/**
 * Activities and tasks (specs/017-crm US-4; plan.md § Activities and tasks).
 *
 * Every route needs `crm:access`. An activity belongs to one company and may
 * reference one of ITS contacts and deals (AC-4.1). Only the author edits or
 * deletes it; anyone completes or reopens a task (D-19). No If-Match here: a
 * single author edits, so there is nobody to race (D-7).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  DateOnlySchema,
  IdParams,
  PersonRefSchema,
  commonErrors,
  fromDateOnly,
  optionalText,
  pageOf,
  pageQuery,
  requiredText,
  skipTake,
  toDateOnly,
  type HeaderSource,
} from "../lib/http";
import { requireCrmUsers } from "../lib/identities";
import { MAX_NAME, announce, clip, formatDueDate } from "../lib/notify";
import { loadPeople } from "../lib/people";
import { ProblemError, notFound, unprocessable, validationHook } from "../lib/problem";
import { MAX_BLOCKERS, announceUnblocked, assertBlockers, assertUnblocked, replaceBlockers } from "./blockers";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const ACTIVITY_TYPES = ["note", "call", "meeting", "email", "task"] as const;
const TypeSchema = z.enum(ACTIVITY_TYPES);
const UserIdSchema = z.string().min(1).max(64);
/** The tasks this one waits on (US-6): the whole set, replacing any previous one. */
const BlockedByIdsSchema = z.array(z.string().min(1).max(64)).max(MAX_BLOCKERS);
/** The wellD colleagues who took part (US-8): the whole set, replacing any previous one. */
export const MAX_PARTICIPANTS = 10;
const ParticipantIdsSchema = z.array(UserIdSchema).max(MAX_PARTICIPANTS);

const CreateActivitySchema = z
  .object({
    type: TypeSchema,
    subject: requiredText(200),
    body: optionalText(10_000),
    companyId: z.string().min(1).max(64),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    contactId: z.string().min(1).max(64).nullable().optional(),
    dealId: z.string().min(1).max(64).nullable().optional(),
    dueDate: DateOnlySchema.nullable().optional(),
    assigneeUserId: UserIdSchema.optional(),
    blockedByIds: BlockedByIdsSchema.optional(),
    participantIds: ParticipantIdsSchema.optional(),
  })
  .strict();

const UpdateActivitySchema = z
  .object({
    subject: requiredText(200).optional(),
    body: optionalText(10_000),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    dueDate: DateOnlySchema.nullable().optional(),
    assigneeUserId: UserIdSchema.optional(),
    blockedByIds: BlockedByIdsSchema.optional(),
    participantIds: ParticipantIdsSchema.optional(),
    // AC-4.2: the contact and the deal can be changed or cleared, always among the company's own.
    contactId: z.string().min(1).max(64).nullable().optional(),
    dealId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

const ListActivitiesQuery = z.object({
  companyId: z.string().max(64).optional(),
  contactId: z.string().max(64).optional(),
  dealId: z.string().max(64).optional(),
  // `type=task&open=true`: the open tasks a task may be blocked by (US-6 picker).
  type: TypeSchema.optional(),
  open: z.enum(["true"]).optional(),
  ...pageQuery(),
});

const ListTasksQuery = z.object({
  status: z.enum(["open", "done"]).default("open"),
  // `me` (default), `any`, or one person's auth user id (the "a colleague's" filter). A person's
  // tasks are those assigned to them and those they take part in (US-8).
  assignee: z.string().min(1).max(64).default("me"),
  ...pageQuery(),
});

const ActivitySchema = z.object({
  id: z.string(),
  type: TypeSchema,
  subject: z.string(),
  /** Null for a meeting activity: its content is the meeting, reached through `meeting` (specs/021 AC-14.2). */
  body: z.string().nullable(),
  occurredAt: z.string(),
  company: z.object({ id: z.string(), name: z.string() }),
  contact: z.object({ id: z.string(), name: z.string() }).nullable(),
  deal: z.object({ id: z.string(), title: z.string() }).nullable(),
  author: PersonRefSchema,
  /** The wellD colleagues who took part, besides the author and the assignee (US-8). */
  participants: z.array(PersonRefSchema),
  /**
   * The Meetings meeting this activity mirrors (specs/021 US-14), or null. The link is all a reader
   * gets: whether they may open it is Meetings' decision (404 for anyone without access, AC-14.4).
   */
  meeting: z.object({ id: z.string(), href: z.string() }).nullable(),
  task: z
    .object({
      dueDate: z.string().nullable(),
      assignee: PersonRefSchema.nullable(),
      completedAt: z.string().nullable(),
      completedBy: PersonRefSchema.nullable(),
      /** The tasks it waits on (US-6); `blocked` while any of them is open. */
      blockedBy: z.array(z.object({ id: z.string(), subject: z.string(), completed: z.boolean() })),
      blocked: z.boolean(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Views ───────────────────────────────────────────────────────────────────

const withRefs = {
  company: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true } },
  deal: { select: { id: true, title: true } },
  blockedBy: {
    select: { blocker: { select: { id: true, subject: true, completedAt: true } } },
    orderBy: { createdAt: "asc" },
  },
  participants: { select: { userId: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.ActivityInclude;
type ActivityRow = Prisma.ActivityGetPayload<{ include: typeof withRefs }>;

async function toViews(c: HeaderSource, rows: readonly ActivityRow[]) {
  const { person, maybe } = await loadPeople(
    c,
    rows.flatMap((row) => [
      row.authorUserId,
      row.assigneeUserId,
      row.completedByUserId,
      ...row.participants.map((participant) => participant.userId),
    ]),
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject,
    // AC-14.2: a meeting activity's body is the link and nothing else, whatever the row holds.
    body: row.meetingId === null ? row.body : null,
    occurredAt: row.occurredAt.toISOString(),
    company: row.company,
    contact: row.contact ? { id: row.contact.id, name: `${row.contact.firstName} ${row.contact.lastName}` } : null,
    deal: row.deal,
    author: person(row.authorUserId),
    participants: row.participants.map((participant) => person(participant.userId)),
    meeting: row.meetingId === null ? null : { id: row.meetingId, href: `/my-meetings/m/${row.meetingId}` },
    task:
      row.type === "task"
        ? {
            dueDate: toDateOnly(row.dueDate),
            assignee: maybe(row.assigneeUserId),
            completedAt: row.completedAt?.toISOString() ?? null,
            completedBy: maybe(row.completedByUserId),
            blockedBy: row.blockedBy.map(({ blocker }) => ({
              id: blocker.id,
              subject: blocker.subject,
              completed: blocker.completedAt !== null,
            })),
            blocked: row.blockedBy.some(({ blocker }) => blocker.completedAt === null),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function toView(c: HeaderSource, row: ActivityRow) {
  const [view] = await toViews(c, [row]);
  return view!;
}

/** AC-4.1: the referenced contact and deal must belong to the activity's company. */
async function assertRefs(companyId: string, contactId: string | null | undefined, dealId: string | null | undefined) {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) throw unprocessable("The company does not exist", { field: "companyId" }, "company_not_found");
  if (contactId) {
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== companyId) {
      throw unprocessable("The contact does not belong to this company", { field: "contactId" }, "contact_not_in_company");
    }
  }
  if (dealId) {
    const deal = await db.deal.findUnique({ where: { id: dealId }, select: { companyId: true } });
    if (!deal || deal.companyId !== companyId) {
      throw unprocessable("The deal does not belong to this company", { field: "dealId" }, "deal_not_in_company");
    }
  }
}

const taskFieldsOnNonTask = (field: string) =>
  unprocessable("Due date and assignee belong to tasks only", { field }, "task_fields_on_non_task");

async function loadOwn(id: string, userId: string): Promise<ActivityRow> {
  const row = await db.activity.findUnique({ where: { id }, include: withRefs });
  if (!row) throw notFound("Activity not found");
  if (row.authorUserId !== userId) {
    throw new ProblemError({ status: 403, code: "author_only", detail: "Only the author can change this activity" });
  }
  return row;
}

/** E5: a task handed to a colleague; the link goes to their task list, not a deal. */
async function announceTask(c: Parameters<typeof announce>[0], row: ActivityRow) {
  const context = row.deal ? clip(row.deal.title, MAX_NAME) : clip(row.company.name, MAX_NAME);
  await announce(c, {
    kind: "task_assigned",
    dealId: row.deal?.id ?? null,
    recipientIds: [row.assigneeUserId],
    severity: "info",
    email: true,
    href: "/crm/tasks",
    copy: (actor) => ({
      title: `New task: ${clip(row.subject, MAX_NAME)}`,
      body: `${actor} assigned you a task${row.dueDate ? `, due ${formatDueDate(row.dueDate)}` : ""}. ${row.deal ? "Deal" : "Company"}: ${context}.`,
    }),
  });
}

/** US-8: distinct ids, each an active CRM user (the caller needs no check). */
async function assertParticipants(c: Parameters<typeof requireCrmUsers>[0], ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  await requireCrmUsers(
    c,
    unique.filter((id) => id !== c.get("userId")).map((id) => ({ id, field: "participantIds" })),
  );
  return unique;
}

/** US-8: a colleague added to an activity hears it in-app (the actor is dropped). */
async function announceParticipants(c: Parameters<typeof announce>[0], row: ActivityRow, userIds: readonly string[]) {
  if (userIds.length === 0) return;
  const context = row.deal ? `Deal: ${clip(row.deal.title, MAX_NAME)}` : `Company: ${clip(row.company.name, MAX_NAME)}`;
  await announce(c, {
    kind: "activity_participant_added",
    dealId: row.deal?.id ?? null,
    recipientIds: userIds,
    severity: "info",
    email: false,
    href: row.type === "task" ? "/crm/tasks" : row.deal ? `/crm/deals/${row.deal.id}` : `/crm/companies/${row.company.id}`,
    copy: (actor) => ({
      title: `You take part in: ${clip(row.subject, MAX_NAME)}`,
      body: `${actor} added you to this ${row.type}. ${context}.`,
    }),
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/activities",
  tags: ["Activities"],
  summary: "Activities of one company, contact or deal, newest first",
  middleware: authorized,
  request: { query: ListActivitiesQuery },
  responses: { 200: { description: "A page of activities", ...json(pageOf(ActivitySchema)) }, ...commonErrors },
});

const createActivityRoute = createRoute({
  method: "post",
  path: "/activities",
  tags: ["Activities"],
  summary: "Log an activity or create a task",
  middleware: authorized,
  request: { body: { content: { "application/json": { schema: CreateActivitySchema } }, required: true } },
  responses: { 201: { description: "Created", ...json(ActivitySchema) }, ...commonErrors },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/activities/{id}",
  tags: ["Activities"],
  summary: "Edit an activity (author only)",
  middleware: authorized,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateActivitySchema } }, required: true },
  },
  responses: { 200: { description: "Updated", ...json(ActivitySchema) }, 404: { description: "Not found" }, ...commonErrors },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/activities/{id}",
  tags: ["Activities"],
  summary: "Delete an activity (author only)",
  middleware: authorized,
  request: { params: IdParams },
  responses: { 204: { description: "Deleted" }, 404: { description: "Not found" }, ...commonErrors },
});

const completionRoute = (action: "complete" | "reopen") =>
  createRoute({
    method: "post",
    path: `/activities/{id}/${action}`,
    tags: ["Activities"],
    summary: action === "complete" ? "Complete a task" : "Reopen a task",
    middleware: authorized,
    request: { params: IdParams },
    responses: { 200: { description: "The task", ...json(ActivitySchema) }, 404: { description: "Not found" }, ...commonErrors },
  });

const tasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Activities"],
  summary: "Tasks — by default the caller's open ones, earliest due first",
  middleware: authorized,
  request: { query: ListTasksQuery },
  responses: { 200: { description: "A page of tasks", ...json(pageOf(ActivitySchema)) }, ...commonErrors },
});

// Everyone who has ever been assigned a task, for the task filter. A `crm:access` holder can
// already read every task with its assignee (`assignee=any`), so this projection gives them
// nothing new (ADR-0042's reconstructibility test) and needs no directory permission.
const MAX_ASSIGNEES = 500;

const assigneesRoute = createRoute({
  method: "get",
  path: "/tasks/assignees",
  tags: ["Activities"],
  summary: "The people tasks have been assigned to, by name",
  middleware: authorized,
  responses: {
    200: { description: "Task assignees", ...json(z.object({ items: z.array(PersonRefSchema) })) },
    ...commonErrors,
  },
});

export const activitiesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

activitiesRouter.openapi(listRoute, async (c) => {
  const { companyId, contactId, dealId, type, open, page, pageSize } = c.req.valid("query");
  const filters = [companyId, contactId, dealId].filter((v) => v !== undefined && v !== "");
  if (filters.length !== 1) {
    throw unprocessable("Give exactly one of companyId, contactId or dealId", { field: "companyId" });
  }
  const target: Prisma.ActivityWhereInput = companyId ? { companyId } : contactId ? { contactId } : { dealId: dealId! };
  const where: Prisma.ActivityWhereInput = {
    ...target,
    ...(type ? { type } : {}),
    ...(open ? { completedAt: null } : {}),
  };
  const [total, rows] = await Promise.all([
    db.activity.count({ where }),
    db.activity.findMany({
      where,
      include: withRefs,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...skipTake(page, pageSize),
    }),
  ]);
  return c.json({ items: await toViews(c, rows), total, page, pageSize }, 200);
});

activitiesRouter.openapi(createActivityRoute, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const isTask = body.type === "task";
  if (!isTask && body.dueDate != null) throw taskFieldsOnNonTask("dueDate");
  if (!isTask && body.assigneeUserId !== undefined) throw taskFieldsOnNonTask("assigneeUserId");
  if (!isTask && body.blockedByIds !== undefined) throw taskFieldsOnNonTask("blockedByIds");
  await assertRefs(body.companyId, body.contactId, body.dealId);
  const blockerIds = isTask ? await assertBlockers(null, body.companyId, body.blockedByIds ?? []) : [];
  const participantIds = await assertParticipants(c, body.participantIds ?? []);
  const assigneeUserId = isTask ? (body.assigneeUserId ?? userId) : null;
  if (assigneeUserId !== null && assigneeUserId !== userId) {
    await requireCrmUsers(c, [{ id: assigneeUserId, field: "assigneeUserId" }]);
  }
  const row = await db.activity.create({
    data: {
      type: body.type,
      subject: body.subject,
      body: body.body ?? null,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      companyId: body.companyId,
      contactId: body.contactId ?? null,
      dealId: body.dealId ?? null,
      authorUserId: userId,
      dueDate: isTask ? (fromDateOnly(body.dueDate) ?? null) : null,
      assigneeUserId,
      blockedBy: { create: blockerIds.map((blockerId) => ({ blockerId, createdBy: userId })) },
      participants: { create: participantIds.map((participantId) => ({ userId: participantId, createdBy: userId })) },
    },
    include: withRefs,
  });
  if (isTask) await announceTask(c, row);
  await announceParticipants(c, row, participantIds);
  return c.json(await toView(c, row), 201);
});

activitiesRouter.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const current = await loadOwn(id, userId);
  if (current.type !== "task") {
    if (body.dueDate !== undefined) throw taskFieldsOnNonTask("dueDate");
    if (body.assigneeUserId !== undefined) throw taskFieldsOnNonTask("assigneeUserId");
    if (body.blockedByIds !== undefined) throw taskFieldsOnNonTask("blockedByIds");
  }
  // The company stays: its contact and deal are checked against it (AC-4.1).
  if (body.contactId !== undefined || body.dealId !== undefined) {
    await assertRefs(current.company.id, body.contactId, body.dealId);
  }
  if (body.assigneeUserId !== undefined && body.assigneeUserId !== userId) {
    await requireCrmUsers(c, [{ id: body.assigneeUserId, field: "assigneeUserId" }]);
  }
  if (body.blockedByIds !== undefined) {
    await replaceBlockers(id, await assertBlockers(id, current.company.id, body.blockedByIds), userId);
  }
  let addedParticipants: string[] = [];
  if (body.participantIds !== undefined) {
    const next = await assertParticipants(c, body.participantIds);
    const before = new Set(current.participants.map((participant) => participant.userId));
    addedParticipants = next.filter((participantId) => !before.has(participantId));
    await db.$transaction([
      db.activityParticipant.deleteMany({ where: { activityId: id } }),
      db.activityParticipant.createMany({
        data: next.map((participantId) => ({ activityId: id, userId: participantId, createdBy: userId })),
      }),
    ]);
  }
  const row = await db.activity.update({
    where: { id },
    data: {
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.occurredAt !== undefined ? { occurredAt: new Date(body.occurredAt) } : {}),
      ...(body.dueDate !== undefined ? { dueDate: fromDateOnly(body.dueDate) ?? null } : {}),
      ...(body.assigneeUserId !== undefined ? { assigneeUserId: body.assigneeUserId } : {}),
      ...(body.contactId !== undefined ? { contactId: body.contactId } : {}),
      ...(body.dealId !== undefined ? { dealId: body.dealId } : {}),
    },
    include: withRefs,
  });
  if (current.type === "task" && row.assigneeUserId !== current.assigneeUserId) await announceTask(c, row);
  await announceParticipants(c, row, addedParticipants);
  return c.json(await toView(c, row), 200);
});

activitiesRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  await loadOwn(id, c.get("userId"));
  await db.activity.delete({ where: { id } });
  return c.body(null, 204);
});

for (const action of ["complete", "reopen"] as const) {
  activitiesRouter.openapi(completionRoute(action), async (c) => {
    const { id } = c.req.valid("param");
    const current = await db.activity.findUnique({ where: { id }, select: { type: true, completedAt: true } });
    if (!current) throw notFound("Activity not found");
    if (current.type !== "task") throw unprocessable("Only a task can be completed", { field: "type" }, "not_a_task");
    // US-6: a task waiting on an open task cannot be completed.
    if (action === "complete" && !current.completedAt) await assertUnblocked(id);
    // Idempotent: completing a completed task keeps who completed it and when.
    const data =
      action === "reopen"
        ? { completedAt: null, completedByUserId: null }
        : current.completedAt
          ? {}
          : { completedAt: new Date(), completedByUserId: c.get("userId") };
    const row = await db.activity.update({ where: { id }, data, include: withRefs });
    if (action === "complete" && !current.completedAt) await announceUnblocked(c, [id]);
    return c.json(await toView(c, row), 200);
  });
}

/** A person's tasks: assigned to them, or one they take part in (US-8). */
const personsTasks = (userId: string): Prisma.ActivityWhereInput => ({
  OR: [{ assigneeUserId: userId }, { participants: { some: { userId } } }],
});

activitiesRouter.openapi(tasksRoute, async (c) => {
  const { status, assignee, page, pageSize } = c.req.valid("query");
  const where: Prisma.ActivityWhereInput = {
    type: "task",
    completedAt: status === "open" ? null : { not: null },
    ...(assignee === "any" ? {} : personsTasks(assignee === "me" ? c.get("userId") : assignee)),
  };
  const orderBy: Prisma.ActivityOrderByWithRelationInput[] =
    status === "open"
      ? [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }]
      : [{ completedAt: "desc" }, { id: "desc" }];
  const [total, rows] = await Promise.all([
    db.activity.count({ where }),
    db.activity.findMany({ where, include: withRefs, orderBy, ...skipTake(page, pageSize) }),
  ]);
  return c.json({ items: await toViews(c, rows), total, page, pageSize }, 200);
});

activitiesRouter.openapi(assigneesRoute, async (c) => {
  const rows = await db.activity.findMany({
    where: { type: "task", assigneeUserId: { not: null } },
    distinct: ["assigneeUserId"],
    select: { assigneeUserId: true },
    take: MAX_ASSIGNEES,
  });
  const ids = rows.map((row) => row.assigneeUserId!);
  const { person } = await loadPeople(c, ids);
  const items = ids
    .map(person)
    .sort((a, b) => (a.name ?? "\uffff").localeCompare(b.name ?? "\uffff") || a.id.localeCompare(b.id));
  return c.json({ items }, 200);
});
