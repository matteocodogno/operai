/**
 * `GET /scope` (T7, specs/015-hardware-inventory, plan.md § API contracts →
 * Scope; AC-9.4, AC-9.5).
 *
 * Tells the UI which entities each capability covers for the caller, so the
 * register form's entity select, the entity filter, Rules and Fiscal years can
 * offer exactly the entities the server would accept (design G1/G11). Both
 * lists empty means "nothing in your scope" — either no capability at all, or
 * an entity-conditioned grant on a user with no `entity` attribute (R-7).
 *
 * Goes through `authzMiddleware` (it needs the resolved permissions) but
 * requires NO capability, and is therefore not under `/me/*`, which skips
 * authorization altogether (ADR-0045). An `auth` outage is a 503, never an
 * empty scope: a UI that read "[]" as "no access" would be lying.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authorized } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { ENTITIES, scopeFor } from "../authz/conditions";
import { validationHook } from "../lib/problem";

const EntitySchema = z.enum(ENTITIES);

const scopeRoute = createRoute({
  method: "get",
  path: "/scope",
  tags: ["Scope"],
  summary: "Entities each capability covers for the caller",
  middleware: authorized,
  responses: {
    200: {
      description: "The entities covered by asset:manage and ledger:manage",
      content: {
        "application/json": {
          schema: z.object({
            asset: z.array(EntitySchema),
            ledger: z.array(EntitySchema),
          }),
        },
      },
    },
    401: { description: "Missing or invalid token" },
    503: { description: "The authorization service is unavailable" },
  },
});

export const scopeRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

scopeRouter.openapi(scopeRoute, (c) => {
  const { permissions, entity } = c.get("authz");
  return c.json(
    {
      asset: scopeFor(permissions, "asset", "manage", entity),
      ledger: scopeFor(permissions, "ledger", "manage", entity),
    },
    200,
  );
});
