/**
 * `GET /scope` (specs/021-projects, tasks.md § API contracts): which entities
 * `project:manage` covers for the caller, whether that is every entity, and whether
 * they may write a purchase order's Bexio order id — so projects-ui offers exactly the
 * controls the server would accept (AC-4.4, AC-4.5). An `auth` outage is a 503, never
 * an empty scope.
 *
 * specs/022 T24 adds `take` (the entities `handoff:take` covers: no queue and no take when empty,
 * AC-1.9) and `oversees` (`purchase-order:receive` for EVERY entity: the admin's override of the
 * project-manager pick, AC-4.8 — computed from the grant's conditions, never from its mere presence).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized, canSetBexio, manageScope, managesAll, oversees, takeScope } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { EntitySchema, commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

const scopeRoute = createRoute({
  method: "get",
  path: "/scope",
  tags: ["Scope"],
  summary: "What the caller may manage",
  middleware: authorized,
  responses: {
    200: {
      description:
        "Entities covered by project:manage, whether that is all of them, whether purchase-order:bexio is held, " +
        "the entities whose won deals handoff:take covers, and whether purchase-order:receive is held for every entity",
      content: {
        "application/json": {
          schema: z.object({
            manage: z.array(EntitySchema),
            managesAll: z.boolean(),
            bexio: z.boolean(),
            /** The entities whose won deals the caller may take (`handoff:take`); empty: no queue, no take (AC-1.9). */
            take: z.array(EntitySchema),
            /** `purchase-order:receive` for EVERY entity (the admin override of the project-manager pick, AC-4.8). */
            oversees: z.boolean(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

export const scopeRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

scopeRouter.openapi(scopeRoute, (c) =>
  c.json(
    { manage: manageScope(c), managesAll: managesAll(c), bexio: canSetBexio(c), take: takeScope(c), oversees: oversees(c) },
    200,
  ),
);
