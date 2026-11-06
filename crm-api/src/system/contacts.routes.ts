/**
 * GET /system/contacts (specs/022-projects-handoff T21, AC-3.6, AC-3.8, AC-3.9; T18 M2, L3, L8) —
 * CRM contacts read service-to-service. projects-api lists a deal company's contacts for the
 * referent picker and reads a purchase order's referent live, for users who may hold no
 * `crm:access`, so this route trusts a scoped SERVICE credential (`crm.contacts.read`), never a
 * user JWT. It is not behind `authorized`: no user, no `crm:access`, no entity scope.
 *
 * Exactly one of two modes, each with ITS OWN shape and its own explicit Prisma `select` — a
 * contact's notes, audit fields and version are never read, and the bulk mode carries no email or
 * phone, so a compromised credential or route is not a contact export (T18 M2, L3):
 *   companyId  one company's non-archived contacts, by last then first name, at most
 *              CONTACTS_LIMIT; `truncated` says there were more. { id, firstName, lastName, jobTitle }.
 *   ids        comma-separated contact ids (at most MAX_CONTACT_IDS, 1-64 characters each), archived
 *              or not: { id, companyId, firstName, lastName, jobTitle, email, phone, archived }. An
 *              erased (deleted) or unknown contact is simply absent.
 *
 * The caller reads live and never stores what it reads (D49); nothing here is cached.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { db } from "../lib/db";
import { problem, problemBody } from "../lib/problem";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

/** The most contacts the `companyId` mode returns (as the won-deals cap: enough, not a directory). */
export const CONTACTS_LIMIT = 500;
/** The most ids the `ids` mode takes: a purchase order has one referent, a page shows a handful. */
export const MAX_CONTACT_IDS = 20;

const ID = z.string().min(1).max(64);

const ContactIdsSchema = z
  .string()
  .max(MAX_CONTACT_IDS * 65 + 65)
  .transform((value) => value.split(",").map((id) => id.trim()))
  .refine((ids) => ids.length <= MAX_CONTACT_IDS, `At most ${MAX_CONTACT_IDS} ids`)
  .refine((ids) => ids.every((id) => id.length >= 1 && id.length <= 64), "Every id is 1-64 characters")
  .optional();

const QuerySchema = z.object({
  companyId: ID.optional(),
  ids: ContactIdsSchema,
});

const CompanyContactSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  jobTitle: z.string().nullable(),
});

const ContactByIdSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  archived: z.boolean(),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

// One explicit select per mode: nothing outside the shape is ever read from the row.
const COMPANY_SELECT = { id: true, firstName: true, lastName: true, jobTitle: true } as const;
const BY_ID_SELECT = {
  id: true,
  companyId: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  email: true,
  phone: true,
  archivedAt: true,
} as const;

const contactsRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/contacts",
    tags: ["System"],
    summary: "CRM contacts for a service principal (scope crm.contacts.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope crm.contacts.read). " +
      "A user JWT is never accepted. Exactly one of `companyId` (that company's non-archived contacts, " +
      `by last then first name, at most ${CONTACTS_LIMIT}, \`truncated\` beyond; id, names and job title ` +
      `only) or \`ids\` (those contacts, archived or not, at most ${MAX_CONTACT_IDS}; names, job title, ` +
      "email, phone and the archived flag; an erased contact is absent). Carries no notes.",
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "The contacts of the asked mode",
        content: {
          "application/json": {
            schema: z.union([
              z.object({ items: z.array(CompanyContactSchema), truncated: z.boolean() }),
              z.object({ items: z.array(ContactByIdSchema) }),
            ]),
          },
        },
      },
      400: {
        description:
          `Neither or both of companyId and ids, an empty or over-long id, or more than ${MAX_CONTACT_IDS} ids`,
        content: { "application/json": { schema: ProblemSchema } },
      },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
    },
  });

export const createSystemContactsRouter = (auth: MiddlewareHandler) => {
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
  router.openapi(contactsRoute(auth), async (c) => {
    const { companyId, ids } = c.req.valid("query");

    if (ids !== undefined && companyId === undefined) {
      const unique = [...new Set(ids)];
      const found = await db.contact.findMany({ where: { id: { in: unique } }, select: BY_ID_SELECT });
      const byId = new Map(found.map((row) => [row.id, row]));
      // In the order asked for; an unknown or erased id is silently absent.
      const items = unique.flatMap((id) => {
        const row = byId.get(id);
        return row
          ? [
              {
                id: row.id,
                companyId: row.companyId,
                firstName: row.firstName,
                lastName: row.lastName,
                jobTitle: row.jobTitle,
                email: row.email,
                phone: row.phone,
                archived: row.archivedAt !== null,
              },
            ]
          : [];
      });
      return c.json({ items }, 200);
    }

    if (companyId !== undefined && ids === undefined) {
      const rows = await db.contact.findMany({
        where: { companyId, archivedAt: null },
        select: COMPANY_SELECT,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
        take: CONTACTS_LIMIT + 1,
      });
      return c.json({ items: rows.slice(0, CONTACTS_LIMIT), truncated: rows.length > CONTACTS_LIMIT }, 200);
    }

    // Neither or both.
    return c.json(problemBody({ status: 400, detail: "query: exactly one of companyId and ids is required" }, c.req.path), 400);
  });

  return router;
};

/** The router `src/index.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemContactsRouter = createSystemContactsRouter(createSystemAuthMiddleware({ scope: "crm.contacts.read" }));
