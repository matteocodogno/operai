/**
 * `GET /assets/{id}/history` (T22, specs/015-hardware-inventory; AC-11.3,
 * AC-11.4).
 *
 * Either capability reads, within its entity scope. Like `GET /assets/{id}`
 * the route has no capability gate: a caller with neither capability, an asset
 * outside their scope and an unknown id are all the same 404 (ADR-0014,
 * AC-4.3), so a grant-less user learns nothing about someone else's device.
 *
 * Nothing is filtered by capability. The log holds the purchase price (an
 * inventory manager sees it, AC-9.2), the disposal's date, reason and sale
 * price (on `AssetView.disposal` for both), status and holder changes - and no
 * book value, rule or schedule, which are never recorded on an asset event.
 *
 * Actor ids and the user ids in `holder` / `assignee` changes are resolved to
 * identities LIVE (ADR-0039), failing soft to `unknown`; `system:*` actors
 * are `system` and never sent to `auth`. A renamed or deleted person is never
 * frozen into the history.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { ENTITIES, assetInScope, scopeFor, type Entity } from "../authz/conditions";
import { notFound, validationHook } from "../lib/problem";
import { resolveIdentities, type Identity } from "../lib/identities";
import { findAsset } from "../assets/read.repo";
import { IdParamSchema } from "../assets/read.schemas";
import { eventChanges, type ChangeValue } from "./record";
import { findAssetEvents } from "./history.repo";
import { HistoryResponseSchema } from "./history.schemas";

/** The change fields whose values are raw auth user ids in the stored events. */
const USER_FIELDS: ReadonlySet<string> = new Set(["holder", "assignee"]);

const route = createRoute({
  method: "get",
  path: "/assets/{id}/history",
  tags: ["Assets"],
  summary: "Every event of an asset, oldest first (either capability)",
  middleware: authorized,
  request: { params: IdParamSchema },
  responses: {
    200: { description: "The history", content: { "application/json": { schema: HistoryResponseSchema } } },
    404: { description: "Unknown, out of scope, or the caller holds no capability" },
  },
});

export const historyRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

const union = (a: readonly Entity[], b: readonly Entity[]): Entity[] =>
  ENTITIES.filter((e) => a.includes(e) || b.includes(e));

historyRouter.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const { permissions, entity } = c.get("authz");
  const readable = union(
    scopeFor(permissions, "asset", "manage", entity),
    scopeFor(permissions, "ledger", "manage", entity),
  );

  const asset = await findAsset(id);
  if (!asset || !assetInScope(asset, readable)) throw notFound("Asset not found");

  const rows = await findAssetEvents(id);
  const events = rows.map((row) => ({
    row,
    changes: eventChanges(row.oldValue, row.newValue),
  }));

  const ids = new Set<string>();
  for (const { row, changes } of events) {
    ids.add(row.actorUserId);
    for (const ch of changes) {
      if (!USER_FIELDS.has(ch.field)) continue;
      if (typeof ch.from === "string") ids.add(ch.from);
      if (typeof ch.to === "string") ids.add(ch.to);
    }
  }
  const identities = await resolveIdentities(c.req.header("Authorization")!, [...ids]);
  const identity = (userId: string): Identity =>
    identities.get(userId) ?? { id: userId, name: null, status: "unknown" };
  const value = (field: string, v: ChangeValue): ChangeValue | Identity =>
    USER_FIELDS.has(field) && typeof v === "string" ? identity(v) : v;

  return c.json(
    {
      events: events.map(({ row, changes }) => ({
        id: row.id,
        action: row.action,
        actor: identity(row.actorUserId),
        at: row.createdAt.toISOString(),
        changes: changes.map((ch) => ({
          field: ch.field,
          from: value(ch.field, ch.from),
          to: value(ch.field, ch.to),
        })),
      })),
    },
    200,
  );
});
