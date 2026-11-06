/**
 * Deals and the pipeline (specs/017-crm US-3; plan.md § Deals).
 *
 * Reads need `crm:access` only — every CRM user sees the pipeline. Writes need
 * `deal:manage`, entity-scoped (ADR-0015): a capability-absent caller gets the
 * generic 403, a holder acting outside their entity a 403 `out_of_scope` — not
 * a 404, because the deal is readable and its existence no secret (D-5).
 *
 * specs/018:
 * - a caller without `deal:financials` gets every deal and the pipeline with
 *   the money left out: no amount, currency, notes or totals (US-1, ADR-0054);
 * - a deal leaves `lead`/`qualified` for `proposal` or later only with its
 *   estimate `ready` or the gate overridden (US-3, AC-3.4).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  DEAL_MANAGE,
  authorized,
  canSeeFinancials,
  dealScope,
  requireCapability,
  type AuthzSource,
} from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { inScope, type Entity } from "../authz/conditions";
import { db } from "../lib/db";
import { Prisma } from "../lib/generated/prisma/client";
import {
  DateOnlySchema,
  EntitySchema,
  LeadSourceSchema,
  IdParams,
  PersonRefSchema,
  assertVersion,
  commonErrors,
  definedOnly,
  etag,
  fromDateOnly,
  isRecordNotFound,
  optionalText,
  pageOf,
  pageQuery,
  requireIfMatch,
  requiredText,
  skipTake,
  toDateOnly,
  versionConflict,
  type HeaderSource,
  withSource,
} from "../lib/http";
import { PROMOTED_ON_WIN } from "../companies/status";
import { requireCrmUsers } from "../lib/identities";
import { MAX_NAME, announce, clip } from "../lib/notify";
import { loadPeople } from "../lib/people";
import { deliveryOfDeal } from "../lib/projects";
import { ProblemError, notFound, unprocessable, validationHook } from "../lib/problem";
import {
  CLOSED_STAGES,
  DEAL_STAGES,
  OPEN_STAGES,
  STAGE_PROBABILITY,
  isOpenStage,
  stageTransition,
  summarisePipeline,
} from "./stages";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const StageSchema = z.enum(DEAL_STAGES);
const CurrencySchema = z.enum(["CHF", "EUR"]);
/** Integer minor units, ≥ 0, ≤ 10^13 (a safe JS integer on the wire, D-9). */
const AmountSchema = z.number().int().min(0).max(10_000_000_000_000);
/** A calendar year the board can show: wide enough for any real deal, narrow enough to be a year. */
const BoardYearSchema = z.coerce.number().int().min(2000).max(2100);

const CreateDealSchema = z
  .object({
    companyId: z.string().min(1).max(64),
    title: requiredText(200),
    // Optional: a lead often has no figure until the estimate or qualification (AC-3.2).
    amountCents: AmountSchema.nullable().optional(),
    currency: CurrencySchema,
    stage: StageSchema.optional(),
    entity: EntitySchema.optional(),
    expectedCloseDate: DateOnlySchema.nullable().optional(),
    ownerUserId: z.string().min(1).max(64).optional(),
    notes: optionalText(10_000),
    // US-7: where the lead came from; the detail names the event, the referrer or what else.
    source: LeadSourceSchema.nullable().optional(),
    sourceDetail: optionalText(200),
  })
  .strict();

const UpdateDealSchema = z
  .object({
    title: requiredText(200).optional(),
    amountCents: AmountSchema.nullable().optional(),
    currency: CurrencySchema.optional(),
    entity: EntitySchema.optional(),
    expectedCloseDate: DateOnlySchema.nullable().optional(),
    ownerUserId: z.string().min(1).max(64).optional(),
    notes: optionalText(10_000),
    source: LeadSourceSchema.nullable().optional(),
    sourceDetail: optionalText(200),
  })
  .strict();

const StageMoveSchema = z
  .object({ stage: StageSchema, lostReason: optionalText(500) })
  .strict();

const ListDealsQuery = z.object({
  q: z.string().max(200).optional(),
  stage: StageSchema.optional(),
  open: z.enum(["true", "false"]).optional(),
  // The pipeline board: open deals plus the deals won or lost this calendar year (the same
  // set `GET /pipeline` totals), so the board's Won and Lost columns match its figures.
  board: z.enum(["true"]).optional(),
  // specs/017 AC-3.6: the calendar year whose won and lost deals the board shows (this one by default).
  year: BoardYearSchema.optional(),
  companyId: z.string().max(64).optional(),
  ownerId: z.string().max(64).optional(),
  entity: EntitySchema.optional(),
  // The pipeline board loads every open deal at once (D-16).
  ...pageQuery(200),
});

const DealSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.object({ id: z.string(), name: z.string() }),
  stage: StageSchema,
  // Left out for a caller without deal:financials (specs/018 US-1); null while not yet known.
  amountCents: z.number().int().nullable().optional(),
  currency: CurrencySchema.optional(),
  entity: EntitySchema,
  source: LeadSourceSchema.nullable(),
  sourceDetail: z.string().nullable(),
  expectedCloseDate: z.string().nullable(),
  owner: PersonRefSchema,
  closedAt: z.string().nullable(),
  updatedAt: z.string(),
  // The If-Match precondition for a stage move straight from the board (ADR-0038).
  version: z.number().int(),
  // The estimate gate at a glance: null (none), requested, ready (specs/018 US-3).
  estimateState: z.enum(["requested", "ready"]).nullable(),
  /** Whether an admin overrode the estimate gate (AC-3.7). */
  estimateOverridden: z.boolean(),
});

export const DealEstimateSchema = z.object({
  estimateId: z.string(),
  name: z.string(),
  technical: PersonRefSchema,
  state: z.enum(["requested", "ready"]),
  requestedBy: PersonRefSchema,
  requestedAt: z.string(),
  readyAt: z.string().nullable(),
});

const EstimateOverrideSchema = z.object({ by: PersonRefSchema, reason: z.string(), at: z.string() });

// specs/022 (AC-3.4): what projects-api knows of the deal, on `GET /deals/{id}` alone.
const DeliverySchema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  // Typed in by accounting in the Projects tool; empty until then.
  bexioOrderId: z.string().nullable(),
});

const DealSchema = DealSummarySchema.extend({
  lostReason: z.string().nullable(),
  // Left out for a caller without deal:financials: notes often carry prices (specs/018 O3).
  notes: z.string().nullable().optional(),
  createdAt: z.string(),
  estimate: DealEstimateSchema.nullable(),
  // An admin let the deal past the estimate gate (AC-3.7); independent of `estimate`.
  estimateOverride: EstimateOverrideSchema.nullable(),
});

const DealWithDeliverySchema = DealSchema.extend({
  /** The project that carries the deal and its purchase order's Bexio order id; `null` when none does. */
  delivery: DeliverySchema.nullable(),
  /** `false` when projects-api is not configured or did not answer: `delivery` is then unknown, not absent. */
  deliveryKnown: z.boolean(),
});

/** Open deals, plus deals closed in the current UTC calendar year (D-10). */
/** The years a deal was won or lost in, newest first, with this year always offered (AC-3.6). */
async function closedYears(entity: "welld_ch" | "welld_it" | undefined): Promise<number[]> {
  const rows = await db.$queryRaw<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM "closedAt" AT TIME ZONE 'UTC')::int AS "year"
    FROM "deal"
    WHERE "closedAt" IS NOT NULL ${entity ? Prisma.sql`AND "entity" = ${entity}::"Entity"` : Prisma.empty}`;
  const years = new Set([new Date().getUTCFullYear(), ...rows.map((row) => row.year)]);
  return [...years].sort((a, b) => b - a);
}

/**
 * The board (AC-3.4, AC-3.6): every open deal, whatever its age, plus the deals won or lost
 * in one calendar year, this one unless another is asked for.
 */
function boardWhere(asked?: number): { year: number; where: Prisma.DealWhereInput } {
  const year = asked ?? new Date().getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const nextYearStart = new Date(Date.UTC(year + 1, 0, 1));
  return {
    year,
    where: {
      OR: [
        { stage: { in: [...OPEN_STAGES] } },
        { stage: { in: [...CLOSED_STAGES] }, closedAt: { gte: yearStart, lt: nextYearStart } },
      ],
    },
  };
}

const CurrencyTotalsSchema = z.object({
  currency: CurrencySchema,
  amountCents: z.number().int(),
  weightedCents: z.number().int(),
});

const PipelineSchema = z.object({
  probabilities: z.record(StageSchema, z.number()),
  year: z.number().int(),
  /** The years with won or lost deals, newest first, this year always included (the year picker). */
  years: z.array(z.number().int()),
  // `totals` is left out for a caller without deal:financials (specs/018 US-1).
  stages: z.array(
    z.object({ stage: StageSchema, count: z.number().int(), totals: z.array(CurrencyTotalsSchema).optional() }),
  ),
});

// ─── Views ───────────────────────────────────────────────────────────────────

export const withCompany = {
  company: { select: { id: true, name: true } },
  estimate: true,
} satisfies Prisma.DealInclude;
export type DealRow = Prisma.DealGetPayload<{ include: typeof withCompany }>;

type ViewSource = HeaderSource & AuthzSource;

async function toViews(c: ViewSource, rows: readonly DealRow[]) {
  const financials = canSeeFinancials(c);
  const { person } = await loadPeople(
    c,
    rows.flatMap((row) => [
      row.ownerUserId,
      row.estimate?.technicalUserId,
      row.estimate?.requestedBy,
      row.estimate?.overrideBy,
    ]),
  );
  return rows.map((row) => {
    // An override recorded before any estimate was requested leaves a row with no link.
    const link = row.estimate;
    const estimate = link && link.estimateId !== "" ? link : null;
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      stage: row.stage,
      ...(financials
        ? { amountCents: row.amountCents === null ? null : Number(row.amountCents), currency: row.currency }
        : {}),
      entity: row.entity,
      source: row.source,
      sourceDetail: row.sourceDetail,
      expectedCloseDate: toDateOnly(row.expectedCloseDate),
      owner: person(row.ownerUserId),
      closedAt: row.closedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      estimateState: estimate?.state ?? null,
      estimateOverridden: link?.overrideAt != null,
      lostReason: row.lostReason,
      ...(financials ? { notes: row.notes } : {}),
      createdAt: row.createdAt.toISOString(),
      estimate: estimate
        ? {
            estimateId: estimate.estimateId,
            name: estimate.estimateName,
            technical: person(estimate.technicalUserId),
            state: estimate.state,
            requestedBy: person(estimate.requestedBy),
            requestedAt: estimate.requestedAt.toISOString(),
            readyAt: estimate.readyAt?.toISOString() ?? null,
          }
        : null,
      estimateOverride:
        link?.overrideAt && link.overrideReason && link.overrideBy
          ? { by: person(link.overrideBy), reason: link.overrideReason, at: link.overrideAt.toISOString() }
          : null,
    };
  });
}

export async function toDealView(c: ViewSource, row: DealRow) {
  const [view] = await toViews(c, [row]);
  return view!;
}
const toView = toDealView;

// ─── Scope ───────────────────────────────────────────────────────────────────

type ScopeSource = AuthzSource;

export function assertInScope(scope: readonly Entity[], entity: Entity): void {
  if (!inScope({ entity }, scope)) {
    throw new ProblemError({
      status: 403,
      code: "out_of_scope",
      detail: "You can manage deals of your own entity only",
      extras: { entity },
    });
  }
}

// ─── Estimate gate (specs/018 AC-3.4) ────────────────────────────────────────

/**
 * Stages from which the gate applies, and the stages it guards. `lost` is in the
 * first list so lead → lost → won cannot step around it.
 */
const GATED_FROM: readonly DealRow["stage"][] = ["lead", "qualified", "lost"];
const FROM_PROPOSAL_ON: readonly DealRow["stage"][] = ["proposal", "negotiation", "won"];

/**
 * A deal leaves `lead`, `qualified` or `lost` for `proposal`, `negotiation` or
 * `won` only with its estimate `ready`, or with the gate overridden by an admin.
 * Moving to `lost` is never blocked, nor are moves among proposal, negotiation
 * and won (a deal already past qualified is never re-gated).
 */
export function assertEstimateGate(
  from: DealRow["stage"],
  to: DealRow["stage"],
  estimate: { state: "requested" | "ready"; overrideAt: Date | null } | null,
): void {
  if (!GATED_FROM.includes(from) || !FROM_PROPOSAL_ON.includes(to)) return;
  if (estimate?.state === "ready" || estimate?.overrideAt) return;
  throw new ProblemError({
    status: 409,
    code: "estimate_not_ready",
    detail: estimate
      ? "The technical estimate is not ready yet; the technical contact marks it ready in the CRM"
      : "Request a technical estimate before moving the deal to offer in preparation",
    extras: { estimateState: estimate?.state ?? null },
  });
}

// ─── Notifications (specs/019) ───────────────────────────────────────────────

const dealRef = (row: DealRow) => clip(row.title, MAX_NAME);

/** E4: the (new) owner is told, unless they did it themselves (the actor is dropped). */
async function announceOwner(c: Parameters<typeof announce>[0], row: DealRow & { company: { name: string } }) {
  await announce(c, {
    kind: "deal_owner",
    dealId: row.id,
    recipientIds: [row.ownerUserId],
    severity: "info",
    email: true,
    href: `/crm/deals/${row.id}`,
    copy: (actor) => ({
      title: `You own a deal: ${dealRef(row)}`,
      body: `${actor} made you the owner of ${dealRef(row)} (${clip(row.company.name, MAX_NAME)}).`,
    }),
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const writeErrors = {
  404: { description: "Not found" },
  409: { description: "version_conflict" },
  428: { description: "precondition_required" },
} as const;
const managing = [...authorized, requireCapability(DEAL_MANAGE)];

const listRoute = createRoute({
  method: "get",
  path: "/deals",
  tags: ["Deals"],
  summary: "List deals",
  middleware: authorized,
  request: { query: ListDealsQuery },
  responses: { 200: { description: "A page of deals", ...json(pageOf(DealSummarySchema)) }, ...commonErrors },
});

const createDealRoute = createRoute({
  method: "post",
  path: "/deals",
  tags: ["Deals"],
  summary: "Create a deal (deal:manage, entity-scoped)",
  middleware: managing,
  request: { body: { content: { "application/json": { schema: CreateDealSchema } }, required: true } },
  responses: { 201: { description: "Created", ...json(DealSchema) }, ...commonErrors },
});

const getRoute = createRoute({
  method: "get",
  path: "/deals/{id}",
  tags: ["Deals"],
  summary: "Get a deal, with the project that carries it (read live from projects-api, fail-soft)",
  middleware: authorized,
  request: { params: IdParams },
  responses: {
    200: { description: "The deal", ...json(DealWithDeliverySchema) },
    404: { description: "Not found" },
    ...commonErrors,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/deals/{id}",
  tags: ["Deals"],
  summary: "Edit a deal (deal:manage, entity-scoped, If-Match required)",
  middleware: managing,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateDealSchema } }, required: true },
  },
  responses: { 200: { description: "Updated", ...json(DealSchema) }, ...writeErrors, ...commonErrors },
});

const stageRoute = createRoute({
  method: "post",
  path: "/deals/{id}/stage",
  tags: ["Deals"],
  summary: "Move a deal to a stage (deal:manage, entity-scoped, If-Match required)",
  middleware: managing,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: StageMoveSchema } }, required: true },
  },
  responses: { 200: { description: "Moved", ...json(DealSchema) }, ...writeErrors, ...commonErrors },
});

const pipelineRoute = createRoute({
  method: "get",
  path: "/pipeline",
  tags: ["Deals"],
  summary: "Pipeline totals per stage and currency",
  middleware: authorized,
  request: { query: z.object({ entity: EntitySchema.optional(), year: BoardYearSchema.optional() }) },
  responses: { 200: { description: "The pipeline", ...json(PipelineSchema) }, ...commonErrors },
});

export const dealsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

dealsRouter.openapi(listRoute, async (c) => {
  const { q, stage, open, board, year, companyId, ownerId, entity, page, pageSize } = c.req.valid("query");
  const stageFilter: Prisma.DealWhereInput =
    board === "true"
      ? { AND: [boardWhere(year).where, ...(stage !== undefined ? [{ stage }] : [])] }
      : stage !== undefined
      ? { stage }
      : open === "true"
        ? { stage: { in: [...OPEN_STAGES] } }
        : open === "false"
          ? { stage: { in: [...CLOSED_STAGES] } }
          : {};
  const where: Prisma.DealWhereInput = {
    ...stageFilter,
    ...(companyId ? { companyId } : {}),
    ...(ownerId ? { ownerUserId: ownerId } : {}),
    ...(entity ? { entity } : {}),
    ...(q?.trim() ? { title: { contains: q.trim(), mode: "insensitive" } } : {}),
  };
  const orderBy: Prisma.DealOrderByWithRelationInput[] =
    open === "true" || board === "true"
      ? [{ expectedCloseDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }]
      : [{ updatedAt: "desc" }, { id: "asc" }];
  const [total, rows] = await Promise.all([
    db.deal.count({ where }),
    db.deal.findMany({ where, include: withCompany, orderBy, ...skipTake(page, pageSize) }),
  ]);
  const views = await toViews(c, rows);
  const items = views.map(
    ({ lostReason: _l, notes: _n, createdAt: _c, estimate: _e, estimateOverride: _o, ...summary }) => summary,
  );
  return c.json({ items, total, page, pageSize }, 200);
});

dealsRouter.openapi(createDealRoute, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const company = await db.company.findUnique({
    where: { id: body.companyId },
    select: { entity: true, archivedAt: true },
  });
  if (!company) throw unprocessable("The company does not exist", { field: "companyId" }, "company_not_found");
  if (company.archivedAt) {
    throw unprocessable("The company is archived; unarchive it first", { field: "companyId" }, "company_archived");
  }
  const entity = body.entity ?? company.entity;
  assertInScope(dealScope(c), entity);
  const stage = body.stage ?? "lead";
  if (!isOpenStage(stage)) {
    throw unprocessable("A new deal starts in an open stage", { field: "stage" }, "stage_not_open");
  }
  // Proposal and later need a ready estimate (AC-3.4), which a new deal cannot have yet.
  if (stage !== "lead" && stage !== "qualified") {
    throw unprocessable(
      "A new deal starts as a lead or qualified; it reaches proposal once its estimate is ready",
      { field: "stage" },
      "stage_requires_estimate",
    );
  }
  const ownerUserId = body.ownerUserId ?? userId;
  if (ownerUserId !== userId) {
    await requireCrmUsers(c, [{ id: ownerUserId, field: "ownerUserId" }]);
  }
  const row = await db.deal.create({
    data: {
      companyId: body.companyId,
      title: body.title,
      amountCents: body.amountCents == null ? null : BigInt(body.amountCents),
      currency: body.currency,
      stage,
      entity,
      expectedCloseDate: fromDateOnly(body.expectedCloseDate) ?? null,
      source: body.source ?? null,
      sourceDetail: body.source ? (body.sourceDetail ?? null) : null,
      ownerUserId,
      notes: body.notes ?? null,
      createdBy: userId,
      updatedBy: userId,
    },
    include: withCompany,
  });
  // E4 — a colleague made the owner at creation (D-8).
  await announceOwner(c, row);
  c.header("ETag", etag(row.version));
  return c.json(await toView(c, row), 201);
});

dealsRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  const row = await db.deal.findUnique({ where: { id }, include: withCompany });
  if (!row) throw notFound("Deal not found");
  c.header("ETag", etag(row.version));
  // projects-api is read live and fails soft: it can never fail the deal page (specs/022 AC-3.4).
  const [view, { known, delivery }] = await Promise.all([toView(c, row), deliveryOfDeal(id)]);
  return c.json({ ...view, delivery, deliveryKnown: known }, 200);
});

/**
 * The precondition, the scope check on the deal's CURRENT entity, then a
 * version CAS. Order: 428 → 404 → 403 out_of_scope → 409, so a stale editor
 * outside their scope learns the scope problem, which reloading cannot fix.
 */
async function casUpdate(
  c: HeaderSource & ScopeSource & { get(key: "userId"): string },
  id: string,
  build: (current: { stage: DealRow["stage"]; closedAt: Date | null; ownerUserId: string }) => Prisma.DealUncheckedUpdateInput,
) {
  const expected = requireIfMatch(c);
  const current = await db.deal.findUnique({
    where: { id },
    select: { version: true, entity: true, stage: true, closedAt: true, ownerUserId: true },
  });
  if (!current) throw notFound("Deal not found");
  assertInScope(dealScope(c), current.entity);
  assertVersion(current.version, expected);
  try {
    return await db.deal.update({
      where: { id, version: expected },
      data: { ...build(current), version: { increment: 1 }, updatedBy: c.get("userId") },
      include: withCompany,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      const now = await db.deal.findUnique({ where: { id }, select: { version: true } });
      if (!now) throw notFound("Deal not found");
      throw versionConflict(now.version);
    }
    throw error;
  }
}

dealsRouter.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  requireIfMatch(c);
  // Moving a deal to another entity needs scope over the destination too.
  if (body.entity !== undefined) assertInScope(dealScope(c), body.entity);
  if (body.ownerUserId !== undefined && body.ownerUserId !== c.get("userId")) {
    await requireCrmUsers(c, [{ id: body.ownerUserId, field: "ownerUserId" }]);
  }
  const { amountCents, expectedCloseDate, ...rest } = withSource(body);
  let previousOwner: string | null = null;
  const row = await casUpdate(c, id, (current) => {
    previousOwner = current.ownerUserId;
    return {
      ...definedOnly(rest),
      ...(amountCents !== undefined ? { amountCents: amountCents === null ? null : BigInt(amountCents) } : {}),
      ...(expectedCloseDate !== undefined ? { expectedCloseDate: fromDateOnly(expectedCloseDate) ?? null } : {}),
    };
  });
  // E4 — only when the owner actually changed.
  if (row.ownerUserId !== previousOwner) await announceOwner(c, row);
  c.header("ETag", etag(row.version));
  return c.json(await toView(c, row), 200);
});

dealsRouter.openapi(stageRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { stage, lostReason } = c.req.valid("json");
  const estimate = await db.dealEstimate.findUnique({
    where: { dealId: id },
    select: { state: true, overrideAt: true },
  });
  let previousStage: DealRow["stage"] | null = null;
  const row = await casUpdate(c, id, (current) => {
    assertEstimateGate(current.stage, stage, estimate);
    previousStage = current.stage;
    return stageTransition(stage, lostReason, new Date(), current);
  });
  // specs/017 AC-1.8: winning a deal makes a prospect or former client a customer. Its own
  // write, after the deal's CAS; idempotent, so a retry of the move cannot double it.
  if (previousStage !== row.stage && row.stage === "won") {
    await db.company.updateMany({
      where: { id: row.companyId, status: { in: [...PROMOTED_ON_WIN] } },
      data: { status: "customer", version: { increment: 1 }, updatedBy: c.get("userId") },
    });
  }
  // E8 — the owner hears how it ended (the actor is dropped).
  if (previousStage !== row.stage && (row.stage === "won" || row.stage === "lost")) {
    const won = row.stage === "won";
    await announce(c, {
      kind: won ? "deal_won" : "deal_lost",
      dealId: row.id,
      recipientIds: [row.ownerUserId],
      severity: won ? "success" : "warning",
      email: false,
      href: `/crm/deals/${row.id}`,
      copy: (actor) => ({
        title: `${won ? "Deal won" : "Deal lost"}: ${dealRef(row)}`,
        body: `${actor} marked ${dealRef(row)} (${clip(row.company.name, MAX_NAME)}) as ${won ? "won" : "lost"}.`,
      }),
    });
  }
  c.header("ETag", etag(row.version));
  return c.json(await toView(c, row), 200);
});

dealsRouter.openapi(pipelineRoute, async (c) => {
  const { entity, year: asked } = c.req.valid("query");
  const { year, where } = boardWhere(asked);
  const deals = await db.deal.findMany({
    where: { ...where, ...(entity ? { entity } : {}) },
    select: { stage: true, currency: true, amountCents: true },
  });
  const stages = summarisePipeline(deals);
  return c.json(
    {
      probabilities: { ...STAGE_PROBABILITY },
      year,
      years: await closedYears(entity),
      stages: canSeeFinancials(c) ? stages : stages.map(({ totals: _t, ...counts }) => counts),
    },
    200,
  );
});
