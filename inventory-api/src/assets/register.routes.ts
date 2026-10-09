/**
 * `POST /assets` (T11, specs/015-hardware-inventory; AC-1.1..1.7, AC-10.2).
 *
 * `asset:manage`. Capability absent -> 403 (guard); entity outside the caller's
 * asset scope -> 403 (the entity is a body value, not an addressed record, so
 * there is no existence to hide — plan.md API table). The response carries no
 * `ledger`: a registering manager sees the purchase price and never a schedule.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized, requireCapability, ASSET_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { forbidden, unprocessable, validationHook } from "../lib/problem";
import { parseIsoDate } from "../depreciation/rules.schemas";
import { RegisterBodySchema, AssetViewSchema } from "./register.schemas";
import { registerAssets } from "./register.repo";
import { toAssetView } from "./view";

const route = createRoute({
  method: "post",
  path: "/assets",
  tags: ["Assets"],
  summary: "Register one or more assets from a single purchase",
  middleware: [...authorized, requireCapability(ASSET_MANAGE)],
  request: {
    body: { content: { "application/json": { schema: RegisterBodySchema } }, required: true },
  },
  responses: {
    201: {
      description: "The registered assets, in unit order",
      content: { "application/json": { schema: z.object({ assets: z.array(AssetViewSchema) }) } },
    },
    403: { description: "asset:manage required, or entity out of scope" },
    409: { description: "serial_conflict | fiscal_year_closed" },
    422: { description: "Validation failed (`field`), or serial_count_mismatch" },
  },
});

export const assetRegisterRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

assetRegisterRouter.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const { permissions, entity: callerEntity } = c.get("authz");

  if (!assetInScope(body, scopeFor(permissions, "asset", "manage", callerEntity))) {
    throw forbidden("You may not register assets for this entity");
  }

  const serialNumbers = body.serialNumbers ?? [];
  if (serialNumbers.length !== 0 && serialNumbers.length !== body.quantity) {
    throw unprocessable(
      `serialNumbers must be omitted or list exactly ${body.quantity} serial number(s), one per unit`,
      { field: "serialNumbers" },
      "serial_count_mismatch",
    );
  }
  // Every unit needs a positive price (a database CHECK), so the total must
  // cover at least one cent per unit.
  if (body.totalPriceCents < body.quantity) {
    throw unprocessable("totalPriceCents must be at least one cent per unit", {
      field: "totalPriceCents",
    });
  }

  const rows = await registerAssets({
    body,
    purchaseDate: parseIsoDate(body.purchaseDate)!,
    serialNumbers,
    actor: { userId: c.get("userId"), email: c.get("email") },
  });

  // A new asset has no holder and no pending assignment, so there is nothing
  // for auth to resolve.
  const identities = new Map();
  const assets = rows.map((row) =>
    toAssetView({ ...row, invoiceFile: null } satisfies Parameters<typeof toAssetView>[0], {
      identities,
      pending: null,
    }),
  );
  return c.json({ assets }, 201);
});
