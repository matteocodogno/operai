/**
 * The process-level ffmpeg slot (specs/021-meetings plan.md § Amendment 2026-11-05 G-11; ADR-0062, ADR-0064).
 *
 * ADR-0064 allows ONE ffmpeg at a time per process. Until the Google change the job runner enforced it by job
 * KIND (never two `prepare_audio` at once). The `transcribe` job now runs ffmpeg too (it splits a long
 * recording), but only for seconds before it waits up to 45 minutes on Google, so a kind-level exclusion
 * would block every `prepare_audio` for that whole wait. The exclusion therefore moves to the invocation: each
 * stretch of ffmpeg work runs inside `withFfmpegSlot`, and a job that is waiting on Google holds nothing.
 *
 * FIFO and abortable: a job whose lease is lost while it queues leaves the queue without ever running.
 */

interface Waiter {
  readonly grant: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

let busy = false;
const queue: Waiter[] = [];

function release(): void {
  const next = queue.shift();
  if (next) {
    next.signal?.removeEventListener("abort", next.onAbort);
    next.grant(); // the slot stays busy: ownership passes straight to the next waiter
  } else {
    busy = false;
  }
}

function acquire(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  if (!busy) {
    busy = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: resolve,
      signal,
      onAbort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal!.reason ?? new Error("aborted"));
      },
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    queue.push(waiter);
  });
}

/** Runs `work` while holding the process's one ffmpeg slot; released when it settles, however it settles. */
export async function withFfmpegSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(signal);
  try {
    return await work();
  } finally {
    release();
  }
}

/** Tests only: how many callers are waiting, and whether the slot is held. */
export const ffmpegSlotState = (): { readonly busy: boolean; readonly waiting: number } => ({ busy, waiting: queue.length });
