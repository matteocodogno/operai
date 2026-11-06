/**
 * POST /system/estimate-notices — estimai-api tells the CRM that an estimate was
 * closed or reopened (specs/018 AC-3.3, ADR-0073). Closed in EstimAI is the only
 * way an estimate becomes ready: the deal's estimate turns `ready`, its task is
 * completed and the requester and the deal owner are told; reopened turns it back
 * to `requested` and reopens the task.
 *
 * Service-to-service only: a service JWT of `system:estimai-api` with scope
 * `estimate-notices.send` (systemAuth). The body is ids and a version, nothing
 * from the estimate's content. Notices may arrive late or out of order: one whose
 * EstimAI version is not newer than the last applied is ignored. An estimate the
 * CRM does not link answers 204 like any other, so nothing is learnt from it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import { MAX_NAME, announce, clip } from "../lib/notify";
import { validationHook } from "../lib/problem";
import { announceUnblocked } from "../activities/blockers";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "../auth/systemAuth.middleware";

export const ESTIMATE_NOTICES_SCOPE = "estimate-notices.send";
const ESTIMAI_CALLER = "system:estimai-api";

const NoticeSchema = z
  .object({
    estimateId: z.string().min(1).max(64),
    event: z.enum(["closed", "reopened"]),
    version: z.number().int().min(1),
    at: z.string().datetime({ offset: true }),
    byUserId: z.string().min(1).max(255),
  })
  .strict();

const noticeRoute = createRoute({
  method: "post",
  path: "/system/estimate-notices",
  tags: ["System"],
  summary: "An EstimAI estimate was closed or reopened (estimai-api only)",
  middleware: [createSystemAuthMiddleware({ scope: ESTIMATE_NOTICES_SCOPE, allowedSubs: [ESTIMAI_CALLER] })] as const,
  request: { body: { content: { "application/json": { schema: NoticeSchema } }, required: true } },
  responses: {
    204: { description: "Applied, ignored as stale, or about an estimate the CRM does not link" },
    401: { description: "Not a valid estimai-api service credential" },
    422: { description: "Validation failed" },
  },
});

export const estimateNoticesRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
  defaultHook: validationHook,
});

type Notice = z.infer<typeof NoticeSchema>;

const dealRef = (deal: { title: string }) => clip(deal.title, MAX_NAME);
const dealHref = (id: string) => `/crm/deals/${id}`;

estimateNoticesRouter.openapi(noticeRoute, async (c) => {
  const notice = c.req.valid("json");
  const links = await db.dealEstimate.findMany({
    where: { estimateId: notice.estimateId },
    include: { deal: { select: { id: true, title: true, ownerUserId: true } } },
  });
  for (const link of links) await apply(link, notice);
  return c.body(null, 204);
});

async function apply(
  link: Awaited<ReturnType<typeof db.dealEstimate.findMany>>[number] & { deal: { id: string; title: string; ownerUserId: string } },
  notice: Notice,
): Promise<void> {
  const at = new Date(notice.at);
  const ready = notice.event === "closed";
  // The row is locked while the version is compared and written: of two notices
  // racing, the newer one decides the state and the task, whatever the order.
  const changed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "deal_estimate" WHERE "dealId" = ${link.dealId} FOR UPDATE`;
    const row = await tx.dealEstimate.findUnique({ where: { dealId: link.dealId } });
    if (!row || row.estimateId !== notice.estimateId) return false;
    if (row.estimaiVersion !== null && row.estimaiVersion >= notice.version) return false;
    await tx.dealEstimate.update({
      where: { dealId: link.dealId },
      data: ready
        ? { estimaiVersion: notice.version, state: "ready", readyAt: at, readyBy: notice.byUserId }
        : { estimaiVersion: notice.version, state: "requested", readyAt: null, readyBy: null },
    });
    const flips = (row.state === "ready") !== ready;
    if (flips && row.taskId) {
      await tx.activity.updateMany({
        where: { id: row.taskId, ...(ready ? { completedAt: null } : {}) },
        data: ready ? { completedAt: at, completedByUserId: notice.byUserId } : { completedAt: null, completedByUserId: null },
      });
    }
    return flips;
  });
  if (!changed) return;

  // Who closed or reopened it is known by id only: the copy does not name them.
  const actor = { get: (_key: "userId") => notice.byUserId, req: { header: (_name: string) => undefined } };
  const deal = link.deal;
  if (ready) {
    // specs/017 US-6: tasks that waited on the estimate task may now go ahead.
    if (link.taskId) await announceUnblocked(actor, [link.taskId]);
    // E2 — whoever asked for it and whoever owns the deal.
    await announce(actor, {
      kind: "estimate_ready",
      dealId: deal.id,
      recipientIds: [link.requestedBy, deal.ownerUserId],
      severity: "success",
      email: true,
      href: dealHref(deal.id),
      copy: () => ({
        title: `Estimate ready: ${dealRef(deal)}`,
        body: `The estimate for ${dealRef(deal)} was closed in EstimAI. An offer can now be prepared.`,
      }),
    });
  } else {
    // E3 — the technical contact has work to do again, and the requester knows the deal waits.
    await announce(actor, {
      kind: "estimate_reopened",
      dealId: deal.id,
      recipientIds: [link.technicalUserId, link.requestedBy],
      severity: "warning",
      email: true,
      href: dealHref(deal.id),
      copy: () => ({
        title: `Estimate reopened: ${dealRef(deal)}`,
        body: `The estimate for ${dealRef(deal)} was reopened in EstimAI. The deal waits for it to be closed again.`,
      }),
    });
  }
}
