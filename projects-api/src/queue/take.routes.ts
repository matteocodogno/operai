/**
 * Taking a deal from the to-start queue (specs/022-projects-handoff T7 as reshaped by T23; AC-1.2 –
 * AC-1.6, AC-1.8, AC-1.10, AC-3.1, AC-3.2): `POST /queue/{dealId}/project` makes a new project with
 * its terms and its purchase order from a won deal. There is no attach (D39): a deal that already
 * has a purchase order is `deal_taken`, and no route adds a purchase order to an existing project.
 *
 * Who may take a deal is `handoff:take` AND `project:manage`, both for the DEAL's entity (T24, AC-1.9,
 * AC-1.11): the route refuses a caller who holds `handoff:take` for no entity (a project manager, an
 * ops-manager, accounting: `forbidden`) before anything is looked up, the handler refuses the other
 * entity (`out_of_scope`) once the CRM has said which entity the deal is.
 *
 * The deal is read live from crm-api, never trusted from the client: it must exist, be `won` NOW
 * and have no purchase order yet. Project, terms and purchase order are written in ONE statement (a
 * nested create), so a refusal — including the unique `dealId` index losing a race between two takes
 * of the same deal (the database half of AC-1.6) — leaves nothing behind.
 *
 * The project is `planned`, with the deal's company and entity and NO project manager: the person who
 * takes the deal is not made one (D42), the ops-manager picks it later. Before anything is written,
 * `opsManagerId` must be one of auth's live holders of `purchase-order:receive` for the deal's entity
 * (`422 ops_manager_invalid`, `503 identity_unavailable`: AC-4.2) and `referentContactId`, when given,
 * a non-archived CRM contact of the LIVE DEAL's company (`422 referent_invalid`, one body for every
 * reason; `503 crm_unavailable`: AC-3.6, T18 M3). Only the referent's id is stored; no contact data is
 * read into the purchase order or the log (one audit line per take: kind, project id, actor id).
 *
 * Once the take has committed, the ops-manager is told (T25, AC-4.3): one best-effort in-app push through
 * notify-api (`lib/notify.ts`), never awaited here and never failing the take (AC-4.4) — the project stays
 * awaiting its project manager whether or not the notification arrives.
 *
 * Man-days are server-owned for a deal with an estimate (AC-3.1): the client omits
 * `terms.estimatedManDays` (sending it, even `null`, is a 422), and on a `fixed_price` project the
 * server copies EstimAI's figure once, before the write (A6) — EstimAI down is a 503 with nothing
 * written, an estimate EstimAI does not know leaves the figure `null`. The estimate id is copied onto
 * the purchase order: it is the AC-3.2 link.
 *
 * A body error names the field by its full path in the body (`terms.startDate`,
 * `terms.terms.deadline`): `terms` is `{ startDate, endDate?, terms }`, specs/021's contract shape.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HANDOFF_TAKE, authorized, requireCapability, type AuthzSource } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assertValidReferent, type CrmDeal } from "../lib/crm";
import { db } from "../lib/db";
import { estimateManDays } from "../lib/estimai";
import { opsManagerCandidates } from "../lib/holders";
import { announcePurchaseOrderAssigned } from "../lib/notify";
import { IdParams, IdSchema, commonErrors, etag, requiredText, type HeaderSource } from "../lib/http";
import { unprocessable, validationHook } from "../lib/problem";
import { dealTaken, loadTakeableDeal } from "./deal";
import { projectCreateData } from "../projects/create";
import { projectInclude, toProjectView } from "../projects/projects.routes";
import { ProjectSchema, type ProjectType } from "../projects/projects.schemas";
import { termsCreateData } from "../terms/create";
import { parseTerms, type Terms } from "../terms/terms";
import { CreateTermsSchema } from "../terms/terms.schemas";

// ─── Request shapes ──────────────────────────────────────────────────────────

/** The client types (AC-1.2, D40): every type but `internal`, which has no company and no PO. */
const DEAL_PROJECT_TYPES = ["t_and_m", "fixed_price", "maintenance", "saas"] as const;

const DealParams = z.object({ dealId: IdParams.shape.id });

const TakeAsProjectSchema = z
  .object({
    name: requiredText(200),
    type: z.enum(DEAL_PROJECT_TYPES),
    /** The dates and the type's terms, collected in the same step as the take (AC-1.8). */
    terms: CreateTermsSchema,
    /** The `auth` user the purchase order is assigned to, who picks the project manager (D42). */
    opsManagerId: IdSchema,
    /** A CRM contact of the deal's company (D41); optional. */
    referentContactId: IdSchema.nullable().optional(),
  })
  .strict();

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * The ops-manager the caller chose must be one of auth's CURRENT holders of `purchase-order:receive`
 * for the deal's entity (admins included, AC-4.2): the list is re-read here, with the caller's own
 * token, so a role removed since the picker was filled is refused. 503 `identity_unavailable` when auth
 * cannot answer — never "valid".
 */
async function assertValidOpsManager(c: AuthzSource & HeaderSource, deal: CrmDeal, opsManagerId: string): Promise<void> {
  const candidates = await opsManagerCandidates(c.req.header("Authorization") ?? "", deal.entity);
  if (!candidates.some((holder) => holder.id === opsManagerId)) {
    throw unprocessable(
      "The ops-manager must hold the ops-manager role for this deal's entity, or be an admin",
      undefined,
      "ops_manager_invalid",
    );
  }
}

/** Postgres' unique index on `purchase_order.dealId` refused a second purchase order for the deal. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/**
 * The terms of the project made from `deal` on a project of `type`, validated, with the man-days
 * filled from the estimate (AC-3.1). The client never sends `estimatedManDays` for a deal with an
 * estimate; for one without, it is the client's to give, as on terms entered by hand.
 */
async function dealTerms(type: ProjectType, raw: Record<string, unknown> | undefined, deal: CrmDeal): Promise<Terms> {
  if (type === "fixed_price" && deal.estimate && raw !== undefined && "estimatedManDays" in raw) {
    throw unprocessable(
      "The estimated man-days of a deal with an estimate come from the estimate: leave them out",
      { field: "terms.terms.estimatedManDays" },
      "estimated_man_days_from_estimate",
    );
  }
  const terms = parseTerms(type, raw ?? {}, ["terms", "terms"]);
  if (terms.type === "fixed_price" && deal.estimate) {
    return { ...terms, estimatedManDays: await estimateManDays(deal.estimate.id) };
  }
  return terms;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const takeAsProjectRoute = createRoute({
  method: "post",
  path: "/queue/{dealId}/project",
  tags: ["Queue"],
  summary: "Take a won deal as a new project with its terms and purchase order (handoff:take and project:manage for the deal's entity)",
  middleware: [...authorized, requireCapability(HANDOFF_TAKE)],
  request: {
    params: DealParams,
    body: { content: { "application/json": { schema: TakeAsProjectSchema } }, required: true },
  },
  responses: {
    201: { description: "Created: a planned project with no project manager, its terms and a purchase order made from the deal", ...json(ProjectSchema) },
    404: { description: "deal_not_found" },
    409: { description: "deal_not_won or deal_taken" },
    422: { description: "ops_manager_invalid, referent_invalid, estimated_man_days_from_estimate or maintenance_needs_sla_or_hours" },
    ...commonErrors,
    503: { description: "crm_unavailable, identity_unavailable, estimai_unavailable, estimai_unconfigured or authz_unavailable" },
  },
});

export const takeRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

takeRouter.openapi(takeAsProjectRoute, async (c) => {
  const { dealId } = c.req.valid("param");
  const body = c.req.valid("json");
  const deal = await loadTakeableDeal(c, dealId);
  // Cheap refusals about WHO come before the EstimAI call; nothing is written until all have passed.
  await assertValidOpsManager(c, deal, body.opsManagerId);
  if (body.referentContactId) await assertValidReferent(body.referentContactId, deal.company.id);
  const terms = await dealTerms(body.type, body.terms.terms, deal);
  const userId = c.get("userId");

  const row = await db.project
    .create({
      data: {
        // No project manager: the person who took the deal is not made one (D42).
        ...projectCreateData({
          name: body.name,
          type: body.type,
          entity: deal.entity,
          companyId: deal.company.id,
          projectManagerId: null,
          createdById: userId,
        }),
        terms: {
          create: termsCreateData({ type: body.type, startDate: body.terms.startDate, endDate: body.terms.endDate, terms }),
        },
        purchaseOrder: {
          create: {
            dealId,
            estimateId: deal.estimate?.id ?? null,
            opsManagerId: body.opsManagerId,
            referentContactId: body.referentContactId ?? null,
            createdById: userId,
          },
        },
      },
      include: projectInclude,
    })
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? dealTaken() : error;
    });
  // The audit line (T18 L6): which event, which project, who — never the name, the ops-manager or the contact.
  console.log(JSON.stringify({ event: "handoff.taken", projectId: row.id, actorId: userId }));
  // AC-4.3, AC-4.4: tell the ops-manager once the take has committed — never awaited, never failing it.
  announcePurchaseOrderAssigned({ projectId: row.id, projectName: row.name, companyName: deal.company.name, opsManagerId: body.opsManagerId });
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row), 201);
});
