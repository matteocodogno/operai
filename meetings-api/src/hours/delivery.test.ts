import { describe, expect, it } from "bun:test";
import { createKit } from "../test-support/routeKit";
import { HOURS_NOTICE_MAX_ATTEMPTS, hoursNoticeRetryDelayMs } from "./delivery";

// The retry schedule of the hours outbox (specs/20261112-meeting-hours T8, AC-4.2; plan § Delivering a notice step 4), and the
// test kit's part in keeping the outbox from leaking between tests. Delivery itself is proved through the real runner in
// `jobs/handlers/deliverHoursNotice.test.ts`; the migration's backfill in `delivery.backfill.test.ts`.

// At the top level, so the kit's teardown is registered for this file (not for a hook).
const kit = await createKit();

describe("hoursNoticeRetryDelayMs", () => {
  it("waits 30 s after the first failed attempt, 2 min after the second, 10 min after the third, then 30 min every time", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(hoursNoticeRetryDelayMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000]);
  });

  it("is never shorter than the first step, whatever it is asked", () => {
    expect(hoursNoticeRetryDelayMs(0)).toBe(30_000);
    expect(hoursNoticeRetryDelayMs(-3)).toBe(30_000);
  });

  it("is shorter than the host notices' (an entry a person is waiting for): 30 minutes at most, where theirs reaches 6 hours", async () => {
    const { noticeRetryDelayMs } = await import("../hosts/notices");
    expect(hoursNoticeRetryDelayMs(100)).toBeLessThan(noticeRetryDelayMs(100));
  });

  it("is until delivered: the job's attempt cap is far beyond what any outage reaches", () => {
    expect(HOURS_NOTICE_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe("the route kit", () => {
  it("empties the hours outbox between tests (hours_notice has no foreign key to meeting, so no cascade does it)", async () => {
    await kit.db.hoursNotice.createMany({
      data: [
        { meetingId: "m1", seq: 1, kind: "state" },
        { meetingId: "m1", seq: 2, kind: "deleted" },
      ],
    });
    // (At least: a previous test file may have left rows of its own, which is the very thing being prevented.)
    expect(await kit.db.hoursNotice.count()).toBeGreaterThanOrEqual(2);
    await kit.reset();
    expect(await kit.db.hoursNotice.count()).toBe(0);
  });
});
