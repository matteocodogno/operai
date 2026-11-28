import { attemptHoursDelivery, hoursNoticeRetryDelayMs } from "../../hours/delivery";
import { TransientJobError, type JobHandler } from "../runner";

/**
 * Delivers a hours notice to hours-api until it is delivered (specs/20261112-meeting-hours T8, AC-4.2; plan § Delivering a
 * notice). The job was queued with the notice, in the transaction of the change it announces, and carries only the notice's
 * id: no `meetingId` (a deleted meeting's row cascades its jobs away, and the notice of its deletion must outlive it) and no
 * personal data (the body is built from the meeting as it is when it is sent, `hours/delivery.ts`).
 *
 * Mirrors `deliverHostNotice`: each failure that time or an operator can fix re-queues the job through the runner
 * (`TransientJobError` with the schedule's delay: 30 s, 2 min, 10 min, then every 30 min) and its attempt cap is effectively
 * unlimited, so nothing but delivery, or hours-api refusing the body for good, ends it. A permanent refusal leaves the row
 * `failed` with its code (and ends the job normally); a notice whose row is gone was delivered, and there is nothing to do.
 */
export const deliverHoursNotice: JobHandler = async (ctx) => {
  const noticeId = ctx.job.noticeId;
  if (!noticeId) return;

  const result = await attemptHoursDelivery(noticeId);
  if (result.state === "retry") throw new TransientJobError(result.code, hoursNoticeRetryDelayMs(ctx.attempt));
};
