/**
 * The durable job runner (specs/021-meetings plan.md D-6, ADR-0062; AC-6.9, AC-7.9).
 *
 * Work that must outlive a request (normalising audio, transcribing, summarising,
 * delivering a host notice) is a row in `meeting_job`. A route enqueues it in its own
 * transaction (`enqueueJob`, which also NOTIFYs); a worker loop INSIDE this process
 * claims and runs it:
 *
 *   - wakes on LISTEN/NOTIFY, or on a 30 s idle poll of its OWN queue;
 *   - claims with `SELECT … FOR UPDATE SKIP LOCKED`: a queued job that is due, or a
 *     running one whose LEASE has expired (the process holding it died);
 *   - lease 2 minutes, heartbeated every 30 s; a heartbeat that finds the claim gone
 *     aborts the handler's signal;
 *   - at most 2 jobs at a time; ffmpeg is exclusive per INVOCATION (`withFfmpegSlot`, ADR-0064 / plan
 *     G-11), not per job kind: a `transcribe` waiting on Google holds no slot and blocks nobody;
 *   - a transient error is retried up to the job's `maxAttempts` (default 3) with
 *     backoff 30 s, 2 min, 10 min; a permanent error fails at once;
 *   - SIGTERM: stop claiming, let running work finish within the grace period; what
 *     is cut off is re-claimed when its lease expires.
 *
 * THE DISTINCTION FROM ADR-0013, plainly. ADR-0013 forbids a sweep that writes
 * LIFECYCLE STATE BY TIME. This runner only executes work somebody asked for, and the
 * only rows it writes are `meeting_job` rows (its own state, lease and retry clock). It
 * never touches a `meeting` row and never scans for "expired" things: `interrupted`,
 * audio expiry, frozen, stale summaries, stuck answers and the rate-limit window are all
 * derived on read. A static test of this file pins that.
 *
 * CLAIMS. Every claim increments `attempts`; the pair (job id, attempts) names ONE
 * claim. Every write the runner makes about a job (heartbeat, done, retry, fail) is a
 * compare-and-set on that pair while the job is `running`, so a handler that stalled past
 * its lease and was re-claimed by someone else cannot overwrite the new claim's outcome.
 * A handler commits its own result through `ctx.commit`, which takes the job row `FOR
 * UPDATE` and re-checks the claim inside the same transaction: a stale claim's result is
 * discarded, not applied. The enqueue-time `attemptId` (e.g. a summary's) is separate and
 * is the HANDLER's guard on its target row; the runner only hands it over.
 *
 * Logs name the job kind, its id, the attempt, a closed error code and durations. Never a
 * message, a title or a meeting's content (AC-4.10).
 */

import { Client } from "pg";
import { Prisma, type JobKind, type PrismaClient } from "../lib/generated/prisma/client";

export const JOBS_CHANNEL = "meetings_jobs";

const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const IDLE_POLL_MS = 30_000;
const CONCURRENCY = 2;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
const DEFAULT_MAX_ATTEMPTS = 3;
const LISTEN_RECONNECT_MS = 5_000;

// ─── Errors a handler throws ─────────────────────────────────────────────────

/** Will never succeed by retrying (unreadable audio, a provider that rejected the input). Fails the job at once. */
export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PermanentJobError";
  }
}

/** Worth retrying (429, 5xx, a timeout). `retryAfterMs` overrides the default backoff, e.g. for host notices. */
export class TransientJobError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "TransientJobError";
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClaimedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly meetingId: string | null;
  readonly summaryId: string | null;
  readonly noticeId: string | null;
  /** The enqueue-time token (e.g. a summary's attemptId): the handler's guard on its target row. */
  readonly attemptId: string | null;
  /** How many times the job has been claimed, this claim included. */
  readonly attempts: number;
  readonly maxAttempts: number;
}

export type CommitResult<T> = { readonly committed: true; readonly value: T } | { readonly committed: false };

export interface JobContext {
  readonly job: ClaimedJob;
  readonly attemptId: string | null;
  /** 1 for the first run. */
  readonly attempt: number;
  /** Aborted when the lease is lost or the runner gave up waiting at shutdown. */
  readonly signal: AbortSignal;
  /**
   * Runs `fn` in one transaction, but only if this claim still holds the job (state
   * `running`, same attempts): the job row is locked `FOR UPDATE` for the duration, so
   * nobody can re-claim it mid-commit. A stale claim gets `{ committed: false }` and `fn`
   * never runs.
   */
  commit<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<CommitResult<T>>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  readonly db: PrismaClient;
  readonly handlers: Partial<Record<JobKind, JobHandler>>;
  /** A dedicated connection for LISTEN. `null` (or absent) = no LISTEN, the idle poll only. */
  readonly listenUrl?: string | null;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly idlePollMs?: number;
  readonly concurrency?: number;
  readonly backoffMs?: readonly number[];
}

export interface Runner {
  /** Starts the idle poll and the LISTEN connection, then runs a first tick. */
  start(): Promise<void>;
  /** Claims what is due and fits, and starts it. Resolves once claiming is done, not when the jobs end. */
  tick(): Promise<void>;
  /** A wake-up without waiting. */
  wake(): void;
  /** Stops claiming and waits up to `drainMs` for running work; the rest is re-claimed after its lease. */
  stop(drainMs?: number): Promise<void>;
  /** Jobs running in this process right now. */
  running(): number;
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  readonly kind: JobKind;
  readonly meetingId?: string;
  readonly summaryId?: string;
  readonly noticeId?: string;
  readonly attemptId?: string;
  readonly maxAttempts?: number;
  readonly runAfter?: Date;
}

/**
 * Inserts a job and NOTIFYs the worker, inside the caller's transaction: the notification
 * is delivered at COMMIT, so a rolled-back request wakes nobody and leaves no job.
 */
export async function enqueueJob(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<string> {
  const job = await tx.meetingJob.create({
    data: {
      kind: input.kind,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ...(input.meetingId !== undefined ? { meetingId: input.meetingId } : {}),
      ...(input.summaryId !== undefined ? { summaryId: input.summaryId } : {}),
      ...(input.noticeId !== undefined ? { noticeId: input.noticeId } : {}),
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      ...(input.runAfter !== undefined ? { runAfter: input.runAfter } : {}),
    },
    select: { id: true },
  });
  await tx.$executeRaw`SELECT pg_notify(${JOBS_CHANNEL}, ${job.id})`;
  return job.id;
}

// ─── The runner ──────────────────────────────────────────────────────────────

/** A `timestamp(3)` (UTC) value from an instant, independent of the session's time zone. */
const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

interface ClaimRow {
  id: string;
  kind: JobKind;
  meetingId: string | null;
  summaryId: string | null;
  noticeId: string | null;
  attemptId: string | null;
  attempts: number;
  maxAttempts: number;
}

export function createRunner(options: RunnerOptions): Runner {
  const { db, handlers } = options;
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const concurrency = options.concurrency ?? CONCURRENCY;
  const backoff = options.backoffMs ?? BACKOFF_MS;

  let stopped = false;
  let ticking = false;
  let again = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let listener: Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const active = new Map<string, { kind: JobKind; done: Promise<void>; abort: () => void; stopHeartbeat: () => void }>();

  // ── claiming ──────────────────────────────────────────────────────────────

  async function claimOne(): Promise<ClaimRow | null> {
    const at = now();
    // A crashed job that has used all its attempts is failed, not run again.
    await db.$executeRaw`
      UPDATE "meeting_job"
         SET "state" = 'failed', "leaseUntil" = NULL, "lastErrorCode" = 'lease_expired', "updatedAt" = ${ts(at)}
       WHERE "state" = 'running' AND "leaseUntil" < ${ts(at)} AND "attempts" >= "maxAttempts"`;

    const rows = await db.$queryRaw<ClaimRow[]>`
      UPDATE "meeting_job"
         SET "state" = 'running',
             "attempts" = "attempts" + 1,
             "leaseUntil" = ${ts(new Date(at.getTime() + leaseMs))},
             "updatedAt" = ${ts(at)}
       WHERE "id" = (
         SELECT "id" FROM "meeting_job"
          WHERE (
                  ("state" = 'queued' AND "runAfter" <= ${ts(at)})
               OR ("state" = 'running' AND "leaseUntil" < ${ts(at)} AND "attempts" < "maxAttempts")
                )
          ORDER BY "runAfter", "createdAt"
          LIMIT 1
            FOR UPDATE SKIP LOCKED)
      RETURNING "id", "kind", "meetingId", "summaryId", "noticeId", "attemptId", "attempts", "maxAttempts"`;
    return rows[0] ?? null;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        while (!stopped && active.size < concurrency) {
          let row: ClaimRow | null;
          try {
            row = await claimOne();
          } catch (error) {
            console.error("[jobs] could not claim:", error instanceof Error ? error.name : "unknown error");
            break;
          }
          if (!row) break;
          launch(row);
        }
      } while (again && !stopped);
    } finally {
      ticking = false;
    }
  }

  // ── running ───────────────────────────────────────────────────────────────

  /** The compare-and-set that names ONE claim of a job. */
  const mine = (job: ClaimRow) => ({ id: job.id, attempts: job.attempts, state: "running" as const });

  function launch(row: ClaimRow): void {
    const controller = new AbortController();
    const started = Date.now();
    const handler = handlers[row.kind];

    const heartbeat = setInterval(() => {
      void db.meetingJob
        .updateMany({ where: mine(row), data: { leaseUntil: new Date(now().getTime() + leaseMs) } })
        .then((r) => {
          if (r.count === 0 && !controller.signal.aborted) {
            console.warn(`[jobs] lease lost kind=${row.kind} id=${row.id} attempt=${row.attempts}`);
            controller.abort();
          }
        })
        .catch(() => {});
    }, heartbeatMs);
    const stopHeartbeat = () => clearInterval(heartbeat);

    const ctx: JobContext = {
      job: row,
      attemptId: row.attemptId,
      attempt: row.attempts,
      signal: controller.signal,
      commit: (fn) =>
        db.$transaction(async (tx) => {
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "meeting_job"
             WHERE "id" = ${row.id} AND "attempts" = ${row.attempts} AND "state" = 'running'
               FOR UPDATE`;
          if (held.length === 0) return { committed: false } as const;
          return { committed: true, value: await fn(tx) } as const;
        }),
    };

    const run = (async () => {
      try {
        if (!handler) throw new PermanentJobError("no_handler");
        await handler(ctx);
        const done = await db.meetingJob.updateMany({
          where: mine(row),
          data: { state: "done", leaseUntil: null, lastErrorCode: null },
        });
        if (done.count === 0) {
          console.warn(`[jobs] stale result discarded kind=${row.kind} id=${row.id} attempt=${row.attempts}`);
          return;
        }
        console.log(`[jobs] done kind=${row.kind} id=${row.id} attempt=${row.attempts} ms=${Date.now() - started}`);
      } catch (error) {
        await settleFailure(row, error, started);
      } finally {
        stopHeartbeat();
        active.delete(row.id);
        void tick();
      }
    })();

    active.set(row.id, { kind: row.kind, done: run, abort: () => controller.abort(), stopHeartbeat });
  }

  /** Retry with backoff, or fail: always as a compare-and-set on THIS claim. */
  async function settleFailure(row: ClaimRow, error: unknown, started: number): Promise<void> {
    const permanent = error instanceof PermanentJobError;
    // A closed code, never the message: an error message can carry content.
    const code =
      error instanceof PermanentJobError || error instanceof TransientJobError ? error.code : "unexpected";
    const exhausted = row.attempts >= row.maxAttempts;
    const fail = permanent || exhausted;

    const delay =
      error instanceof TransientJobError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : (backoff[Math.min(row.attempts - 1, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 0);

    try {
      const result = await db.meetingJob.updateMany({
        where: mine(row),
        data: fail
          ? { state: "failed", leaseUntil: null, lastErrorCode: code }
          : { state: "queued", leaseUntil: null, lastErrorCode: code, runAfter: new Date(now().getTime() + delay) },
      });
      if (result.count === 0) {
        console.warn(`[jobs] stale failure discarded kind=${row.kind} id=${row.id} attempt=${row.attempts}`);
        return;
      }
      console.warn(
        fail
          ? `[jobs] failed kind=${row.kind} id=${row.id} attempt=${row.attempts} code=${code} ms=${Date.now() - started}`
          : `[jobs] retry kind=${row.kind} id=${row.id} attempt=${row.attempts} code=${code} in_ms=${delay}`,
      );
    } catch {
      // The lease will lapse and the job will be re-claimed: nothing else to do.
      console.error(`[jobs] could not record the outcome kind=${row.kind} id=${row.id}`);
    }
  }

  // ── LISTEN / lifecycle ────────────────────────────────────────────────────

  function scheduleReconnect(url: string): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Notifications sent while we were away are gone: a tick picks up what they announced.
      connectListener(url)
        .then(() => tick())
        .catch(() => scheduleReconnect(url));
    }, LISTEN_RECONNECT_MS);
  }

  async function connectListener(url: string): Promise<void> {
    const client = new Client({ connectionString: url });
    client.on("notification", () => void tick());
    const lost = () => {
      if (stopped || listener !== client) return;
      listener = null;
      console.warn("[jobs] LISTEN connection lost; reconnecting");
      scheduleReconnect(url);
    };
    client.on("error", lost);
    client.on("end", lost);
    await client.connect();
    await client.query(`LISTEN ${JOBS_CHANNEL}`);
    listener = client;
  }

  return {
    tick,
    wake: () => void tick(),
    running: () => active.size,

    async start() {
      stopped = false;
      idleTimer = setInterval(() => void tick(), idlePollMs);
      if (options.listenUrl) {
        try {
          await connectListener(options.listenUrl);
        } catch {
          // The idle poll still works; keep trying to LISTEN in the background.
          console.error("[jobs] could not LISTEN; relying on the idle poll");
          scheduleReconnect(options.listenUrl);
        }
      }
      await tick();
    },

    async stop(drainMs = 25_000) {
      stopped = true;
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const closing = listener;
      listener = null;
      await closing?.end().catch(() => {});

      const running = [...active.values()];
      if (running.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), drainMs);
      });
      const outcome = await Promise.race([Promise.all(running.map((j) => j.done)).then(() => "drained" as const), timedOut]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        // Stop heartbeating what we are abandoning: its lease lapses and it is re-claimed.
        console.warn(`[jobs] shutdown grace elapsed with ${active.size} job(s) still running; leases will lapse`);
        for (const job of active.values()) {
          job.stopHeartbeat();
          job.abort();
        }
      }
    },
  };
}
