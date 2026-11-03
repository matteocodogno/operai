/**
 * `GET /scope` (specs/021-projects, tasks.md § API contracts): which entities
 * `project:manage` covers for the caller, whether that is every entity, and whether
 * they may write a contract's Bexio order id — so projects-ui offers exactly the
 * controls the server would accept (AC-4.4, AC-4.5). An `auth` outage is a 503, never
 * an empty scope.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized, canSetBexio, manageScope, managesAll } from "../auth/guards";
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
      description: "Entities covered by project:manage, whether that is all of them, and whether contract:bexio is held",
      content: {
        "application/json": {
          schema: z.object({
            manage: z.array(EntitySchema),
            managesAll: z.boolean(),
            bexio: z.boolean(),
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
  c.json({ manage: manageScope(c), managesAll: managesAll(c), bexio: canSetBexio(c) }, 200),
);
