/**
 * GET /system/deals (specs/022-projects-handoff T3, AC-1.1, AC-2.1–AC-2.3; ADR-0060) — CRM
 * deals read service-to-service. projects-api builds the to-start queue from the won deals
 * and shows a contract's deal title and stage, for users who may hold no `crm:access`, so
 * this route trusts a scoped SERVICE credential (`crm.deals.read`), never a user JWT. It is
 * not behind `authorized`: no user, no `crm:access`, no entity scope.
 *
 * The deal is read live, never synced: a reopened deal is simply no longer `won` on the next
 * read, and a re-won one is back — no event, no webhook, no write path changed (D17).
 *
 * Exactly one of:
 *   stage=won  the won deals, newest win (`wonAt`) first, at most WON_DEALS_LIMIT;
 *              `truncated` says there were more.
 *   ids        comma-separated deal ids (at most 100, 1-64 characters each), any stage.
 *
 * A deal is a `DealSummary`: id, title, stage, entity, company { id, name }, `wonAt` (the
 * win date while the stage is `won`, else null) and `estimate` { id, name } | null. NO amount,
 * currency, owner or notes: the select below is explicit so none can leak (D14).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { DEAL_STAGES } from "../deals/stages";
import { db } from "../lib/db";
import { EntitySchema } from "../lib/http";
import { problem, problemBody } from "../lib/problem";
import { IdsSchema } from "./companies.routes";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

/** The most won deals one read returns (A26: enough while the CRM is weeks old). */
export const WON_DEALS_LIMIT = 500;

const QuerySchema = z.object({
  stage: z.literal("won").optional(),
  ids: IdsSchema,
});

const DealSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  stage: z.enum(DEAL_STAGES),
  entity: EntitySchema,
  company: z.object({ id: z.string(), name: z.string() }),
  wonAt: z.string().nullable(),
  estimate: z.object({ id: z.string(), name: z.string() }).nullable(),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

// Explicit select: nothing outside the summary is ever read from the row.
const SUMMARY_SELECT = {
  id: true,
  title: true,
  stage: true,
  entity: true,
  closedAt: true,
  company: { select: { id: true, name: true } },
  estimate: { select: { estimateId: true, estimateName: true } },
} as const;

type SummaryRow = {
  id: string;
  title: string;
  stage: (typeof DEAL_STAGES)[number];
  entity: "welld_ch" | "welld_it";
  closedAt: Date | null;
  company: { id: string; name: string };
  estimate: { estimateId: string; estimateName: string } | null;
};

const toSummary = (row: SummaryRow) => ({
  id: row.id,
  title: row.title,
  stage: row.stage,
  entity: row.entity,
  company: { id: row.company.id, name: row.company.name },
  // The win date only while the deal is won: a reopened deal has none.
  wonAt: row.stage === "won" ? (row.closedAt?.toISOString() ?? null) : null,
  estimate: row.estimate ? { id: row.estimate.estimateId, name: row.estimate.estimateName } : null,
});

const dealsRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/deals",
    tags: ["System"],
    summary: "CRM deals for a service principal (scope crm.deals.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope crm.deals.read). " +
      "A user JWT is never accepted. Exactly one of `stage=won` (won deals, newest win first, at most " +
      `${WON_DEALS_LIMIT}, \`truncated\` beyond) or \`ids\` (those deals, any stage, at most 100). ` +
      "Carries no amount, currency, owner or notes.",
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "The deals",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(DealSummarySchema), truncated: z.boolean() }),
          },
        },
      },
      400: {
        description: "Neither or both of stage and ids, a stage other than won, more than 100 ids or an empty or over-long id",
        content: { "application/json": { schema: ProblemSchema } },
      },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
    },
  });

export const createSystemDealsRouter = (auth: MiddlewareHandler) => {
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
  router.openapi(dealsRoute(auth), async (c) => {
    const { stage, ids } = c.req.valid("query");
    if ((stage === undefined) === (ids === undefined)) {
      return c.json(problemBody({ status: 400, detail: "query: exactly one of stage and ids is required" }, c.req.path), 400);
    }

    if (ids) {
      const unique = [...new Set(ids)];
      const rows = await db.deal.findMany({ where: { id: { in: unique } }, select: SUMMARY_SELECT });
      const byId = new Map(rows.map((row) => [row.id, row]));
      // In the order asked for; an unknown id is silently absent.
      const items = unique.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toSummary(row)] : [];
      });
      return c.json({ items, truncated: false }, 200);
    }

    const rows = await db.deal.findMany({
      where: { stage: "won" },
      select: SUMMARY_SELECT,
      // A won deal always has its win date (CHECK deal_closed_iff_closed_stage).
      orderBy: [{ closedAt: "desc" }, { id: "asc" }],
      take: WON_DEALS_LIMIT + 1,
    });
    return c.json(
      { items: rows.slice(0, WON_DEALS_LIMIT).map(toSummary), truncated: rows.length > WON_DEALS_LIMIT },
      200,
    );
  });

  return router;
};

/** The router `src/index.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemDealsRouter = createSystemDealsRouter(createSystemAuthMiddleware({ scope: "crm.deals.read" }));
