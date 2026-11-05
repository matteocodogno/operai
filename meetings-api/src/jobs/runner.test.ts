import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db";
import {
  JOBS_CHANNEL,
  PermanentJobError,
  TransientJobError,
  createRunner,
  enqueueJob,
  type JobContext,
  type JobHandler,
  type Runner,
} from "./runner";

// Needs a migrated `meetings_test` database. specs/021 AC-6.9, AC-7.9; ADR-0062.

const DATABASE_URL = process.env["DATABASE_URL"]!;
const runners: Runner[] = [];

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting" CASCADE');
});
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop(1_000)));
});
afterAll(async () => {
  await db.$disconnect();
});

/** A clock the test moves. */
function clock(start = Date.now() + 1_000) {
  const c = { t: start, now: () => new Date(c.t), advance: (ms: number) => void (c.t += ms) };
  return c;
}

function make(handlers: Partial<Record<string, JobHandler>>, extra: Partial<Parameters<typeof createRunner>[0]> = {}) {
  const runner = createRunner({ db, handlers, listenUrl: null, idlePollMs: 60_000, ...extra });
  runners.push(runner);
  return runner;
}

const insert = (data: { kind?: "prepare_audio" | "transcribe" | "summarize" | "deliver_host_notice"; [k: string]: unknown } = {}) =>
  db.meetingJob.create({ data: { kind: "transcribe", maxAttempts: 3, ...data } as never });

const get = (id: string) => db.meetingJob.findUniqueOrThrow({ where: { id } });
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const until = async (cond: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

let logged: string[];
let spies: ReturnType<typeof spyOn>[];
beforeEach(() => {
  logged = [];
  const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe("running a job", () => {
  it("claims a queued job, hands the handler its context and marks it done", async () => {
    const job = await insert({ attemptId: "attempt-A", meetingId: null });
    const seen: JobContext[] = [];
    const runner = make({ transcribe: async (ctx) => void seen.push(ctx) });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "done");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.job.id).toBe(job.id);
    expect(seen[0]!.job.kind).toBe("transcribe");
    expect(seen[0]!.attemptId).toBe("attempt-A");
    expect(seen[0]!.attempt).toBe(1);
    const done = await get(job.id);
    expect(done.attempts).toBe(1);
    expect(done.leaseUntil).toBeNull();
  });

  it("does not run a job before its runAfter", async () => {
    const c = clock();
    const job = await insert({ runAfter: new Date(c.t + 60_000) });
    let ran = 0;
    const runner = make({ transcribe: async () => void ran++ }, { now: c.now });
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(0);
    expect((await get(job.id)).state).toBe("queued");
    c.advance(61_000);
    await runner.tick();
    await until(() => ran === 1);
  });

  it("fails a job whose kind has no handler, at once, with a closed code", async () => {
    const job = await insert({ kind: "summarize" });
    const runner = make({});
    await runner.tick();
    await until(async () => (await get(job.id)).state === "failed");
    expect((await get(job.id)).lastErrorCode).toBe("no_handler");
  });
});

describe("leases", () => {
  it("re-claims a job whose lease expired (the process that held it died)", async () => {
    const c = clock();
    const job = await insert({ state: "running", attempts: 1, leaseUntil: new Date(c.t - 1_000) });
    const calls: number[] = [];
    const runner = make({ transcribe: async (ctx) => void calls.push(ctx.attempt) }, { now: c.now });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "done");
    expect(calls).toEqual([2]);
  });

  it("does not take a job whose lease is still live", async () => {
    const c = clock();
    const job = await insert({ state: "running", attempts: 1, leaseUntil: new Date(c.t + 60_000) });
    let ran = 0;
    const runner = make({ transcribe: async () => void ran++ }, { now: c.now });
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(0);
    expect((await get(job.id)).state).toBe("running");
  });

  it("fails, rather than re-runs, a job that has already used its attempts and lost its lease", async () => {
    const c = clock();
    const job = await insert({ state: "running", attempts: 3, maxAttempts: 3, leaseUntil: new Date(c.t - 1_000) });
    let ran = 0;
    const runner = make({ transcribe: async () => void ran++ }, { now: c.now });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "failed");
    expect(ran).toBe(0);
    expect((await get(job.id)).lastErrorCode).toBe("lease_expired");
  });

  it("heartbeats the lease so a long job is not re-claimed", async () => {
    const job = await insert();
    const release = deferred();
    let runs = 0;
    const handler: JobHandler = async () => {
      runs++;
      await release.promise;
    };
    // lease 150 ms, heartbeat every 40 ms; a second runner polls constantly
    const a = make({ transcribe: handler }, { leaseMs: 150, heartbeatMs: 40 });
    const b = make({ transcribe: handler }, { leaseMs: 150, heartbeatMs: 40 });
    await a.tick();
    await until(() => runs === 1);
    await new Promise((r) => setTimeout(r, 400));
    await b.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(1);
    release.resolve();
    await until(async () => (await get(job.id)).state === "done");
  });

  it("aborts the handler's signal when the lease is lost", async () => {
    const c = clock();
    const job = await insert();
    const started = deferred();
    const release = deferred();
    let aborted = false;
    const runner = make(
      {
        transcribe: async (ctx) => {
          ctx.signal.addEventListener("abort", () => (aborted = true));
          started.resolve();
          await release.promise;
        },
      },
      { now: c.now, leaseMs: 100, heartbeatMs: 30 },
    );
    await runner.tick();
    await started.promise;
    // someone else (or an operator) takes the row: the claim no longer matches
    await db.meetingJob.update({ where: { id: job.id }, data: { attempts: 99 } });
    await until(() => aborted);
    release.resolve();
  });
});

describe("two runners", () => {
  it("never run the same job twice", async () => {
    const ids = (await Promise.all(Array.from({ length: 30 }, () => insert()))).map((j) => j.id);
    const executions = new Map<string, number>();
    const handler: JobHandler = async (ctx) => {
      executions.set(ctx.job.id, (executions.get(ctx.job.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5));
    };
    const a = make({ transcribe: handler }, { concurrency: 2 });
    const b = make({ transcribe: handler }, { concurrency: 2 });
    await Promise.all([a.tick(), b.tick()]);
    await until(async () => (await db.meetingJob.count({ where: { state: "done" } })) === 30, 8_000);
    expect(executions.size).toBe(30);
    for (const id of ids) expect(executions.get(id)).toBe(1);
  });
});

describe("a job another transaction holds locked", () => {
  it("is skipped, not waited for: the runner claims the next due job at once", async () => {
    const locked = await insert({ runAfter: new Date(Date.now() - 2_000) });
    const other = await insert({ runAfter: new Date(Date.now() - 1_000) });
    const ran: string[] = [];
    const runner = make({ transcribe: async (ctx) => void ran.push(ctx.job.id) });
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "meeting_job" WHERE "id" = ${locked.id} FOR UPDATE`;
        await runner.tick();
        await until(() => ran.length === 1, 2_000);
      },
      { timeout: 8_000 },
    );
    expect(ran).toEqual([other.id]);
    expect((await get(locked.id)).state).toBe("queued");
  });
});

describe("failures", () => {
  it("retries a transient error with backoff 30 s, 2 min, then fails at the third attempt", async () => {
    const c = clock();
    const job = await insert();
    let calls = 0;
    const runner = make(
      {
        transcribe: async () => {
          calls++;
          throw new TransientJobError("provider_unavailable");
        },
      },
      { now: c.now },
    );

    await runner.tick();
    await until(async () => (await get(job.id)).state === "queued" && calls === 1);
    let row = await get(job.id);
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe("provider_unavailable");
    expect(row.runAfter.getTime()).toBe(c.t + 30_000);
    expect(row.leaseUntil).toBeNull();

    // not yet
    c.advance(29_000);
    await runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);

    c.advance(2_000);
    await runner.tick();
    await until(() => calls === 2);
    await until(async () => (await get(job.id)).state === "queued");
    row = await get(job.id);
    expect(row.runAfter.getTime()).toBe(c.t + 120_000);

    c.advance(121_000);
    await runner.tick();
    await until(async () => (await get(job.id)).state === "failed");
    row = await get(job.id);
    expect(calls).toBe(3);
    expect(row.attempts).toBe(3);
    expect(row.lastErrorCode).toBe("provider_unavailable");

    // failed is terminal
    c.advance(24 * 3_600_000);
    await runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(3);
  });

  it("treats an unexpected error as transient with the closed code 'unexpected'", async () => {
    const job = await insert();
    const runner = make({ transcribe: async () => { throw new TypeError("boom with details"); } });
    await runner.tick();
    await until(async () => (await get(job.id)).lastErrorCode === "unexpected");
    expect((await get(job.id)).state).toBe("queued");
  });

  it("a permanent error fails at once, with its code, after one attempt", async () => {
    const job = await insert();
    let calls = 0;
    const runner = make({
      transcribe: async () => {
        calls++;
        throw new PermanentJobError("audio_unreadable");
      },
    });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "failed");
    const row = await get(job.id);
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe("audio_unreadable");
    expect(calls).toBe(1);
  });

  it("honours a handler's own retry delay and the job's own attempt ceiling", async () => {
    const c = clock();
    const job = await insert({ kind: "deliver_host_notice", maxAttempts: 1_000_000 });
    const runner = make({ deliver_host_notice: async () => { throw new TransientJobError("host_unavailable", 5 * 60_000); } }, { now: c.now });
    await runner.tick();
    await until(async () => (await get(job.id)).lastErrorCode === "host_unavailable");
    const row = await get(job.id);
    expect(row.state).toBe("queued");
    expect(row.runAfter.getTime()).toBe(c.t + 5 * 60_000);
  });

  it("stores and logs a code, never an error message", async () => {
    const job = await insert({ meetingId: null });
    const runner = make({ transcribe: async () => { throw new Error("CANARY transcript text in an error"); } });
    await runner.tick();
    await until(async () => (await get(job.id)).lastErrorCode === "unexpected");
    const text = logged.join("\n");
    expect(text).not.toContain("CANARY");
    expect(text).toContain(job.id);
    expect(text).toContain("transcribe");
  });
});

describe("a stale claim (a result from an attempt that no longer holds the job)", () => {
  it("is discarded: the late finisher neither completes, requeues, nor commits over the claim that holds the job", async () => {
    const c = clock();
    const job = await insert();
    const aStarted = deferred();
    const aRelease = deferred();
    const bStarted = deferred();
    const bRelease = deferred();
    const outcomes: string[] = [];
    let aCommit: Awaited<ReturnType<JobContext["commit"]>> | null = null;

    let call = 0;
    const handler: JobHandler = async (ctx) => {
      const mine = ++call;
      if (mine === 1) {
        aStarted.resolve();
        await aRelease.promise; // A stalls past its lease
        aCommit = await ctx.commit(async () => {
          outcomes.push("A committed");
        });
        throw new TransientJobError("late_failure");
      }
      bStarted.resolve();
      await bRelease.promise; // B is still RUNNING when A wakes up
      await ctx.commit(async () => {
        outcomes.push("B committed");
      });
    };

    const a = make({ transcribe: handler }, { now: c.now, leaseMs: 120_000, heartbeatMs: 3_600_000 });
    const b = make({ transcribe: handler }, { now: c.now, leaseMs: 120_000, heartbeatMs: 3_600_000 });
    await a.tick();
    await aStarted.promise;

    c.advance(121_000); // A's lease expires; B takes the job
    await b.tick();
    await bStarted.promise;
    expect((await get(job.id)).attempts).toBe(2);

    aRelease.resolve(); // A wakes up while B holds the job: it commits, then fails
    await until(() => aCommit !== null);
    await new Promise((r) => setTimeout(r, 150));

    // A changed nothing: the job is still B's, running, not requeued, no error recorded
    const mid = await get(job.id);
    expect(mid.state).toBe("running");
    expect(mid.attempts).toBe(2);
    expect(mid.lastErrorCode).toBeNull();
    expect(aCommit as unknown).toEqual({ committed: false });
    expect(outcomes).toEqual([]);

    bRelease.resolve();
    await until(async () => (await get(job.id)).state === "done");
    expect(outcomes).toEqual(["B committed"]);
    expect((await get(job.id)).lastErrorCode).toBeNull();
  });

  it("lets a current claim commit, atomically with what the handler wrote", async () => {
    const job = await insert({ meetingId: null });
    let result: unknown;
    const runner = make({
      transcribe: async (ctx) => {
        result = await ctx.commit(async (tx) => {
          await tx.aiRequest.create({ data: { userId: "u", kind: "probe" } });
          return 7;
        });
      },
    });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "done");
    expect(result).toEqual({ committed: true, value: 7 });
    expect(await db.aiRequest.count({ where: { kind: "probe" } })).toBe(1);
    await db.aiRequest.deleteMany({ where: { kind: "probe" } });
  });
});

describe("concurrency", () => {
  it("runs at most 2 jobs at a time", async () => {
    await Promise.all(Array.from({ length: 6 }, () => insert()));
    let active = 0;
    let peak = 0;
    const runner = make({
      transcribe: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
      },
    });
    await runner.tick();
    await until(async () => (await db.meetingJob.count({ where: { state: "done" } })) === 6, 8_000);
    expect(peak).toBe(2);
  });

  it("runs at most one ffmpeg job (prepare_audio) at a time, while another kind uses the free slot", async () => {
    await Promise.all([insert({ kind: "prepare_audio" }), insert({ kind: "prepare_audio" }), insert({ kind: "prepare_audio" })]);
    await insert({ kind: "transcribe" });
    let prepareActive = 0;
    let preparePeak = 0;
    let transcribeRan = false;
    const runner = make({
      prepare_audio: async () => {
        prepareActive++;
        preparePeak = Math.max(preparePeak, prepareActive);
        await new Promise((r) => setTimeout(r, 60));
        prepareActive--;
      },
      transcribe: async () => void (transcribeRan = true),
    });
    await runner.tick();
    await until(async () => (await db.meetingJob.count({ where: { state: "done" } })) === 4, 8_000);
    expect(preparePeak).toBe(1);
    expect(transcribeRan).toBe(true);
  });
});

describe("waking up", () => {
  it("a NOTIFY from the enqueuing transaction runs the job at once, long before the idle poll", async () => {
    const ran = deferred();
    const runner = make({ transcribe: async () => ran.resolve() }, { listenUrl: DATABASE_URL, idlePollMs: 60_000 });
    await runner.start();
    const started = Date.now();
    await db.$transaction(async (tx) => {
      await enqueueJob(tx, { kind: "transcribe" });
    });
    await ran.promise;
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("enqueue in a rolled-back transaction leaves no job and wakes no one", async () => {
    let ran = 0;
    const runner = make({ transcribe: async () => void ran++ }, { listenUrl: DATABASE_URL, idlePollMs: 60_000 });
    await runner.start();
    await db.$transaction(async (tx) => {
      await enqueueJob(tx, { kind: "transcribe" });
      throw new Error("abort");
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    expect(ran).toBe(0);
    expect(await db.meetingJob.count()).toBe(0);
  });

  it("falls back to the idle poll of its own queue when nothing notifies", async () => {
    const ran = deferred();
    const runner = make({ transcribe: async () => ran.resolve() }, { idlePollMs: 50 });
    await runner.start();
    await insert(); // plain insert: no NOTIFY
    await ran.promise;
  });

  it("listens on the documented channel", () => {
    expect(JOBS_CHANNEL).toBe("meetings_jobs");
  });
});

describe("enqueueJob", () => {
  it("stores the kind, the targets, the enqueue-time attemptId and a default ceiling of 3 attempts", async () => {
    const id = await db.$transaction((tx) => enqueueJob(tx, { kind: "summarize", summaryId: "s1", attemptId: "att-1" }));
    const row = await get(id);
    expect(row).toMatchObject({ kind: "summarize", summaryId: "s1", attemptId: "att-1", state: "queued", attempts: 0, maxAttempts: 3 });
  });
});

describe("SIGTERM drain", () => {
  it("stop() claims nothing more, lets the running job finish, and leaves the rest queued", async () => {
    const [first, second, third] = await Promise.all([insert(), insert(), insert()]);
    const started = deferred();
    const release = deferred();
    let runs = 0;
    const runner = make(
      {
        transcribe: async () => {
          runs++;
          started.resolve();
          await release.promise;
        },
      },
      { concurrency: 1 },
    );
    await runner.tick();
    await started.promise;

    const stopping = runner.stop(5_000);
    release.resolve();
    await stopping;
    await runner.tick(); // a late wake must not claim anything now

    expect(runs).toBe(1);
    const states = await Promise.all([first, second, third].map(async (j) => (await get(j.id)).state));
    expect(states.filter((s) => s === "done")).toHaveLength(1);
    expect(states.filter((s) => s === "queued")).toHaveLength(2);
    expect(runner.running()).toBe(0);
  });

  it("gives up waiting after the grace period; the cut-off job is re-claimed once its lease expires", async () => {
    const c = clock();
    const job = await insert();
    const never = deferred();
    const runner = make({ transcribe: async () => never.promise }, { now: c.now, leaseMs: 120_000, heartbeatMs: 3_600_000 });
    await runner.tick();
    await until(async () => (await get(job.id)).state === "running");
    await runner.stop(50);
    expect((await get(job.id)).state).toBe("running");

    c.advance(121_000);
    let reran = 0;
    const next = make({ transcribe: async () => void reran++ }, { now: c.now });
    await next.tick();
    await until(() => reran === 1);
  });
});

describe("the handler table", () => {
  it("has a handler for every job kind; until its task lands each fails permanently as not_implemented", async () => {
    const { handlers } = await import("./handlers");
    expect(Object.keys(handlers).sort()).toEqual(["deliver_host_notice", "prepare_audio", "summarize", "transcribe"]);
    const ctx = { job: {}, attempt: 1, attemptId: null, signal: new AbortController().signal, commit: async () => ({ committed: false as const }) };
    // A kind drops out of this list when its task replaces the stub (T94: summarize).
    const implemented = new Set(["summarize"]);
    for (const [kind, handler] of Object.entries(handlers)) {
      if (implemented.has(kind)) continue;
      const error = await handler(ctx as never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe("not_implemented");
    }
  });
});

describe("what the runner may do to a meeting (ADR-0013/0062)", () => {
  const source = readFileSync(join(import.meta.dir, "runner.ts"), "utf8");
  // code, not comments
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never writes a meeting row", () => {
    expect(code).not.toMatch(/\.meeting\.(update|updateMany|upsert|create|delete)/);
    expect(code).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+"?meeting"?[\s(]/i);
  });

  it("never reads a lifecycle timestamp of a meeting", () => {
    for (const field of ["audioCreatedAt", "audioDeletedAt", "processingStartedAt", "processedAt", "lastBeatAt", "lastChunkAt", "startsAt", "consentAt"]) {
      expect(code).not.toContain(field);
    }
  });

  it("is the only lifecycle it knows: job state, leases and retries", () => {
    expect(code).toContain('"meeting_job"');
  });
});
