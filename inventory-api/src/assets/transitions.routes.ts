/**
 * Status transitions (T14, specs/015-hardware-inventory; AC-1.8, AC-3.1..3.5):
 * `POST /assets/{id}/{receive|return|repair|repair-done|lost|found}`.
 *
 * `asset:manage` over the asset's entity. Capability absent -> 403 (guard); an
 * asset outside the caller's asset scope, or unknown -> 404 (ADR-0014). The
 * state machine lives in transitions.repo.ts. The response is the updated
 * `AssetView`, with `ledger` when the caller also holds `ledger:manage` over
 * the entity (same projection as the reads).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, ASSET_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { applyTransition, type Transition } from "./transitions.repo";
import { findAsset } from "./read.repo";
import { project } from "./read.routes";
import { IdParamSchema } from "./read.schemas";
import { AssetViewSchema } from "./register.schemas";

export const assetTransitionsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

const SUMMARY: Record<Transition, string> = {
  receive: "Mark an ordered asset received (-> in_stock)",
  return: "Record an assigned asset's return (-> in_stock, no holder)",
  repair: "Send an in_stock or assigned asset for repair",
  "repair-done": "Mark the repair finished (-> assigned if held, else in_stock)",
  lost: "Mark an asset lost (clears the holder)",
  found: "Mark a lost asset found (-> in_stock)",
};

for (const kind of Object.keys(SUMMARY) as Transition[]) {
  const route = createRoute({
    method: "post",
    path: `/assets/{id}/${kind}`,
    tags: ["Assets"],
    summary: SUMMARY[kind],
    middleware: [...authorized, requireCapability(ASSET_MANAGE)],
    request: { params: IdParamSchema },
    responses: {
      200: { description: "The updated asset", content: { "application/json": { schema: AssetViewSchema } } },
      404: { description: "Unknown or out of scope" },
      409: { description: "invalid_transition | assignment_pending | asset_disposed" },
    },
  });

  assetTransitionsRouter.openapi(route, async (c) => {
    const { id } = c.req.valid("param");
    const { permissions, entity } = c.get("authz");
    const row = await findAsset(id);
    if (!row || !assetInScope(row, scopeFor(permissions, "asset", "manage", entity))) {
      throw notFound("Asset not found");
    }
    await applyTransition({ id, kind, actor: { userId: c.get("userId"), email: c.get("email") } });

    const fresh = await findAsset(id);
    if (!fresh) throw notFound("Asset not found");
    const ledgerScope = scopeFor(permissions, "ledger", "manage", entity);
    const [view] = await project([fresh], c.req.header("Authorization")!, ledgerScope, true);
    return c.json(view!, 200);
  });
}
