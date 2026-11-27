/**
 * POST /system/deal-link-notices — crm-api tells EstimAI which CRM deal an
 * estimate belongs to, or that it no longer does (specs/20261108-estimate-list-oversight US-3, AC-3.3,
 * AC-3.5, AC-3.6; ADR 20261108-crm-pushes-deal-links-to-estimai, the mirror of ADR 20261105-estimai-closes-the-estimate-crm-follows). EstimAI keeps the link as
 * two columns, `crmDealId` and `crmLinkAt`, and shows the deal on the list.
 *
 * Service-to-service only: a service JWT of `system:crm-api` with scope
 * `deal-link-notices.send`, `aud = SERVICE_AUDIENCE` (systemAuth). The body is
 * three ids and an instant — never anything of the deal (title, amount, notes),
 * and an unknown field is a 400. An estimate EstimAI does not have answers 204
 * like any other, so nothing is learnt from it.
 *
 * ORDER (AC-3.6). Notices may arrive late, twice or out of order, so each one is
 * applied by ONE conditional UPDATE keyed on the CRM instant `at` (every `at`
 * comes from crm-api's one clock) — no read-then-write:
 *   - `linked` applies when `crmLinkAt` is null or older than `at`;
 *   - `unlinked` applies when `crmLinkAt` is null or not newer than `at`, so at
 *     an equal instant the unlink wins;
 *   - `unlinked` clears only a link to the notice's own deal. Where the
 *     estimate holds NO link yet it still records `at`, so the `linked` it
 *     undoes cannot land afterwards. Where it is linked to a DIFFERENT deal it
 *     changes nothing at all, `crmLinkAt` included: advancing it would shut out
 *     the newer link's own notice if that arrives late. (The CRM never relinks
 *     an estimate — a new request is a new estimate, specs/20261101-crm-sales-flow AC-3.1 — so that
 *     branch is a guard, not a flow.)
 *
 * Raw SQL, not `updateMany`: Prisma's `@updatedAt` would stamp the estimate as
 * edited, reordering the list and implying a change to the document. A link is
 * not one.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@/lib/db";
import { IdSchema } from "@/lib/nulInput";
import {
  createSystemAuthMiddleware,
  type SystemAuthOptions,
  type SystemAuthVariables,
} from "@/auth/systemAuth.middleware";
import { problemBadRequest } from "./estimates.wire";

export const DEAL_LINK_NOTICES_SCOPE = "deal-link-notices.send";
const CRM_CALLER = "system:crm-api";

/**
 * How far ahead of this clock a notice's `at` may be. A later `at` would pin
 * `crmLinkAt` and shut out every real notice after it (security review
 * 2026-11-09), so it is refused; the margin only absorbs clock skew.
 */
export const MAX_NOTICE_CLOCK_SKEW_MS = 5 * 60_000;

const NoticeSchema = z
  .object({
    estimateId: IdSchema.max(64),
    dealId: IdSchema.max(64),
    event: z.enum(["linked", "unlinked"]),
    at: z
      .string()
      .datetime({ offset: true })
      .refine((v) => Date.parse(v) <= Date.now() + MAX_NOTICE_CLOCK_SKEW_MS, "at is in the future"),
  })
  .strict();

export type DealLinkNotice = z.infer<typeof NoticeSchema>;

const noticeRoute = (opts: Partial<Pick<SystemAuthOptions, "jwks" | "audience">>) =>
  createRoute({
    method: "post",
    path: "/system/deal-link-notices",
    tags: ["System"],
    summary: "A CRM deal was linked to, or unlinked from, an estimate (crm-api only)",
    middleware: [
      createSystemAuthMiddleware({ scope: DEAL_LINK_NOTICES_SCOPE, allowedSubs: [CRM_CALLER], ...opts }),
    ] as const,
    request: { body: { content: { "application/json": { schema: NoticeSchema } }, required: true } },
    responses: {
      204: { description: "Applied, ignored as older or a repeat, or about an estimate EstimAI does not have" },
      400: { description: "Malformed body, or a field this contract does not carry" },
      401: { description: "Not a valid crm-api service credential" },
    },
  });

/** Exported for tests, which inject their own key set and audience. */
export const createDealLinkNoticesRouter = (
  opts: Partial<Pick<SystemAuthOptions, "jwks" | "audience">> = {},
) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
    defaultHook: (result, c) =>
      result.success ? undefined : c.json(problemBadRequest(c.req.path, "The notice body is not valid"), 400),
  });

  router.openapi(noticeRoute(opts), async (c) => {
    const { estimateId, dealId, event, at } = c.req.valid("json");
    await applyNotice({ estimateId, dealId, event, at });
    return c.body(null, 204);
  });

  return router;
};

export const dealLinkNoticesRouter = createDealLinkNoticesRouter();

export async function applyNotice(n: DealLinkNotice): Promise<void> {
  const at = new Date(n.at);
  if (n.event === "linked") {
    await db.$executeRaw`
      UPDATE "estimate"
         SET "crmDealId" = ${n.dealId}, "crmLinkAt" = ${at}
       WHERE "id" = ${n.estimateId}
         AND ("crmLinkAt" IS NULL OR "crmLinkAt" < ${at})`;
    return;
  }
  await db.$executeRaw`
    UPDATE "estimate"
       SET "crmDealId" = NULL, "crmLinkAt" = ${at}
     WHERE "id" = ${n.estimateId}
       AND ("crmDealId" IS NULL OR "crmDealId" = ${n.dealId})
       AND ("crmLinkAt" IS NULL OR "crmLinkAt" <= ${at})`;
}
