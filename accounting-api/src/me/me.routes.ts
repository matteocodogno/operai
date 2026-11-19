/**
 * GET /v1/me (T6, specs/20261119-accounting, AC-3.5, AC-3.6, AC-8.2): the entities the caller reads, each with
 * whether they also manage it, for the UI. The browser never evaluates an entity condition (ADR 20261117 point
 * 4, plan D17): accounting-ui draws its entity switch from `entities` and its write controls from `canManage`
 * of the entity on screen, and re-reads this after any 403 or 404 (design UX-4, UX-15).
 *
 * Presentation only, like the Sidebar: every other route enforces for itself through `requireEntityAccess`.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../authz/authz.middleware";
import { requireAnyAccess } from "../authz/coverage";
import { ENTITIES, OWN_CURRENCY, RATE_SOURCE } from "../entities";

const MeEntitySchema = z
  .object({
    entity: z.enum(ENTITIES),
    ownCurrency: z.string(),
    canManage: z.boolean(),
    /** The official source of the entity's rates; `null` = none ("no official source", AC-2.11). */
    rateSource: z.enum(["bazg"]).nullable(),
  })
  .strict();

const MeResponseSchema = z.object({ entities: z.array(MeEntitySchema) }).strict();

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

const meRoute = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["Me"],
  summary: "The entities the caller can read, and which of them they manage",
  description:
    "Entities covered by `accounting:read` or `accounting:manage` (manage includes read), `welld_ch` first. " +
    "403 `accounting_forbidden` with no data when the caller reads no entity.",
  responses: {
    200: { content: { "application/json": { schema: MeResponseSchema } }, description: "Covered entities" },
    401: { content: { "application/json": { schema: ProblemSchema } }, description: "No valid token" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "`accounting_forbidden`: no read coverage for any entity",
    },
    503: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "The authorization service is unavailable (fail closed)",
    },
  },
});

export const meRouter = new OpenAPIHono<{ Variables: AuthzVariables }>();

// Only this path: a router mounted at "/" must not put a login in front of an unknown URL's 404.
meRouter.use("/v1/me", jwtMiddleware, authzMiddleware);

meRouter.openapi(meRoute, (c) => {
  const coverage = requireAnyAccess(c);
  return c.json(
    {
      entities: coverage.read.map((entity) => ({
        entity,
        ownCurrency: OWN_CURRENCY[entity],
        canManage: coverage.manage.includes(entity),
        rateSource: RATE_SOURCE[entity]?.name ?? null,
      })),
    },
    200,
  );
});
