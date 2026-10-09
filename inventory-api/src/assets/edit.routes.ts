/**
 * `PATCH /assets/{id}` (T13, specs/015-hardware-inventory; AC-1.9, AC-3.6,
 * AC-5.9, AC-10.1).
 *
 * Either capability reaches the route; WHICH FIELDS depends on the capability:
 * `supplier` and `invoiceRef` for either, everything else for `asset:manage`
 * over the asset's entity (an accountant-only caller sending anything else is
 * 403). An asset outside every scope the caller holds is 404 (ADR-0014).
 * `entity` and `currency` are immutable and refused as unknown fields (422).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { authorized, requireCapability, ASSET_MANAGE, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { ENTITIES, assetInScope, scopeFor } from "../authz/conditions";
import { forbidden, notFound, validationHook } from "../lib/problem";
import { EditBodySchema, IMMUTABLE_FIELDS, MANAGER_ONLY_FIELDS } from "./edit.schemas";
import { editAsset } from "./edit.repo";
import { findAsset, } from "./read.repo";
import { project } from "./read.routes";
import { IdParamSchema } from "./read.schemas";
import { AssetViewSchema } from "./register.schemas";

const route = createRoute({
  method: "patch",
  path: "/assets/{id}",
  tags: ["Assets"],
  summary: "Edit an asset's details (entity and currency are immutable)",
  middleware: [...authorized, requireCapability(ASSET_MANAGE, LEDGER_MANAGE)],
  request: {
    params: IdParamSchema,
    body: { content: { "application/json": { schema: EditBodySchema } }, required: true },
  },
  responses: {
    200: { description: "The updated asset", content: { "application/json": { schema: AssetViewSchema } } },
    403: { description: "Field outside the caller's capability" },
    404: { description: "Unknown or out of scope" },
    409: { description: "asset_disposed | fiscal_year_closed | serial_conflict" },
    422: { description: "Invalid, unknown or immutable field" },
  },
});

interface IssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
  readonly keys?: readonly string[];
}

/** `strict()` reports unknown keys on the object; name each key so `field` is useful. */
const editHook = (
  result: { success: true } | { success: false; error: { issues: readonly IssueLike[] } },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const issues = result.error.issues.flatMap((issue): IssueLike[] =>
    issue.code === "unrecognized_keys" && issue.keys
      ? issue.keys.map((key) => ({
          path: [...issue.path, key],
          message: (IMMUTABLE_FIELDS as readonly string[]).includes(key)
            ? "is immutable"
            : "is not an editable field",
        }))
      : [issue],
  );
  return validationHook({ success: false, error: { issues } }, c);
};

export const assetEditRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: editHook,
});

const union = <T extends string>(a: readonly T[], b: readonly T[]): T[] =>
  (ENTITIES as readonly string[]).filter((e) => a.includes(e as T) || b.includes(e as T)) as T[];

assetEditRouter.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { permissions, entity: callerEntity } = c.get("authz");
  const assetScope = scopeFor(permissions, "asset", "manage", callerEntity);
  const ledgerScope = scopeFor(permissions, "ledger", "manage", callerEntity);

  const row = await findAsset(id);
  if (!row || !assetInScope(row, union(assetScope, ledgerScope))) throw notFound("Asset not found");

  const needsManager = MANAGER_ONLY_FIELDS.some((field) => body[field] !== undefined);
  if (needsManager && !assetInScope(row, assetScope)) {
    throw forbidden("Only an inventory manager may change these fields");
  }

  await editAsset({ id, body, actor: { userId: c.get("userId"), email: c.get("email") } });

  const fresh = await findAsset(id);
  if (!fresh) throw notFound("Asset not found");
  const [view] = await project([fresh], c.req.header("Authorization")!, ledgerScope, true);
  return c.json(view!, 200);
});
