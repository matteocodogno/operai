/**
 * The host-notice outbox (specs/021-meetings plan.md § Host integration contract →
 * "Delivery", ADR-0059; AC-11.8, AC-11.9, AC-14.6, AC-14.8, AC-14.10, AC-14.11).
 *
 * A change that a host must hear about (a meeting linked, retitled or moved, unlinked,
 * deleted) writes a `host_notice` row IN THE CHANGE'S TRANSACTION (`recordNotice`), so a
 * notice exists exactly when the change does. After the commit the route makes ONE awaited
 * attempt (`deliverNotices`, 5 s, never throws) so its response can say the notice failed.
 * What happens next depends on the event's policy:
 *
 *   manual           linked / changed. A failure stays `failed`, is shown to the creator
 *                    with "Try again" (`retryFailedNotices`, behind
 *                    `POST /meetings/:id/host-notice/retry`) and is NEVER retried silently
 *                    (AC-11.9, AC-14.8). A newer notice for the same meeting and entity
 *                    supersedes it.
 *   until_delivered  unlinked / deleted. The removal must happen even with no creator to
 *                    press a button (frozen, erased: AC-14.6), so a retry job is queued IN
 *                    THE SAME TRANSACTION (due in 1 minute): if the process dies right after
 *                    the commit the notice is not orphaned. A delivered notice removes the
 *                    row and the queued job. The job (`jobs/handlers/deliverHostNotice.ts`)
 *                    backs off 5 m, 30 m, 2 h, then every 6 h, loudly, until delivered.
 *
 * That job has NO `meetingId`: the meeting's row is deleted in the same transaction as the
 * `deleted` notice, and a foreign key would take the job with it.
 *
 * Content: a `linked`/`changed` row holds the title and start time; an `unlinked`/`deleted`
 * row holds neither (the input type has no field for them), so nothing with a title survives
 * a deletion (AC-4.6, amendment A3). A host that did not opt in (`notices: false`), or that
 * is not registered, gets no row and no call (AC-11.4, AC-14.11).
 *
 * Delivered rows are deleted. The host is idempotent on (meeting, seq), so a duplicate or
 * reordered delivery is harmless (AC-14.9).
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { NoticeEvent, NoticePolicy } from "../lib/generated/prisma/enums";
import { enqueueJob } from "../jobs/runner";
import { serviceTokens, type ServiceTokenProvider } from "../lib/serviceToken";
import { sendNotice as sendNoticeToHost } from "./client";
import { hostRegistry, type HostNotice, type HostRegistry, type NoticeResult } from "./registry";

/** The first retry job is due this long after the change. */
const FIRST_RETRY_MS = 60_000;
/** After retry job n fails: 5 m, 30 m, 2 h, then every 6 h (the first minute is `FIRST_RETRY_MS`). */
const RETRY_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
/** "Until delivered": the runner's attempt cap must never be what stops it. */
const UNTIL_DELIVERED_ATTEMPTS = 1_000_000;

/** How long to wait after retry-job claim number `claim` (1-based) failed. */
export function noticeRetryDelayMs(claim: number): number {
  return RETRY_SCHEDULE_MS[Math.min(Math.max(claim, 1) - 1, RETRY_SCHEDULE_MS.length - 1)]!;
}

// ─── Seams for tests ─────────────────────────────────────────────────────────

export interface NoticeDeps {
  readonly registry?: Pick<HostRegistry, "get">;
  /** `null` = no credential configured (nothing can be sent). Default: the environment's. */
  readonly tokens?: ServiceTokenProvider | null;
  readonly send?: typeof sendNoticeToHost;
}

let testDeps: NoticeDeps = {};
/** Tests only. */
export function setNoticeDepsForTests(deps: NoticeDeps | null): void {
  testDeps = deps ?? {};
}

// ─── Recording ───────────────────────────────────────────────────────────────

export interface NoticeMeeting {
  readonly id: string;
  readonly creatorUserId: string;
}

export interface NoticeTarget {
  readonly app: string;
  readonly entityType: string;
  readonly entityId: string;
}

/** `linked`/`changed` carry the title and start; `unlinked`/`deleted` cannot. */
export type NoticeInput =
  | { readonly event: "linked" | "changed"; readonly title: string; readonly startsAt: Date }
  | { readonly event: "unlinked" | "deleted" };

const policyOf = (event: NoticeEvent): NoticePolicy => (event === "linked" || event === "changed" ? "manual" : "until_delivered");

/**
 * Writes the outbox row (and, for an until-delivered event, its retry job) inside `tx` and
 * returns its id, or `null` when the host takes no notices. Call it in the same transaction
 * as the change, BEFORE deleting the meeting row: the per-meeting `seq` is taken from it.
 */
export async function recordNotice(
  tx: Prisma.TransactionClient,
  meeting: NoticeMeeting,
  target: NoticeTarget,
  input: NoticeInput,
  now: Date = new Date(),
): Promise<string | null> {
  const host = (testDeps.registry ?? hostRegistry()).get(target.app, target.entityType);
  if (!host?.notices) return null;

  // Taking the seq locks the meeting row for the rest of the transaction: two changes cannot share a number.
  const { hostNoticeSeq } = await tx.meeting.update({
    where: { id: meeting.id },
    data: { hostNoticeSeq: { increment: 1 } },
    select: { hostNoticeSeq: true },
  });

  const policy = policyOf(input.event);
  if (policy === "manual") {
    // Whatever failed before about this entity is out of date now.
    await tx.hostNotice.deleteMany({
      where: {
        meetingId: meeting.id,
        hostApp: target.app,
        entityType: target.entityType,
        entityId: target.entityId,
        policy: "manual",
      },
    });
  }

  const carries = input.event === "linked" || input.event === "changed";
  const row = await tx.hostNotice.create({
    data: {
      hostApp: target.app,
      entityType: target.entityType,
      entityId: target.entityId,
      meetingId: meeting.id,
      seq: hostNoticeSeq,
      event: input.event,
      title: carries ? input.title : null,
      startsAt: carries ? input.startsAt : null,
      creatorUserId: meeting.creatorUserId,
      policy,
    },
    select: { id: true },
  });

  if (policy === "until_delivered") {
    await enqueueJob(tx, {
      kind: "deliver_host_notice",
      noticeId: row.id,
      maxAttempts: UNTIL_DELIVERED_ATTEMPTS,
      runAfter: new Date(now.getTime() + FIRST_RETRY_MS),
    });
  }
  return row.id;
}

// ─── Delivering ──────────────────────────────────────────────────────────────

type NoticeRow = Prisma.HostNoticeGetPayload<object>;

const toWire = (row: NoticeRow): HostNotice => ({
  noticeId: row.id,
  seq: row.seq,
  event: row.event,
  meeting: {
    id: row.meetingId,
    title: row.title,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    creatorId: row.creatorUserId,
  },
  entity: { type: row.entityType, id: row.entityId },
});

/**
 * One attempt at one row, and the bookkeeping that follows. Logs the host, the event and a
 * closed code; never an id, a title or a token (AC-4.10). Throws only on a database fault.
 */
export async function attemptDelivery(row: NoticeRow): Promise<NoticeResult> {
  const host = (testDeps.registry ?? hostRegistry()).get(row.hostApp, row.entityType);
  const tokens = testDeps.tokens !== undefined ? testDeps.tokens : serviceTokens;
  const result: NoticeResult = host
    ? await (testDeps.send ?? sendNoticeToHost)(host, toWire(row), tokens)
    : { state: "failed", permanent: true, code: "notices_not_supported" };

  const label = `${row.hostApp}/${row.entityType} event=${row.event}`;
  if (result.state === "delivered") {
    await settleDelivered(row.id);
    return result;
  }

  const gone = result.permanent && result.code === "entity_not_found" && row.policy === "until_delivered";
  if (gone) {
    // The host no longer has the entity, so there is nothing left to unlink or remove.
    console.warn(`[hosts] notice moot, entity gone host=${label}`);
    await settleDelivered(row.id);
    return result;
  }

  const attempts = row.attempts + 1;
  if (result.permanent) {
    console.error(`[hosts] notice REFUSED for good host=${label} code=${result.code} attempts=${attempts}`);
    await db.hostNotice.updateMany({ where: { id: row.id }, data: { state: "failed", attempts, lastErrorCode: result.code } });
    await db.meetingJob.deleteMany({ where: { noticeId: row.id, kind: "deliver_host_notice", state: "queued" } });
  } else if (row.policy === "manual") {
    console.warn(`[hosts] notice failed, left for the creator to retry host=${label} code=${result.code}`);
    await db.hostNotice.updateMany({ where: { id: row.id }, data: { state: "failed", attempts, lastErrorCode: result.code } });
  } else {
    console.error(`[hosts] notice NOT delivered, will be retried host=${label} code=${result.code} attempts=${attempts}`);
    await db.hostNotice.updateMany({ where: { id: row.id }, data: { attempts, lastErrorCode: result.code } });
  }
  return result;
}

async function settleDelivered(noticeId: string): Promise<void> {
  await db.$transaction([
    db.hostNotice.deleteMany({ where: { id: noticeId } }),
    // The retry job is moot; one that is running right now keeps its claim and simply finds no row.
    db.meetingJob.deleteMany({ where: { noticeId, kind: "deliver_host_notice", state: "queued" } }),
  ]);
}

/** The awaited attempt after commit. NEVER throws: the meeting action stands whatever happens here (AC-11.9). */
export async function deliverNotices(ids: readonly (string | null)[]): Promise<void> {
  const wanted = ids.filter((id): id is string => id !== null);
  if (wanted.length === 0) return;
  try {
    const rows = await db.hostNotice.findMany({ where: { id: { in: wanted } }, orderBy: { seq: "asc" } });
    await Promise.all(
      rows.map((row) =>
        attemptDelivery(row).catch(() => {
          console.error(`[hosts] could not record the outcome of a notice host=${row.hostApp}/${row.entityType}`);
        }),
      ),
    );
  } catch {
    console.error("[hosts] could not attempt host notices");
  }
}

/** "Try again" (AC-11.9): one more attempt at every failed manual notice of this meeting. */
export async function retryFailedNotices(meetingId: string): Promise<void> {
  const failed = await db.hostNotice.findMany({
    where: { meetingId, policy: "manual", state: "failed" },
    select: { id: true },
    orderBy: { seq: "asc" },
  });
  await deliverNotices(failed.map((n) => n.id));
}
