/**
 * `POST /system/meeting-host/v1/notices` (specs/021 T8, US-14; plan.md § Host
 * integration contract and § Data model crm-api; ADR-0059): the host half of
 * "a meeting was linked / changed / unlinked / deleted". meetings-api sends it
 * as itself (scoped service JWT, scope `host-notices.send`, sub allowlist
 * `system:meetings-api`); no user JWT is a credential here.
 *
 * The reconciler mirrors a meeting as ONE `meeting` activity, found by
 * `activity.meetingId` (UNIQUE). It runs in one transaction under
 * `pg_advisory_xact_lock(hash(meetingId))`, so concurrent deliveries for the same
 * meeting serialise, and orders notices by `seq` through `meeting_host_state`
 * (content-free: the meeting id and the highest seq applied):
 *
 *   seq <= lastSeq   -> nothing happens, `{ applied: false }` (duplicates, retries and
 *                       reordering are harmless, AC-14.9);
 *   linked           -> the deal must exist (422 entity_not_found, permanent); upsert the
 *                       activity (a relink MOVES it to the new deal and its company);
 *   changed          -> update subject and occurredAt IF the row exists; never recreates
 *                       one its author deleted by hand;
 *   unlinked         -> delete the row if it is on that deal;
 *   deleted          -> delete the row wherever it is.
 *
 * Every event then sets `lastSeq = seq`, `deleted` included, so a late lower-seq
 * `linked` cannot bring a deleted meeting back. A rejected notice (422) rolls the
 * transaction back and records nothing, so the same seq can be retried.
 *
 * The author is the meeting's `creatorId`. crm-api trusts it because meetings-api
 * resolved the deal AS that creator in the same request before emitting `linked`;
 * the author-only edit rule of specs/017 AC-4.2 then applies unchanged (AC-14.3).
 * The body is strict: any other key is a 422, so nothing but this shape (no agenda,
 * no transcript, no summary) can ever reach the CRM.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "../auth/systemAuth.middleware";
import { db } from "../lib/db";
import { commonErrors } from "../lib/http";
import { unprocessable, validationHook } from "../lib/problem";

export const HOST_NOTICES_SCOPE = "host-notices.send";
export const HOST_NOTICES_CALLERS = ["system:meetings-api"] as const;

/** Postgres INTEGER ceiling: `meeting_host_state.lastSeq` is an Int. */
const MAX_SEQ = 2_147_483_647;

const NoticeBody = z
  .object({
    noticeId: z.string().uuid(),
    seq: z.number().int().min(0).max(MAX_SEQ),
    event: z.enum(["linked", "changed", "unlinked", "deleted"]),
    meeting: z
      .object({
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(200).nullable(),
        startsAt: z.string().datetime({ offset: true }).nullable(),
        creatorId: z.string().min(1).max(64),
      })
      .strict(),
    entity: z.object({ type: z.literal("deal"), id: z.string().min(1).max(64) }).strict(),
  })
  .strict()
  .superRefine((notice, ctx) => {
    // `linked`/`changed` carry the title and the start; `unlinked`/`deleted` carry neither, so
    // nothing with a title survives a deletion in meetings-api's outbox (AC-4.6, amendment A3).
    const carries = notice.event === "linked" || notice.event === "changed";
    for (const field of ["title", "startsAt"] as const) {
      if (carries && notice.meeting[field] === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meeting", field], message: `${field} is required for ${notice.event}` });
      }
      if (!carries && notice.meeting[field] !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meeting", field], message: `${field} must be null for ${notice.event}` });
      }
    }
  });
type Notice = z.infer<typeof NoticeBody>;

const callerOnly: MiddlewareHandler[] = [
  createSystemAuthMiddleware({ scope: HOST_NOTICES_SCOPE, allowedSubs: HOST_NOTICES_CALLERS }),
];

const noticeRoute = createRoute({
  method: "post",
  path: "/system/meeting-host/v1/notices",
  tags: ["Meeting host"],
  summary: "A meeting was linked, changed, unlinked or deleted (host contract v1, service JWT)",
  middleware: callerOnly,
  request: { body: { content: { "application/json": { schema: NoticeBody } }, required: true } },
  responses: {
    200: {
      description: "`applied: false` when the notice is a duplicate or older than one already applied",
      content: { "application/json": { schema: z.object({ applied: z.boolean() }) } },
    },
    401: commonErrors[401],
    422: commonErrors[422],
  },
});

export const meetingHostNoticesRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
  defaultHook: validationHook,
});

async function reconcile(notice: Notice): Promise<boolean> {
  const { seq, event, meeting, entity } = notice;
  return db.$transaction(async (tx) => {
    // One delivery per meeting at a time. The lock also covers the very first notice, when there is
    // no state row to lock yet. (`$executeRaw`: the function returns void, which `$queryRaw` cannot read.)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${meeting.id}, 0))`;

    const state = await tx.meetingHostState.findUnique({ where: { meetingId: meeting.id } });
    if (state && seq <= state.lastSeq) return false;

    if (event === "linked") {
      const deal = await tx.deal.findUnique({ where: { id: entity.id }, select: { id: true, companyId: true } });
      if (!deal) throw unprocessable("The deal does not exist", { field: "entity.id" }, "entity_not_found");
      const existing = await tx.activity.findUnique({ where: { meetingId: meeting.id }, select: { id: true, companyId: true } });
      const occurredAt = new Date(meeting.startsAt!);
      if (existing) {
        await tx.activity.update({
          where: { id: existing.id },
          data: {
            subject: meeting.title!,
            occurredAt,
            companyId: deal.companyId,
            dealId: deal.id,
            // A contact belongs to the company the activity is on (specs/017 AC-4.1).
            ...(existing.companyId !== deal.companyId ? { contactId: null } : {}),
          },
        });
      } else {
        await tx.activity.create({
          data: {
            type: "meeting",
            subject: meeting.title!,
            body: null,
            occurredAt,
            companyId: deal.companyId,
            dealId: deal.id,
            authorUserId: meeting.creatorId,
            meetingId: meeting.id,
          },
        });
      }
    } else if (event === "changed") {
      await tx.activity.updateMany({
        where: { meetingId: meeting.id },
        data: { subject: meeting.title!, occurredAt: new Date(meeting.startsAt!) },
      });
    } else if (event === "unlinked") {
      await tx.activity.deleteMany({ where: { meetingId: meeting.id, dealId: entity.id } });
    } else {
      await tx.activity.deleteMany({ where: { meetingId: meeting.id } });
    }

    await tx.meetingHostState.upsert({
      where: { meetingId: meeting.id },
      create: { meetingId: meeting.id, lastSeq: seq },
      update: { lastSeq: seq },
    });
    return true;
  });
}

meetingHostNoticesRouter.openapi(noticeRoute, async (c) => {
  const applied = await reconcile(c.req.valid("json"));
  return c.json({ applied }, 200);
});
