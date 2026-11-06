import { describe, expect, it } from "bun:test";
import { ffmpegSlotState, withFfmpegSlot } from "./ffmpegSlot";

// ADR-0064: one ffmpeg at a time per process, enforced per invocation (plan G-11), not per job kind.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withFfmpegSlot", () => {
  it("never runs two bodies at once and keeps first-come order", async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withFfmpegSlot(async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(n);
          await sleep(10);
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(ffmpegSlotState()).toEqual({ busy: false, waiting: 0 });
  });

  it("returns the body's value and releases the slot when it throws", async () => {
    expect(await withFfmpegSlot(async () => 42)).toBe(42);
    await expect(
      withFfmpegSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withFfmpegSlot(async () => "next")).toBe("next");
    expect(ffmpegSlotState().busy).toBe(false);
  });

  it("a caller aborted while it waits leaves the queue and never runs", async () => {
    const holder = withFfmpegSlot(() => sleep(40));
    const controller = new AbortController();
    let ran = false;
    const waiting = withFfmpegSlot(async () => void (ran = true), controller.signal);
    await sleep(5);
    expect(ffmpegSlotState().waiting).toBe(1);
    controller.abort(new Error("lease lost"));
    await expect(waiting).rejects.toThrow("lease lost");
    await holder;
    expect(ran).toBe(false);
    expect(ffmpegSlotState()).toEqual({ busy: false, waiting: 0 });
  });

  it("an already-aborted caller does not even take the slot", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withFfmpegSlot(async () => 1, controller.signal)).rejects.toBeDefined();
    expect(ffmpegSlotState().busy).toBe(false);
  });

  it("a waiter ahead of an aborted one still gets the slot, then the one behind", async () => {
    const order: string[] = [];
    const first = withFfmpegSlot(async () => {
      order.push("first");
      await sleep(20);
    });
    const controller = new AbortController();
    const second = withFfmpegSlot(async () => void order.push("second"), controller.signal).catch(() => order.push("second-aborted"));
    const third = withFfmpegSlot(async () => void order.push("third"));
    controller.abort();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second-aborted", "third"]);
  });
});
