/**
 * `GET /assets`, `GET /assets/{id}` and `GET /suppliers` (T12, specs/015-hardware-inventory;
 * AC-3.7, AC-3.8, AC-4.3, AC-5.7, AC-5.8, AC-9.2, AC-10.3, AC-12.10).
 *
 * Either capability reads. What comes back depends on which:
 *   - everyone who can read an asset sees its purchase price;
 *   - `ledger` is attached ONLY for assets inside the caller's `ledger:manage`
 *     entity scope — `{ bookValueCents }` on list items, the full schedule on
 *     the detail. An inventory manager's response has no `ledger` key at all.
 *
 * Denials (ADR-0014): the list needs a capability (403). The detail does NOT
 * use the capability gate: a caller with neither capability, or an asset
 * outside their scope, or an unknown id, are all the same 404, so a grant-less
 * user learns nothing about someone else's device (AC-4.3).
 *
 * `GET /suppliers` lists the supplier names already on assets the caller can
 * read, for the supplier field's suggestions. It takes no parameter: the
 * client filters the list itself, so what is being typed never reaches the
 * server (ADR-0041 posture). Same gate and same entity scope as the list.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized, requireCapability, ASSET_MANAGE, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { ENTITIES, assetInScope, scopeFor, type Entity } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { resolveIdentities } from "../lib/identities";
import { resolveRule } from "../depreciation/resolveRule";
import { formatDate } from "../depreciation/rules.schemas";
import {
  findAsset,
  findAssetPage,
  findLastClosedYears,
  findPendingAssignments,
  findRules,
  findStoredFigures,
  findSuppliers,
} from "./read.repo";
import {
  IdParamSchema,
  ListQuerySchema,
  ListResponseSchema,
  encodeCursor,
} from "./read.schemas";
import { AssetViewSchema } from "./register.schemas";
import { buildLedger, bookValueAt } from "./ledgerView";
import { identityIdsOf, toAssetView, type AssetRow } from "./view";

const listRoute = createRoute({
  method: "get",
  path: "/assets",
  tags: ["Assets"],
  summary: "List assets (either capability), newest purchase first",
  middleware: [...authorized, requireCapability(ASSET_MANAGE, LEDGER_MANAGE)],
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "A page of assets and the cursor for the next one",
      content: { "application/json": { schema: ListResponseSchema } },
    },
    403: { description: "Neither asset:manage nor ledger:manage" },
    422: { description: "Invalid filter, limit or cursor" },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/assets/{id}",
  tags: ["Assets"],
  summary: "One asset (either capability)",
  middleware: authorized,
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: "The asset",
      content: { "application/json": { schema: AssetViewSchema } },
    },
    404: { description: "Unknown, out of scope, or the caller holds no capability" },
  },
});

const suppliersRoute = createRoute({
  method: "get",
  path: "/suppliers",
  tags: ["Assets"],
  summary: "Supplier names already used in the caller's entity scope (either capability)",
  middleware: [...authorized, requireCapability(ASSET_MANAGE, LEDGER_MANAGE)],
  responses: {
    200: {
      description: "Distinct supplier names, alphabetical",
      content: {
        "application/json": { schema: z.object({ suppliers: z.array(z.string()) }) },
      },
    },
    403: { description: "Neither asset:manage nor ledger:manage" },
  },
});

export const assetReadRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

const union = (a: readonly Entity[], b: readonly Entity[]): Entity[] =>
  ENTITIES.filter((e) => a.includes(e) || b.includes(e));

/** Builds the views for `rows` for this caller; `full` = detail (schedule), else list (book value). */
export async function project(
  rows: readonly AssetRow[],
  authorization: string,
  ledgerScope: readonly Entity[],
  full: boolean,
) {
  if (rows.length === 0) return [];
  const pendings = await findPendingAssignments(rows.map((r) => r.id));
  const identities = await resolveIdentities(
    authorization,
    identityIdsOf(rows, [...pendings.values()]),
  );

  const ledgerRows = rows.filter((r) => assetInScope(r, ledgerScope));
  const ledgerEntities = ENTITIES.filter((e) => ledgerRows.some((r) => r.entity === e));
  const [rulesByEntity, closedByEntity, figures] = await Promise.all([
    findRules(ledgerEntities),
    findLastClosedYears(ledgerEntities),
    findStoredFigures(ledgerRows.map((r) => r.id)),
  ]);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return rows.map((row) => {
    const view = toAssetView(row, { identities, pending: pendings.get(row.id) ?? null });
    if (!assetInScope(row, ledgerScope)) return view;

    const rule = resolveRule(rulesByEntity.get(row.entity) ?? [], row.entity, row.purchaseDate);
    if (!rule) {
      // Unreachable while the launch rules exist and purchases start in 2000;
      // an unreadable ledger must not take the whole list down.
      console.error(`[assets] no depreciation rule in force for asset ${row.id} (${formatDate(row.purchaseDate)})`);
      return view;
    }
    const input = {
      asset: {
        entity: row.entity,
        priceCents: row.purchasePriceCents,
        purchaseDate: row.purchaseDate,
        disposedOn: row.disposedOn,
        legacyImported: row.legacyImported,
      },
      rule,
      stored: figures.get(row.id) ?? [],
      lastClosedYear: closedByEntity.get(row.entity) ?? null,
      today,
    };
    return {
      ...view,
      ledger: full ? buildLedger(input) : { bookValueCents: bookValueAt(input) },
    };
  });
}

assetReadRouter.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");
  const { permissions, entity } = c.get("authz");
  const readable = union(
    scopeFor(permissions, "asset", "manage", entity),
    scopeFor(permissions, "ledger", "manage", entity),
  );
  const ledgerScope = scopeFor(permissions, "ledger", "manage", entity);

  const page = await findAssetPage(readable, query);
  const items = await project(page.rows, c.req.header("Authorization")!, ledgerScope, false);
  const last = page.rows[page.rows.length - 1];
  return c.json(
    {
      items,
      nextCursor:
        page.hasMore && last
          ? encodeCursor({ purchaseDate: formatDate(last.purchaseDate), id: last.id })
          : null,
    },
    200,
  );
});

assetReadRouter.openapi(detailRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { permissions, entity } = c.get("authz");
  const ledgerScope = scopeFor(permissions, "ledger", "manage", entity);
  const readable = union(scopeFor(permissions, "asset", "manage", entity), ledgerScope);

  const row = await findAsset(id);
  if (!row || !assetInScope(row, readable)) throw notFound("Asset not found");

  const [view] = await project([row], c.req.header("Authorization")!, ledgerScope, true);
  return c.json(view!, 200);
});

assetReadRouter.openapi(suppliersRoute, async (c) => {
  const { permissions, entity } = c.get("authz");
  const readable = union(
    scopeFor(permissions, "asset", "manage", entity),
    scopeFor(permissions, "ledger", "manage", entity),
  );
  return c.json({ suppliers: await findSuppliers(readable) }, 200);
});
