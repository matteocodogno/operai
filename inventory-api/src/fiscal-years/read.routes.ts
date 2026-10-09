/**
 * `GET /fiscal-years?entity` and `GET /fiscal-years/{entity}/{year}` (T19,
 * specs/015-hardware-inventory; AC-8.1..AC-8.3, ADR-0046).
 *
 * `ledger:manage` with entity scope: capability absent -> 403 (guard); an entity
 * outside the caller's ledger scope, or a year the entity has no figures for
 * (before its first year, or past the current one) -> 404 (ADR-0014).
 *
 * Open years are derived, closed years are read from the stored rows - see
 * rollForward.ts. `closable` (list only) = the previous year is closed, or this
 * is the entity's first year.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor, type Entity } from "../authz/conditions";
import { db } from "../lib/db";
import { notFound, validationHook } from "../lib/problem";
import { resolveIdentities, type Identity } from "../lib/identities";
import { formatDate } from "../depreciation/rules.schemas";
import { loadEntityContext, ruleResolver, toRollAsset, type EntityContext } from "./read.repo";
import {
  CURRENCY,
  FiscalYearViewSchema,
  ListQuerySchema,
  ViewParamsSchema,
  YearsListSchema,
} from "./read.schemas";
import {
  buildStatement,
  firstYearOf,
  horizonYear,
  isClosable,
  type Lines,
  type Statement,
} from "./rollForward";

const guards = [...authorized, requireCapability(LEDGER_MANAGE)];

const listRoute = createRoute({
  method: "get",
  path: "/fiscal-years",
  tags: ["Fiscal years"],
  summary: "The years of an entity, open and closed, and which one can be closed",
  middleware: guards,
  request: { query: ListQuerySchema },
  responses: {
    200: { description: "Years, oldest first", content: { "application/json": { schema: YearsListSchema } } },
    403: { description: "ledger:manage required" },
    404: { description: "Entity outside the caller's scope" },
  },
});

const viewRoute = createRoute({
  method: "get",
  path: "/fiscal-years/{entity}/{year}",
  tags: ["Fiscal years"],
  summary: "The roll-forward of one entity-year (provisional while open)",
  middleware: guards,
  request: { params: ViewParamsSchema },
  responses: {
    200: { description: "The roll-forward", content: { "application/json": { schema: FiscalYearViewSchema } } },
    403: { description: "ledger:manage required" },
    404: { description: "Out of scope, or not a year of this entity" },
  },
});

export const fiscalYearReadRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

export const currentYear = (): number => new Date().getUTCFullYear();

const yearsContext = (ctx: EntityContext) => ({
  assets: ctx.assets,
  stored: ctx.stored,
  closedYears: ctx.fiscalYears.map((f) => f.year),
  lastClosedYear: ctx.lastClosedYear,
});

/** The lines of a year: the closed row's own when it has one, else the sum of the rows. */
export function statementOf(ctx: EntityContext, year: number): Statement {
  const statement = buildStatement({
    assets: ctx.assets.map(toRollAsset),
    rule: ruleResolver(ctx),
    stored: ctx.stored,
    lastClosedYear: ctx.lastClosedYear,
    year,
  });
  const closedRow = ctx.fiscalYears.find((f) => f.year === year);
  if (closedRow) {
    statement.lines = {
      openingCents: closedRow.openingCents,
      disposalsCents: closedRow.disposalsCents,
      purchasesCents: closedRow.purchasesCents,
      depreciationCents: closedRow.depreciationCents,
      closingCents: closedRow.closingCents,
    };
  }
  return statement;
}

/**
 * The `FiscalYearView`, or null when `year` is not a year of this entity (the
 * route answers 404). Shared with the close, which returns the same view.
 */
export async function fiscalYearView(entity: Entity, year: number, authorization: string) {
  const ctx = await loadEntityContext(db, entity);
  const first = firstYearOf(yearsContext(ctx));
  if (first === null || year < first || year > horizonYear(ctx.lastClosedYear, currentYear())) {
    return null;
  }

  const { lines, rows } = statementOf(ctx, year);
  const closed = ctx.lastClosedYear !== null && year <= ctx.lastClosedYear;
  const closedRow = ctx.fiscalYears.find((f) => f.year === year);

  const assetsById = new Map(ctx.assets.map((a) => [a.id, a]));
  const listed = rows
    .map((r) => ({ r, a: assetsById.get(r.assetId) }))
    .filter((x): x is { r: (typeof rows)[number]; a: NonNullable<typeof x.a> } => x.a !== undefined)
    .sort(
      (x, y) =>
        x.a.purchaseDate.getTime() - y.a.purchaseDate.getTime() ||
        (x.a.description < y.a.description ? -1 : x.a.description > y.a.description ? 1 : 0) ||
        (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0),
    );

  const holderIds = [...new Set(listed.flatMap(({ a }) => (a.holderUserId ? [a.holderUserId] : [])))];
  const identities = await resolveIdentities(authorization, holderIds);
  const identity = (id: string): Identity => identities.get(id) ?? { id, name: null, status: "unknown" };

  return {
    entity,
    year,
    currency: CURRENCY[entity],
    status: closed ? ("closed" as const) : ("open" as const),
    closedAt: closedRow ? closedRow.closedAt.toISOString() : null,
    rollForward: lines satisfies Lines,
    assets: listed.map(({ r, a }) => ({
      assetId: a.id,
      purchaseDate: formatDate(a.purchaseDate),
      description: a.description,
      serialNumber: a.serialNumber,
      holder: a.holderUserId ? identity(a.holderUserId) : null,
      purchasePriceCents: a.purchasePriceCents,
      openingCents: r.openingCents,
      purchaseCents: r.purchaseCents,
      depreciationCents: r.depreciationCents,
      disposalCents: r.disposalCents,
      closingCents: r.closingCents,
    })),
  };
}

fiscalYearReadRouter.openapi(listRoute, async (c) => {
  const { entity } = c.req.valid("query");
  const { permissions, entity: callerEntity } = c.get("authz");
  if (!assetInScope({ entity }, scopeFor(permissions, "ledger", "manage", callerEntity))) {
    throw notFound("Not found");
  }

  const ctx = await loadEntityContext(db, entity);
  const first = firstYearOf(yearsContext(ctx));
  if (first === null) return c.json({ years: [] }, 200);

  const closedAt = new Map(ctx.fiscalYears.map((f) => [f.year, f.closedAt.toISOString()]));
  const last = horizonYear(ctx.lastClosedYear, currentYear());
  const years = [];
  for (let year = first; year <= last; year++) {
    const closed = ctx.lastClosedYear !== null && year <= ctx.lastClosedYear;
    years.push({
      year,
      status: closed ? ("closed" as const) : ("open" as const),
      closedAt: closedAt.get(year) ?? null,
      closable: isClosable(year, ctx.lastClosedYear, first, currentYear()),
    });
  }
  return c.json({ years }, 200);
});

fiscalYearReadRouter.openapi(viewRoute, async (c) => {
  const { entity, year } = c.req.valid("param");
  const { permissions, entity: callerEntity } = c.get("authz");
  if (!assetInScope({ entity }, scopeFor(permissions, "ledger", "manage", callerEntity))) {
    throw notFound("Not found");
  }
  const view = await fiscalYearView(entity, year, c.req.header("Authorization")!);
  if (!view) throw notFound("Not found");
  return c.json(view, 200);
});
