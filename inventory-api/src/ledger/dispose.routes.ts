/**
 * `POST /assets/{id}/dispose` (T18, specs/015-hardware-inventory; AC-7.1..AC-7.6).
 *
 * `ledger:manage` over the asset's entity: capability absent (including an
 * inventory-manager-only caller) -> 403 (guard); unknown or out-of-scope asset
 * -> 404 (ADR-0014). Irreversible: there is no route that restores a status.
 * The response is the updated `AssetView` with `ledger` (the caller holds
 * `ledger:manage` for this entity by construction).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { findAsset } from "../assets/read.repo";
import { project } from "../assets/read.routes";
import { IdParamSchema } from "../assets/read.schemas";
import { AssetViewSchema } from "../assets/register.schemas";
import { disposeAsset } from "./dispose.repo";
import { DisposeBodySchema } from "./dispose.schemas";

export const disposeRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

const route = createRoute({
  method: "post",
  path: "/assets/{id}/dispose",
  tags: ["Ledger"],
  summary: "Dispose of an asset (irreversible)",
  middleware: [...authorized, requireCapability(LEDGER_MANAGE)],
  request: {
    params: IdParamSchema,
    body: { content: { "application/json": { schema: DisposeBodySchema } }, required: true },
  },
  responses: {
    200: { description: "The disposed asset", content: { "application/json": { schema: AssetViewSchema } } },
    403: { description: "ledger:manage required" },
    404: { description: "Unknown or out of scope" },
    409: { description: "asset_disposed | assignment_pending | fiscal_year_closed" },
    422: { description: "disposed_before_purchase | sale_price_not_allowed | validation" },
  },
});

disposeRouter.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { permissions, entity } = c.get("authz");
  const ledgerScope = scopeFor(permissions, "ledger", "manage", entity);

  const row = await findAsset(id);
  if (!row || !assetInScope(row, ledgerScope)) throw notFound("Asset not found");

  await disposeAsset({ id, body, actor: { userId: c.get("userId"), email: c.get("email") } });

  const fresh = await findAsset(id);
  if (!fresh) throw notFound("Asset not found");
  const [view] = await project([fresh], c.req.header("Authorization")!, ledgerScope, true);
  return c.json(view!, 200);
});
