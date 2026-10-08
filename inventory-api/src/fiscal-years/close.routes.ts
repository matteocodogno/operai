/**
 * `POST /fiscal-years/{entity}/{year}/close` (T20, specs/015-hardware-inventory;
 * AC-8.4..AC-8.7, ADR-0046).
 *
 * `ledger:manage` with entity scope: capability absent -> 403 (guard); entity
 * outside the caller's ledger scope -> 404 (ADR-0014). Success is 201 with the
 * closed `FiscalYearView` - the same view `GET` returns from then on. There is
 * deliberately no reopen, update or delete route for a fiscal year (AC-8.7).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { closeYear } from "./close.repo";
import { fiscalYearView } from "./read.routes";
import { FiscalYearViewSchema, ViewParamsSchema } from "./read.schemas";

export const fiscalYearCloseRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

const route = createRoute({
  method: "post",
  path: "/fiscal-years/{entity}/{year}/close",
  tags: ["Fiscal years"],
  summary: "Close a fiscal year (irreversible, strictly in sequence)",
  middleware: [...authorized, requireCapability(LEDGER_MANAGE)],
  request: { params: ViewParamsSchema },
  responses: {
    201: { description: "The closed year", content: { "application/json": { schema: FiscalYearViewSchema } } },
    403: { description: "ledger:manage required" },
    404: { description: "Entity outside the caller's scope" },
    409: { description: "previous_year_open | already_closed | nothing_to_close | year_in_future (after the current UTC year; carries `year`)" },
  },
});

fiscalYearCloseRouter.openapi(route, async (c) => {
  const { entity, year } = c.req.valid("param");
  const { permissions, entity: callerEntity } = c.get("authz");
  if (!assetInScope({ entity }, scopeFor(permissions, "ledger", "manage", callerEntity))) {
    throw notFound("Not found");
  }

  await closeYear({ entity, year, actor: { userId: c.get("userId"), email: c.get("email") } });

  const view = await fiscalYearView(entity, year, c.req.header("Authorization")!);
  // The year was just closed, so it is inside the entity's range by construction.
  if (!view) throw new Error(`closed fiscal year ${entity} ${year} is not viewable`);
  return c.json(view, 201);
});
