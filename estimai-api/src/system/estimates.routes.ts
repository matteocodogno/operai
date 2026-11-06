/**
 * GET /system/estimates/{id}/summary (specs/022-projects-handoff T2, AC-3.1; ADR-0061) —
 * an estimate's man-days read service-to-service. projects-api copies the figure onto a
 * fixed-price contract made from a won deal, for a person who is often not a collaborator
 * on the estimate, so this route trusts a scoped SERVICE credential
 * (`estimai.estimates.read`), never a user JWT. It is not behind `jwtMiddleware`, and it
 * reads any estimate regardless of owner or collaborators.
 *
 * It answers `{ id, name, manDays }` and nothing else: the estimate's content stays in
 * EstimAI (the data-residency posture of every other route here).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { manDaysOf } from "./manDays";
import { problem, problemBody } from "./problem";
import type { SystemAuthVariables } from "./systemAuth.middleware";
import { createSystemAuthMiddleware } from "./systemAuth.middleware";

/** The lookup the route needs; injected in tests, `@/lib/db` otherwise. */
export type FindEstimate = (id: string) => Promise<{ id: string; name: string; content: unknown } | null>;

const findEstimateInDb: FindEstimate = async (id) => {
  // Imported on first use, so loading this module never builds a Prisma client.
  const { db } = await import("../lib/db");
  return db.estimate.findUnique({ where: { id }, select: { id: true, name: true, content: true } });
};

const ParamsSchema = z.object({
  id: z.string().min(1).max(128),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

const SummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  manDays: z.number().min(0),
});

const summaryRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/estimates/{id}/summary",
    tags: ["System"],
    summary: "An estimate's man-days for a service principal (scope estimai.estimates.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope estimai.estimates.read). " +
      "A user JWT is never accepted. Reads any estimate regardless of owner or collaborators and returns " +
      "only its Expected man-days without AI gain (one decimal) — never the estimate's content.",
    request: { params: ParamsSchema },
    responses: {
      200: {
        description: "The estimate's name and man-days",
        content: { "application/json": { schema: SummarySchema } },
      },
      400: { description: "Malformed id" },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
      404: {
        description: "No such estimate (code estimate_not_found)",
        content: { "application/json": { schema: ProblemSchema } },
      },
    },
  });

export const createSystemEstimatesRouter = (auth: MiddlewareHandler, find: FindEstimate = findEstimateInDb) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const issue = result.error.issues[0];
      const field = issue?.path.join(".") ?? "";
      return problem({ status: 400, detail: `${field || "request"}: ${issue?.message ?? "Invalid request"}` }, c.req.path);
    },
  });

  // The guard rides on the route (`middleware`), never `router.use("*")`: Hono copies a
  // sub-app's `use("*")` onto the whole app.
  router.openapi(summaryRoute(auth), async (c) => {
    const { id } = c.req.valid("param");
    const estimate = await find(id);
    if (!estimate) {
      return c.json(problemBody({ status: 404, code: "estimate_not_found", detail: "Estimate not found" }, c.req.path), 404);
    }
    return c.json({ id: estimate.id, name: estimate.name, manDays: manDaysOf(estimate.content) }, 200);
  });

  return router;
};

/** The router `src/index.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemEstimatesRouter = createSystemEstimatesRouter(
  createSystemAuthMiddleware({ scope: "estimai.estimates.read" }),
);
