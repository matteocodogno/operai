/**
 * `GET /companies?q=` (specs/025 T5, AC-1.1, ADR-0080): the company picker for the create
 * form, a thin proxy over crm-api's `/system/companies` read with the service credential.
 * Needs `project:manage` (any entity): only someone who can create a project needs to pick a
 * company, and a plain reader sees company names through the projects themselves.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { orCrmUnavailable, searchCompanies } from "../lib/crm";
import { EntitySchema, commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

const ListCompaniesQuery = z.object({ q: z.string().max(200).optional() });

const CompanyChoiceSchema = z.object({ id: z.string(), name: z.string(), entity: EntitySchema });

const listRoute = createRoute({
  method: "get",
  path: "/companies",
  tags: ["Companies"],
  summary: "Look up CRM companies by name (needs project:manage)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: { query: ListCompaniesQuery },
  responses: {
    200: {
      description: "Active CRM companies whose name contains q, by name",
      content: { "application/json": { schema: z.object({ items: z.array(CompanyChoiceSchema) }) } },
    },
    // 503: authz_unavailable (commonErrors), or crm_unavailable when the CRM cannot answer.
    ...commonErrors,
  },
});

export const companiesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

companiesRouter.openapi(listRoute, async (c) => {
  const { q } = c.req.valid("query");
  const companies = await orCrmUnavailable(searchCompanies(q));
  return c.json({ items: companies.map(({ id, name, entity }) => ({ id, name, entity })) }, 200);
});
