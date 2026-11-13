/**
 * The categories and work types (specs/029 T12; plan § Lists; AC-3.1 – AC-3.4, AC-3.7, AC-3.8).
 *
 * Reading the lists needs only a session: every person picks from them. Writing — create, rename,
 * retire and restore — needs `time-list:manage`, asked live of `auth` before anything else on the
 * route (src/authz/timeListManage.ts), so a person without it is refused 403 whatever the body or
 * the id says. No route deletes a category or a work type (AC-3.2): entries keep what they were
 * recorded with, so an item can be retired and restored but never removed, and a `DELETE` on either
 * path is the app's own 404.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { db } from "../lib/db";
import { timeListManage } from "../authz/timeListManage";
import { invalidRequestHook } from "../lib/errors";
import { conflict, notFound } from "../lib/problem";
import { itemNotFoundError, readErrors, writeErrors } from "./errorDocs";
import { IdSchema } from "./idRule";
import { NameSchema } from "./nameRule";
import {
  CategoryViewSchema,
  TimeListsViewSchema,
  WorkTypeViewSchema,
  toCategoryView,
  toWorkTypeView,
  type TimeListsView,
} from "./views";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const ListQuerySchema = z.object({
  includeRetired: z
    .enum(["true", "false"])
    .optional()
    .describe("`true` also lists the retired items (the Time lists screen); default `false`"),
});

const listRoute = createRoute({
  method: "get",
  path: "/time-lists",
  tags: ["Lists"],
  summary: "The categories and the two work-type lists (any session)",
  description:
    "Retired items are left out unless `includeRetired=true`. Needs only a valid session: " +
    "everyone picks from these lists, and nothing here is asked of `auth`.",
  request: { query: ListQuerySchema },
  responses: {
    200: { description: "The lists", ...json(TimeListsViewSchema) },
    ...readErrors,
  },
});

const CreateCategorySchema = z
  .object({
    name: NameSchema,
    requiresNote: z.boolean().optional().describe("Entries with this category must carry a note; default `false`"),
  })
  .strict();

const createCategoryRoute = createRoute({
  method: "post",
  path: "/time-categories",
  tags: ["Lists"],
  summary: "Add a category (time-list:manage)",
  middleware: [timeListManage],
  request: { body: { content: { "application/json": { schema: CreateCategorySchema } }, required: true } },
  responses: {
    201: { description: "Created", ...json(CategoryViewSchema) },
    ...writeErrors,
  },
});

const CreateWorkTypeSchema = z
  .object({
    list: z.enum(["project", "deal"]).describe("The list it belongs to: project entries or deal entries (AC-3.5)"),
    name: NameSchema,
  })
  .strict();

const createWorkTypeRoute = createRoute({
  method: "post",
  path: "/work-types",
  tags: ["Lists"],
  summary: "Add a work type to the project or the deal list (time-list:manage)",
  middleware: [timeListManage],
  request: { body: { content: { "application/json": { schema: CreateWorkTypeSchema } }, required: true } },
  responses: {
    201: { description: "Created", ...json(WorkTypeViewSchema) },
    ...writeErrors,
  },
});

const IdParams = z.object({ id: IdSchema.openapi({ param: { name: "id", in: "path" } }) });

const RetiredMember = z
  .boolean()
  .optional()
  .describe("`true` retires the item (it is no longer offered, entries keep it); `false` restores it. Both are idempotent.");

/** A `PATCH` names at least one member: an empty one is a client that forgot what it meant to change. */
const atLeastOneMember = (body: object): boolean => Object.keys(body).length > 0;
const AT_LEAST_ONE = { message: "at least one member is required" };

const UpdateCategorySchema = z
  .object({
    name: NameSchema.optional(),
    requiresNote: z.boolean().optional().describe("Entries with this category must carry a note (AC-3.6)"),
    retired: RetiredMember,
  })
  .strict()
  .refine(atLeastOneMember, AT_LEAST_ONE);

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/time-categories/{id}",
  tags: ["Lists"],
  summary: "Rename, retire or restore a category (time-list:manage)",
  middleware: [timeListManage],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateCategorySchema } }, required: true },
  },
  responses: {
    200: { description: "Updated, or already as asked (rename, retire and restore are idempotent)", ...json(CategoryViewSchema) },
    ...itemNotFoundError,
    ...writeErrors,
  },
});

const UpdateWorkTypeSchema = z
  .object({ name: NameSchema.optional(), retired: RetiredMember })
  .strict()
  .refine(atLeastOneMember, AT_LEAST_ONE);

const updateWorkTypeRoute = createRoute({
  method: "patch",
  path: "/work-types/{id}",
  tags: ["Lists"],
  summary: "Rename, retire or restore a work type (time-list:manage)",
  middleware: [timeListManage],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateWorkTypeSchema } }, required: true },
  },
  responses: {
    200: { description: "Updated, or already as asked (rename, retire and restore are idempotent)", ...json(WorkTypeViewSchema) },
    ...itemNotFoundError,
    ...writeErrors,
  },
});

/**
 * Postgres' unique indexes `time_category (lower(name))` and `work_type (list, lower(name))` refused
 * the row. They are the arbiter of "taken" (a check before the write would race), and they are the
 * only unique constraints these tables have besides the generated id, so any P2002 is a name.
 */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

const nameTaken = () => conflict("name_taken", "An item with this name already exists in this list (names are unique, case-insensitively, retired items included)");

/** Runs a write, turning a refused name into 409 `name_taken`; the write itself changes nothing then. */
async function writing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw isUniqueViolation(error) ? nameTaken() : error;
  }
}

export const listsRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: invalidRequestHook });

/** A new item goes last; the seeded rows, which share one `createdAt`, fall back to their names. */
const ASC = "asc" as const;
const inListOrder = { orderBy: [{ createdAt: ASC }, { name: ASC }, { id: ASC }] };

listsRouter.openapi(listRoute, async (c) => {
  const { includeRetired } = c.req.valid("query");
  const where = includeRetired === "true" ? {} : { retiredAt: null };
  const [categories, workTypes] = await Promise.all([
    db.timeCategory.findMany({ where, ...inListOrder }),
    db.workType.findMany({ where, ...inListOrder }),
  ]);
  const view: TimeListsView = {
    categories: categories.map(toCategoryView),
    workTypes: {
      project: workTypes.filter((row) => row.list === "project").map(toWorkTypeView),
      deal: workTypes.filter((row) => row.list === "deal").map(toWorkTypeView),
    },
  };
  return c.json(view, 200);
});

listsRouter.openapi(createCategoryRoute, async (c) => {
  const { name, requiresNote } = c.req.valid("json");
  const row = await writing(() =>
    db.timeCategory.create({ data: { name, requiresNote: requiresNote ?? false, createdBy: c.get("userId") } }),
  );
  return c.json(toCategoryView(row), 201);
});

listsRouter.openapi(createWorkTypeRoute, async (c) => {
  const { list, name } = c.req.valid("json");
  const row = await writing(() => db.workType.create({ data: { list, name, createdBy: c.get("userId") } }));
  return c.json(toWorkTypeView(row), 201);
});

const itemNotFound = () => notFound("No category or work type has this id");

/**
 * What a `PATCH` changes on a row, and nothing it does not: a member equal to what the row has is
 * left out, so a request that changes nothing writes nothing and leaves the row, its `updatedAt`
 * and the instant it was retired included, as it was (retire and restore are idempotent).
 * `retired: true` stamps `retiredAt` only on an active row; `retired: false` clears it.
 */
function changesTo(
  row: { name: string; retiredAt: Date | null; requiresNote?: boolean },
  body: { name?: string | undefined; requiresNote?: boolean | undefined; retired?: boolean | undefined },
): { name?: string; requiresNote?: boolean; retiredAt?: Date | null } {
  return {
    ...(body.name !== undefined && body.name !== row.name ? { name: body.name } : {}),
    ...(body.requiresNote !== undefined && body.requiresNote !== row.requiresNote ? { requiresNote: body.requiresNote } : {}),
    ...(body.retired === true && row.retiredAt === null ? { retiredAt: new Date() } : {}),
    ...(body.retired === false && row.retiredAt !== null ? { retiredAt: null } : {}),
  };
}

listsRouter.openapi(updateCategoryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await db.timeCategory.findUnique({ where: { id } });
  if (!row) throw itemNotFound();
  const data = changesTo(row, body);
  if (Object.keys(data).length === 0) return c.json(toCategoryView(row), 200);
  // One statement: a refused name leaves the retire or restore sent with it undone.
  return c.json(toCategoryView(await writing(() => db.timeCategory.update({ where: { id }, data }))), 200);
});

listsRouter.openapi(updateWorkTypeRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await db.workType.findUnique({ where: { id } });
  if (!row) throw itemNotFound();
  const data = changesTo(row, body);
  if (Object.keys(data).length === 0) return c.json(toWorkTypeView(row), 200);
  return c.json(toWorkTypeView(await writing(() => db.workType.update({ where: { id }, data }))), 200);
});
