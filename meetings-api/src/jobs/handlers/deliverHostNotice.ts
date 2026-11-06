import { db } from "../../lib/db";
import { attemptDelivery, noticeRetryDelayMs } from "../../hosts/notices";
import { TransientJobError, type JobHandler } from "../runner";

/**
 * Delivers an `unlinked` / `deleted` host notice until it is delivered (specs/021 T20,
 * AC-14.6; plan.md § Host integration contract → "Delivery"). The job was queued with the
 * notice, due a minute after the change; each failure re-queues it through the runner
 * (`TransientJobError` with the schedule's delay: 5 m, 30 m, 2 h, then every 6 h) and its
 * attempt cap is effectively unlimited, so nothing but delivery (or the host saying the
 * entity or the contract is gone for good) ends it.
 *
 * It does not need the meeting: the row was written without a title and the meeting may be
 * deleted already. A row that is gone was delivered or superseded; there is nothing to do.
 */
export const deliverHostNotice: JobHandler = async (ctx) => {
  const noticeId = ctx.job.noticeId;
  if (!noticeId) return;

  const row = await db.hostNotice.findUnique({ where: { id: noticeId } });
  // Delivered by the awaited attempt, or refused for good earlier: nothing left to retry.
  if (!row || row.state === "failed") return;

  const result = await attemptDelivery(row);
  if (result.state === "delivered" || result.permanent) return;
  throw new TransientJobError(result.code, noticeRetryDelayMs(ctx.attempt));
};
