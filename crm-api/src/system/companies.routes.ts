/**
 * GET /system/companies (specs/021-projects T2, ADR-0059) — CRM companies read
 * service-to-service. projects-api resolves company names and lets a project
 * manager pick a company, for users who may hold no `crm:access` (D13), so this
 * route trusts a scoped SERVICE credential (`crm.companies.read`), never a user
 * JWT. It is not behind `authorized`: no user, no `crm:access`, no entity scope.
 *
 *   q      case-insensitive substring of the name; non-archived only.
 *   ids    comma-separated company ids (at most 100); archived included.
 *   limit  1-50. Default 20, or - with `ids` - as many as were asked for, so a
 *          lookup of a page's companies is never silently truncated.
 *
 * Company ids are the CRM's own text ids (cuid), not uuids: the contract note
 * says "uuids", the data says otherwise (reported as drift).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { db } from "../lib/db";
import { EntitySchema } from "../lib/http";
import type { Prisma } from "../lib/generated/prisma/client";
import { problem } from "../lib/problem";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

export const MAX_IDS = 100;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;

const IdsSchema = z
  .string()
  .max(MAX_IDS * 65)
  .transform((value) => value.split(",").map((id) => id.trim()))
  .refine((ids) => ids.length <= MAX_IDS, `At most ${MAX_IDS} ids`)
  .refine((ids) => ids.every((id) => id.length >= 1 && id.length <= 64), "Every id is 1-64 characters")
  .optional();

const QuerySchema = z.object({
  q: z.string().max(200).optional(),
  ids: IdsSchema,
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  entity: EntitySchema,
  archived: z.boolean(),
});

const companiesRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/companies",
    tags: ["System"],
    summary: "CRM companies for a service principal (scope crm.companies.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope crm.companies.read). " +
      "A user JWT is never accepted. `q` matches non-archived companies by name; `ids` returns those " +
      "companies, archived included.",
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "Matching companies, by name",
        content: { "application/json": { schema: z.object({ items: z.array(ItemSchema) }) } },
      },
      400: { description: "Malformed q, ids (more than 100, an empty id) or limit" },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
    },
  });

export const createSystemCompaniesRouter = (auth: MiddlewareHandler) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const issue = result.error.issues[0];
      const field = issue?.path.join(".") ?? "";
      return problem({ status: 400, detail: `${field || "query"}: ${issue?.message ?? "Invalid request"}` }, c.req.path);
    },
  });

  // The guard rides on the route (`middleware`), never `router.use("*")`: Hono copies a
  // sub-app's `use("*")` onto the whole app.
  router.openapi(companiesRoute(auth), async (c) => {
    const { q, ids, limit } = c.req.valid("query");
    const term = q?.trim();
    const where: Prisma.CompanyWhereInput = {
      ...(ids ? { id: { in: ids } } : { archivedAt: null }),
      ...(term ? { name: { contains: term, mode: "insensitive" } } : {}),
    };
    const rows = await db.company.findMany({
      where,
      select: { id: true, name: true, entity: true, archivedAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit ?? (ids ? ids.length : DEFAULT_LIMIT),
    });
    return c.json(
      {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          entity: row.entity,
          archived: row.archivedAt !== null,
        })),
      },
      200,
    );
  });

  return router;
};

/** The router `src/index.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemCompaniesRouter = createSystemCompaniesRouter(
  createSystemAuthMiddleware({ scope: "crm.companies.read" }),
);
