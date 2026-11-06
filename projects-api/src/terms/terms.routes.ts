/**
 * The terms of a project: add, edit, remove — remove only on a hand-made project (specs/021 T8 as
 * renamed by specs/022 T23; AC-1.7, AC-1.8, AC-2.1 – AC-2.9, AC-3.1, AC-5.2 – AC-5.4).
 *
 * There is no GET: the terms come with the `Project`. Writing needs `project:manage` for the PROJECT'S
 * entity, like every write on a project. Terms have their project's type for life (D25): it is set
 * from the project at creation and no route changes it. A project made from a deal always has its
 * terms, created with it in the take, so `POST` is for hand-made projects (`409 terms_exist`
 * otherwise) and `DELETE` refuses a project with a purchase order (`409 terms_required`).
 *
 * The wire shape is specs/021's contract shape (`terms.schemas.ts`): `{ startDate, endDate?, terms }`.
 * A body error names the field by its path in the body (`startDate`, `terms.deadline`,
 * `terms.hourPackage.hours`). Every write takes the version it edited through `If-Match`, as every
 * write of the module does (ADR-0038).
 *
 * The man-days of a project whose purchase order has an estimate are the estimate's, copied once at
 * creation (A6) and read-only after (AC-3.1): the client omits the member — sending it, even `null`,
 * is a 422 — and the stored figure is kept, so replacing the other terms never clears it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { assertVersion, commonErrors, etag, fromDateOnly, IdParams, requireIfMatch, versionConflict } from "../lib/http";
import { ProblemError, conflict, notFound, unprocessable, validationHook } from "../lib/problem";
import { TermsSchema, type ProjectType } from "../projects/projects.schemas";
import { assertTakesTerms, termsCreateData } from "./create";
import { CreateTermsSchema, UpdateTermsSchema } from "./terms.schemas";
import { parseTerms, positionRows, termColumns, toTermsView, validationFailed, type Terms } from "./terms";

const termsInclude = { positions: { orderBy: { position: "asc" } } } as const;

/** Postgres' unique index on `project_terms.projectId` refused a second terms row for the project. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

const termsExist = () => conflict("terms_exist", "This project already has terms: edit them instead");

const termsNotFound = () =>
  new ProblemError({ status: 404, code: "terms_not_found", detail: "This project has no terms" });

/**
 * The terms a `PATCH` stores, validated against the project's own type. The man-days of a project
 * whose purchase order has an estimate are the estimate's, copied once at creation (A6) and read-only
 * after (AC-3.1): the client omits the member — sending it, even `null`, is a 422 — and the stored
 * figure is kept, so replacing the other terms never clears it. Any other project (hand-made, or from
 * a deal without an estimate) owns its man-days (AC-3.5).
 */
function termsToStore(
  project: { type: ProjectType; purchaseOrder: { estimateId: string | null } | null },
  current: { estimatedManDays: { toNumber(): number } | null },
  raw: Record<string, unknown>,
): Terms {
  const fromEstimate = project.type === "fixed_price" && project.purchaseOrder?.estimateId != null;
  if (fromEstimate && "estimatedManDays" in raw) {
    throw unprocessable(
      "The estimated man-days of a project made from a deal with an estimate come from the estimate: leave them out",
      { field: "terms.estimatedManDays" },
      "estimated_man_days_from_estimate",
    );
  }
  const terms = parseTerms(project.type, raw);
  return fromEstimate && terms.type === "fixed_price"
    ? { ...terms, estimatedManDays: current.estimatedManDays?.toNumber() ?? null }
    : terms;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const createTermsRoute = createRoute({
  method: "post",
  path: "/projects/{id}/terms",
  tags: ["Terms"],
  summary: "Add terms to a hand-made project (project:manage for the project's entity)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: CreateTermsSchema } }, required: true },
  },
  responses: {
    201: { description: "Created, with the project's type", ...json(TermsSchema) },
    404: { description: "Project not found" },
    409: { description: "terms_not_allowed (internal project), terms_exist or project_not_open (closed / cancelled)" },
    422: { description: "maintenance_needs_sla_or_hours" },
    ...commonErrors,
  },
});

const updateTermsRoute = createRoute({
  method: "patch",
  path: "/projects/{id}/terms",
  tags: ["Terms"],
  summary: "Edit a project's dates and terms; `terms` replaces the type-specific terms whole (If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateTermsSchema } }, required: true },
  },
  responses: {
    200: { description: "Updated", ...json(TermsSchema) },
    404: { description: "Project not found, or terms_not_found" },
    409: { description: "version_conflict" },
    422: { description: "maintenance_needs_sla_or_hours, or estimated_man_days_from_estimate (the man-days come from the purchase order's estimate)" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

const deleteTermsRoute = createRoute({
  method: "delete",
  path: "/projects/{id}/terms",
  tags: ["Terms"],
  summary: "Remove the terms of a hand-made project (project:manage for its entity, If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: { params: IdParams },
  responses: {
    204: { description: "Removed" },
    404: { description: "Project not found, or terms_not_found" },
    409: { description: "terms_required (the project has a purchase order) or version_conflict" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

export const termsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

termsRouter.openapi(createTermsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const project = await db.project.findUnique({
    where: { id },
    select: { type: true, state: true, entity: true, terms: { select: { id: true } } },
  });
  if (!project) throw notFound("Project not found");
  assertCanManage(c, project.entity);
  assertTakesTerms({ ...project, hasTerms: project.terms !== null });
  const terms = parseTerms(project.type, body.terms ?? {});
  const row = await db.projectTerms
    .create({
      data: {
        projectId: id,
        ...termsCreateData({ type: project.type, startDate: body.startDate, endDate: body.endDate, terms }),
      },
      include: termsInclude,
    })
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? termsExist() : error;
    });
  c.header("ETag", etag(row.version));
  return c.json(toTermsView(row), 201);
});

termsRouter.openapi(updateTermsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const expected = requireIfMatch(c);
  const project = await db.project.findUnique({
    where: { id },
    select: { type: true, entity: true, purchaseOrder: { select: { estimateId: true } }, terms: { include: termsInclude } },
  });
  if (!project) throw notFound("Project not found");
  const current = project.terms;
  if (!current) throw termsNotFound();
  assertCanManage(c, project.entity);
  assertVersion(current.version, expected);

  const startDate = body.startDate !== undefined ? fromDateOnly(body.startDate)! : current.startDate;
  const endDate = body.endDate !== undefined ? (fromDateOnly(body.endDate) ?? null) : current.endDate;
  // The body alone is checked when it carries both dates; against the stored one when it carries one.
  if (endDate !== null && endDate < startDate) {
    throw validationFailed([
      { path: [body.endDate !== undefined ? "endDate" : "startDate"], message: "The end date must not be before the start date" },
    ]);
  }
  const terms = body.terms !== undefined ? termsToStore(project, current, body.terms) : null;

  const row = await db.$transaction(async (tx) => {
    // Compare-and-set on the version: of two saves of the same version only one matches (AC-1.7).
    const bumped = await tx.projectTerms.updateMany({
      where: { id: current.id, version: expected },
      data: {
        ...(body.startDate !== undefined ? { startDate } : {}),
        ...(body.endDate !== undefined ? { endDate } : {}),
        ...(terms ? termColumns(terms) : {}),
        version: { increment: 1 },
      },
    });
    if (bumped.count === 0) {
      const now = await tx.projectTerms.findUnique({ where: { id: current.id }, select: { version: true } });
      throw now ? versionConflict(now.version) : termsNotFound();
    }
    if (terms?.type === "t_and_m") {
      await tx.projectTermsPosition.deleteMany({ where: { termsId: current.id } });
      await tx.projectTermsPosition.createMany({ data: positionRows(terms).map((position) => ({ ...position, termsId: current.id })) });
    }
    return tx.projectTerms.findUniqueOrThrow({ where: { id: current.id }, include: termsInclude });
  });
  c.header("ETag", etag(row.version));
  return c.json(toTermsView(row), 200);
});

termsRouter.openapi(deleteTermsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const expected = requireIfMatch(c);
  const project = await db.project.findUnique({
    where: { id },
    select: { entity: true, purchaseOrder: { select: { id: true } }, terms: { select: { id: true, version: true } } },
  });
  if (!project) throw notFound("Project not found");
  assertCanManage(c, project.entity);
  if (!project.terms) throw termsNotFound();
  // A project made from a deal always has its terms (AC-1.8): they are edited, never removed.
  if (project.purchaseOrder) {
    throw conflict("terms_required", "A project made from a deal always has its terms: edit them instead of removing them");
  }
  assertVersion(project.terms.version, expected);
  // Compare-and-set on the version: terms edited since the caller loaded them are not silently removed.
  const removed = await db.projectTerms.deleteMany({ where: { id: project.terms.id, version: expected } });
  if (removed.count === 0) {
    const now = await db.projectTerms.findUnique({ where: { id: project.terms.id }, select: { version: true } });
    if (now) throw versionConflict(now.version);
  }
  return c.body(null, 204);
});
