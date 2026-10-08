/**
 * `GET /rules` and `POST /rules` (T10, specs/015-hardware-inventory; AC-6.1..6.5).
 *
 * `ledger:manage` with entity scope on both. Capability absent -> 403 (guard);
 * entity outside the caller's ledger scope -> 404 (ADR-0014). There is no
 * update or delete route: a rule is only ever appended (AC-6.5).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { resolveIdentities, type Identity } from "../lib/identities";
import type { DepreciationRule } from "../lib/generated/prisma/client";
import { createRule, inForce, listRulesFor } from "./rules.repo";
import {
  RuleInputSchema,
  RuleSchema,
  RulesListSchema,
  RulesQuerySchema,
  formatDate,
  parseIsoDate,
} from "./rules.schemas";

const guards = [...authorized, requireCapability(LEDGER_MANAGE)];

const listRoute = createRoute({
  method: "get",
  path: "/rules",
  tags: ["Rules"],
  summary: "Depreciation rules of an entity, past, current and future",
  middleware: guards,
  request: { query: RulesQuerySchema },
  responses: {
    200: {
      description: "Rules (newest effective date first) and the id in force today",
      content: { "application/json": { schema: RulesListSchema } },
    },
    403: { description: "ledger:manage required" },
    404: { description: "Entity outside the caller's scope" },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/rules",
  tags: ["Rules"],
  summary: "Append a depreciation rule",
  middleware: guards,
  request: {
    body: { content: { "application/json": { schema: RuleInputSchema } }, required: true },
  },
  responses: {
    201: {
      description: "The new rule",
      content: { "application/json": { schema: RuleSchema } },
    },
    403: { description: "ledger:manage required" },
    404: { description: "Entity outside the caller's scope" },
    409: { description: "fiscal_year_closed" },
    422: { description: "Validation failed; `field` names the member" },
  },
});

const toRule = (row: DepreciationRule, identities: ReadonlyMap<string, Identity>) => ({
  id: row.id,
  entity: row.entity,
  effectiveFrom: formatDate(row.effectiveFrom),
  usefulLifeYears: row.usefulLifeYears,
  firstYearShare: row.firstYearShare,
  lowValueThresholdCents: row.lowValueThresholdCents,
  residualCents: row.residualCents,
  createdBy: identities.get(row.createdByUserId) ?? {
    id: row.createdByUserId,
    name: null,
    status: "unknown" as const,
  },
  createdAt: row.createdAt.toISOString(),
});

export const rulesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

rulesRouter.openapi(listRoute, async (c) => {
  const { entity } = c.req.valid("query");
  const { permissions, entity: callerEntity } = c.get("authz");
  if (!assetInScope({ entity }, scopeFor(permissions, "ledger", "manage", callerEntity))) {
    throw notFound("Not found");
  }

  const rows = await listRulesFor(entity);
  const current = inForce(rows, entity);
  const identities = await resolveIdentities(
    c.req.header("Authorization")!,
    rows.map((r) => r.createdByUserId),
  );
  return c.json(
    {
      rules: rows.map((r) => toRule(r, identities)),
      // The seeded launch rule (effective 2000-01-01) guarantees one exists.
      inForceId: current?.id ?? "",
    },
    200,
  );
});

rulesRouter.openapi(createRoute_, async (c) => {
  const body = c.req.valid("json");
  const { permissions, entity: callerEntity } = c.get("authz");
  if (
    !assetInScope(body, scopeFor(permissions, "ledger", "manage", callerEntity))
  ) {
    throw notFound("Not found");
  }

  const row = await createRule({
    entity: body.entity,
    // Validated by the schema; never null here.
    effectiveFrom: parseIsoDate(body.effectiveFrom)!,
    usefulLifeYears: body.usefulLifeYears,
    firstYearShare: body.firstYearShare,
    lowValueThresholdCents: body.lowValueThresholdCents,
    residualCents: body.residualCents,
    actor: { userId: c.get("userId"), email: c.get("email") },
  });
  const identities = await resolveIdentities(c.req.header("Authorization")!, [
    row.createdByUserId,
  ]);
  return c.json(toRule(row, identities), 201);
});
