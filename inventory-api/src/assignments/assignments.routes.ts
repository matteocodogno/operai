/**
 * Assignments, manager side (T15, specs/015-hardware-inventory; AC-2.1, AC-2.2,
 * AC-2.5, AC-2.10): `POST /assets/{id}/assignments` and
 * `POST /assignments/{id}/cancel`.
 *
 * `asset:manage` over the asset's entity (403 without the capability, 404 for an
 * asset or assignment outside the scope). The assignee must resolve to an
 * `active` identity (422 `unknown_user`). Creating an assignment changes
 * nothing on the asset: it stays `in_stock` until the assignee confirms (T16).
 *
 * `assignmentHooks.afterCommit` is called once the write has committed and can
 * never fail the request (see `runAfterCommit`). It carries the notification
 * push (T17, `lib/notify.ts`); `/me` confirm/decline (T16) call the same seam.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { authorized, requireCapability, ASSET_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assetInScope, scopeFor } from "../authz/conditions";
import { notFound, unprocessable, validationHook } from "../lib/problem";
import { resolveIdentities } from "../lib/identities";
import { notifier } from "../lib/notify";
import { findAsset } from "../assets/read.repo";
import { project } from "../assets/read.routes";
import { AssetViewSchema } from "../assets/register.schemas";
import {
  AssetIdParamSchema,
  AssignBodySchema,
  AssignmentIdParamSchema,
  type AssignmentEvent,
} from "./assignments.schemas";
import { cancelAssignment, createAssignment, findAssignmentWithAsset } from "./assignments.repo";

/** The notification push (T17). Replaceable object property so tests can observe it. */
export const assignmentHooks: {
  afterCommit: (event: AssignmentEvent) => void | Promise<void>;
} = {
  afterCommit: (event) => notifier.notifyAssignment(event),
};

/**
 * Calls the hook without letting it affect the response: a throw, a rejection
 * or a slow hook cannot fail the write that already committed. Fire and forget.
 */
export function runAfterCommit(event: AssignmentEvent): void {
  try {
    Promise.resolve(assignmentHooks.afterCommit(event)).catch((error: unknown) => {
      console.error("[assignments] afterCommit hook failed:", error instanceof Error ? error.message : error);
    });
  } catch (error) {
    console.error("[assignments] afterCommit hook failed:", error instanceof Error ? error.message : error);
  }
}

const createRouteDef = createRoute({
  method: "post",
  path: "/assets/{id}/assignments",
  tags: ["Assignments"],
  summary: "Offer an in_stock asset to an employee (pending until they confirm)",
  middleware: [...authorized, requireCapability(ASSET_MANAGE)],
  request: {
    params: AssetIdParamSchema,
    body: { content: { "application/json": { schema: AssignBodySchema } }, required: true },
  },
  responses: {
    201: { description: "The asset with its pending assignment", content: { "application/json": { schema: AssetViewSchema } } },
    404: { description: "Unknown or out of scope" },
    409: { description: "invalid_transition | assignment_pending | asset_disposed" },
    422: { description: "unknown_user, or invalid body" },
  },
});

const cancelRouteDef = createRoute({
  method: "post",
  path: "/assignments/{id}/cancel",
  tags: ["Assignments"],
  summary: "Cancel a pending assignment",
  middleware: [...authorized, requireCapability(ASSET_MANAGE)],
  request: { params: AssignmentIdParamSchema },
  responses: {
    200: { description: "The asset, assignable again", content: { "application/json": { schema: AssetViewSchema } } },
    404: { description: "Unknown or out of scope" },
    409: { description: "assignment_not_pending" },
  },
});

export const assignmentsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

assignmentsRouter.openapi(createRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const { assigneeUserId } = c.req.valid("json");
  const { permissions, entity } = c.get("authz");
  const authorization = c.req.header("Authorization")!;

  const row = await findAsset(id);
  if (!row || !assetInScope(row, scopeFor(permissions, "asset", "manage", entity))) {
    throw notFound("Asset not found");
  }

  const identity = (await resolveIdentities(authorization, [assigneeUserId])).get(assigneeUserId);
  if (identity?.status !== "active") {
    throw unprocessable("The assignee is not an active Operai user", { field: "assigneeUserId" }, "unknown_user");
  }

  const actor = { userId: c.get("userId"), email: c.get("email") };
  const created = await createAssignment({ assetId: id, assigneeUserId, actor });
  runAfterCommit({
    kind: "created",
    assignmentId: created.assignmentId,
    assetId: id,
    assetDescription: created.assetDescription,
    assigneeUserId,
    createdByUserId: actor.userId,
  });

  const fresh = await findAsset(id);
  if (!fresh) throw notFound("Asset not found");
  const [view] = await project([fresh], authorization, scopeFor(permissions, "ledger", "manage", entity), true);
  return c.json(view!, 201);
});

assignmentsRouter.openapi(cancelRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const { permissions, entity } = c.get("authz");

  const found = await findAssignmentWithAsset(id);
  const asset = found ? await findAsset(found.assetId) : null;
  if (!asset || !assetInScope(asset, scopeFor(permissions, "asset", "manage", entity))) {
    throw notFound("Assignment not found");
  }

  const assetId = await cancelAssignment({
    assignmentId: id,
    actor: { userId: c.get("userId"), email: c.get("email") },
  });

  const fresh = await findAsset(assetId);
  if (!fresh) throw notFound("Asset not found");
  const [view] = await project(
    [fresh],
    c.req.header("Authorization")!,
    scopeFor(permissions, "ledger", "manage", entity),
    true,
  );
  return c.json(view!, 200);
});
