/**
 * Contracts of a project: create by hand, read, edit terms and dates, end — never delete
 * (specs/024 T8; AC-1.7, AC-2.1 – AC-2.10, AC-4.3, AC-4.4).
 *
 * Reading needs `projects:access` only (D13). Writing needs `project:manage` for the PROJECT'S
 * entity, like every write on a project. A contract has its project's type for life (D25): it is
 * set from the project at creation and no route changes it. Ending a contract is a `PATCH` of
 * `endDate`; there is no delete (D34).
 *
 * The Bexio order id is NOT written here (a contract's terms editor never touches it): it has its
 * own route and capability (`bexio.routes.ts`, T9). `toContractView`, `contractInclude` and
 * `findContractRow` are exported for it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { companyRefs, findActiveCompany, orCrmUnavailable } from "../lib/crm";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  assertVersion,
  casMiss,
  commonErrors,
  etag,
  fromDateOnly,
  IdParams,
  requireIfMatch,
  toDateOnly,
  updateIfVersion,
} from "../lib/http";
import { ProblemError, conflict, notFound, unprocessable, validationHook } from "../lib/problem";
import { isClientType, type ProjectType } from "../projects/projects.schemas";
import { ContractParams, ContractSchema, CreateContractSchema, UpdateContractSchema } from "./contracts.schemas";
import { parseTerms, positionRows, termColumns, termsView, validationFailed } from "./terms";

// ─── The Contract view ───────────────────────────────────────────────────────

export const contractInclude = { positions: { orderBy: { position: "asc" } } } satisfies Prisma.ContractInclude;

export type ContractRow = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

/** The contract, only when it belongs to that project. */
export const findContractRow = (projectId: string, contractId: string): Promise<ContractRow | null> =>
  db.contract.findFirst({ where: { id: contractId, projectId }, include: contractInclude });

/** Compare-and-set a contract write on its version ({@link updateIfVersion}); returns the new row. */
export const updateContractIfVersion = (
  contractId: string,
  expected: number,
  data: Prisma.ContractUpdateInput,
): Promise<ContractRow> =>
  updateIfVersion(
    () =>
      db.contract.update({
        where: { id: contractId, version: expected },
        data: { ...data, version: { increment: 1 } },
        include: contractInclude,
      }),
    () => db.contract.findUnique({ where: { id: contractId }, select: { version: true } }),
    "Contract not found",
  );

/**
 * The `Contract` of tasks.md § API contracts: the `ContractSummary` plus the project, the deal
 * link and the terms. `company` names a company from one CRM read the caller already made, so a
 * project's contracts cost one CRM call together, not one each.
 */
export function contractView(row: ContractRow, company: (id: string) => { id: string; name: string | null }) {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    company: company(row.companyId),
    origin: row.origin,
    dealId: row.dealId,
    bexioOrderId: row.bexioOrderId,
    startDate: toDateOnly(row.startDate)!,
    endDate: toDateOnly(row.endDate),
    terms: termsView(row),
    version: row.version,
  };
}

/** One contract's view, its company name read live (fail soft, ADR-0076). */
export async function toContractView(row: ContractRow) {
  return contractView(row, await companyRefs([row.companyId]));
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * The company a new contract is for (AC-2.2, A12): a client project's own company — another one
 * is a mismatch; any CRM company on a `saas` project, which has none of its own.
 */
async function resolveCompany(
  project: { type: ProjectType; companyId: string | null },
  requested: string | undefined,
): Promise<string> {
  if (isClientType(project.type)) {
    // A client project always has its company (a CHECK); the default needs no CRM lookup.
    const own = project.companyId!;
    if (requested !== undefined && requested !== own) {
      throw unprocessable(
        "A client project takes contracts for its own company only",
        { field: "companyId" },
        "company_mismatch",
      );
    }
    return own;
  }
  if (requested === undefined) {
    throw unprocessable("A company is required for a contract on a saas project", { field: "companyId" }, "company_required");
  }
  if (!(await orCrmUnavailable(findActiveCompany(requested)))) {
    throw unprocessable("The company does not exist in the CRM", { field: "companyId" }, "company_not_found");
  }
  return requested;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const createContractRoute = createRoute({
  method: "post",
  path: "/projects/{id}/contracts",
  tags: ["Contracts"],
  summary: "Add a contract by hand (project:manage for the project's entity)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: CreateContractSchema } }, required: true },
  },
  responses: {
    201: { description: "Created, with the project's type", ...json(ContractSchema) },
    404: { description: "Project not found" },
    409: { description: "contracts_not_allowed (internal project) or project_not_open (closed / cancelled)" },
    422: { description: "company_mismatch, company_required, company_not_found or maintenance_needs_sla_or_hours" },
    ...commonErrors,
  },
});

const getContractRoute = createRoute({
  method: "get",
  path: "/projects/{id}/contracts/{contractId}",
  tags: ["Contracts"],
  summary: "A contract with its terms",
  middleware: authorized,
  request: { params: ContractParams },
  responses: { 200: { description: "The contract", ...json(ContractSchema) }, 404: { description: "Not found" }, ...commonErrors },
});

const updateContractRoute = createRoute({
  method: "patch",
  path: "/projects/{id}/contracts/{contractId}",
  tags: ["Contracts"],
  summary: "Edit a contract's dates and terms, or end it with an end date (If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: ContractParams,
    body: { content: { "application/json": { schema: UpdateContractSchema } }, required: true },
  },
  responses: {
    200: { description: "Updated", ...json(ContractSchema) },
    404: { description: "Not found" },
    409: { description: "version_conflict" },
    422: { description: "maintenance_needs_sla_or_hours" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

const deleteContractRoute = createRoute({
  method: "delete",
  path: "/projects/{id}/contracts/{contractId}",
  tags: ["Contracts"],
  summary: "Not supported: a contract is never deleted, it ends (D34)",
  middleware: authorized,
  request: { params: ContractParams },
  responses: { 405: { description: "not_deletable" }, ...commonErrors },
});

export const contractsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

contractsRouter.openapi(createContractRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const project = await db.project.findUnique({
    where: { id },
    select: { type: true, state: true, entity: true, companyId: true },
  });
  if (!project) throw notFound("Project not found");
  assertCanManage(c, project.entity);
  if (project.type === "internal") {
    throw conflict("contracts_not_allowed", "An internal project has no clients and takes no contract");
  }
  if (project.state === "closed" || project.state === "cancelled") {
    throw conflict("project_not_open", `A ${project.state} project takes no new contract`, { state: project.state });
  }
  const terms = parseTerms(project.type, body.terms ?? {});
  const companyId = await resolveCompany(project, body.companyId);
  const row = await db.$transaction(async (tx) => {
    // The checks above read the project without a lock, and the CRM call may take a while. Re-read
    // its state under a row lock, so a close or cancel that committed meanwhile refuses the
    // contract, and one that comes later waits for this insert (a closed project takes none).
    const [locked] = await tx.$queryRaw<{ state: string }[]>`
      SELECT "state"::text AS "state" FROM "project" WHERE "id" = ${id} FOR UPDATE`;
    if (!locked) throw notFound("Project not found");
    if (locked.state === "closed" || locked.state === "cancelled") {
      throw conflict("project_not_open", `A ${locked.state} project takes no new contract`, { state: locked.state });
    }
    return tx.contract.create({
      data: {
        projectId: id,
        type: project.type,
        companyId,
        startDate: fromDateOnly(body.startDate)!,
        endDate: fromDateOnly(body.endDate) ?? null,
        ...termColumns(terms),
        positions: { create: positionRows(terms) },
      },
      include: contractInclude,
    });
  });
  c.header("ETag", etag(row.version));
  return c.json(await toContractView(row), 201);
});

contractsRouter.openapi(getContractRoute, async (c) => {
  const { id, contractId } = c.req.valid("param");
  const row = await findContractRow(id, contractId);
  if (!row) throw notFound("Contract not found");
  c.header("ETag", etag(row.version));
  return c.json(await toContractView(row), 200);
});

contractsRouter.openapi(updateContractRoute, async (c) => {
  const { id, contractId } = c.req.valid("param");
  const body = c.req.valid("json");
  const expected = requireIfMatch(c);
  const project = await db.project.findUnique({ where: { id }, select: { entity: true } });
  if (!project) throw notFound("Project not found");
  const current = await findContractRow(id, contractId);
  if (!current) throw notFound("Contract not found");
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
  const terms = body.terms !== undefined ? parseTerms(current.type, body.terms) : null;

  const row = await db.$transaction(async (tx) => {
    // Compare-and-set on the version: of two saves of the same version only one matches (AC-1.7).
    const bumped = await tx.contract.updateMany({
      where: { id: contractId, projectId: id, version: expected },
      data: {
        ...(body.startDate !== undefined ? { startDate } : {}),
        ...(body.endDate !== undefined ? { endDate } : {}),
        ...(terms ? termColumns(terms) : {}),
        version: { increment: 1 },
      },
    });
    if (bumped.count === 0) {
      throw casMiss(await tx.contract.findUnique({ where: { id: contractId }, select: { version: true } }), "Contract not found");
    }
    if (terms?.type === "t_and_m") {
      await tx.contractPosition.deleteMany({ where: { contractId } });
      await tx.contractPosition.createMany({ data: positionRows(terms).map((position) => ({ ...position, contractId })) });
    }
    return tx.contract.findUniqueOrThrow({ where: { id: contractId }, include: contractInclude });
  });
  c.header("ETag", etag(row.version));
  return c.json(await toContractView(row), 200);
});

contractsRouter.openapi(deleteContractRoute, () => {
  throw new ProblemError({
    status: 405,
    code: "not_deletable",
    detail: "A contract is never deleted; end it by setting its end date",
  });
});
