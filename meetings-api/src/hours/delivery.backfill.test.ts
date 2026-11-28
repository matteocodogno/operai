/**
 * The hours outbox migration and its release backfill (specs/20261112-meeting-hours T8; AC-1.1, AC-4.2; plan § Data model
 * "meetings-api", § Release backfill, R3).
 *
 * The migration that creates `hours_notice` also enqueues one notice and one `deliver_hours_notice` job for every
 * meeting that already has a duration and started in the last 14 days, so the meetings processed before the deploy
 * reach hours-api with no operator step. "Applying it to a database" has to mean a database with meetings in it, and
 * `meetings_test` is shared with every other test file: so, like hours-api's `migration.seed.test.ts`, this builds its
 * own. It applies every migration before this one to a throwaway schema inside a transaction that always rolls back,
 * inserts fixture meetings as that schema holds them, applies THIS migration (the SQL itself is what is proven, not a
 * copy of it) and reads what it left. Nothing survives whatever happens.
 *
 * Run as ONE transaction, which is also what makes it a faithful test of the enum: a value added to an existing enum
 * with `ALTER TYPE ... ADD VALUE` cannot be used in the transaction that adds it ("unsafe use of new value"), and the
 * backfill inserts jobs of the new kind in the same script.
 *
 * Needs a migrated `meetings_test` database (the `bun test` preload).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "prisma", "migrations");
const SCHEMA = "hours_notice_backfill_t8";

const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const at = directories.findIndex((name) => name.endsWith("_hours_notice"));
const sqlOf = (name: string) => readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");

afterAll(async () => {
  await db.$disconnect();
});

class Rollback extends Error {}

interface Fixture {
  readonly id: string;
  /** Interval before the transaction's `now()` (UTC) at which the meeting started; negative = in the future. */
  readonly startedAgo: string;
  readonly durationMs: number | null;
}

interface Outcome {
  readonly meetings: { id: string; hoursSeq: number }[];
  readonly notices: { id: string; meetingId: string; seq: number; kind: string; state: string; attempts: number; lastErrorCode: string | null }[];
  readonly jobs: {
    kind: string;
    state: string;
    noticeId: string | null;
    meetingId: string | null;
    maxAttempts: number;
    attempts: number;
    runAfterIsNow: boolean;
  }[];
}

/** Applies the migrations before this one, inserts `fixtures` as that schema holds them, applies this one, reads the result. */
async function backfill(fixtures: readonly Fixture[], timeZone = "UTC"): Promise<Outcome> {
  expect(at).toBeGreaterThan(0);
  let outcome: Outcome | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}`);
        for (const name of directories.slice(0, at)) await tx.$executeRawUnsafe(sqlOf(name));

        for (const f of fixtures) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "meeting" ("id", "title", "format", "startsAt", "language", "source", "creatorUserId", "durationMs", "updatedAt")
             VALUES ($1, 'Fixture', 'online', (now() AT TIME ZONE 'UTC') - $2::interval, 'en', 'recorded', 'creator', $3, now())`,
            f.id,
            f.startedAgo,
            f.durationMs,
          );
        }

        // The migration's own `now()` must not depend on the session's zone: apply it under a hostile one.
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
        await tx.$executeRawUnsafe(sqlOf(directories[at]!));
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);

        outcome = {
          meetings: await tx.$queryRawUnsafe(`SELECT "id", "hoursSeq" FROM "meeting" ORDER BY "id"`),
          notices: await tx.$queryRawUnsafe(
            `SELECT "id", "meetingId", "seq", "kind"::text AS "kind", "state"::text AS "state", "attempts", "lastErrorCode" FROM "hours_notice" ORDER BY "meetingId"`,
          ),
          jobs: await tx.$queryRawUnsafe(
            `SELECT "kind"::text AS "kind", "state"::text AS "state", "noticeId", "meetingId", "maxAttempts", "attempts",
                    abs(extract(epoch FROM ("runAfter" - (now() AT TIME ZONE 'UTC')))) < 5 AS "runAfterIsNow"
               FROM "meeting_job" ORDER BY "noticeId"`,
          ),
        };
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!outcome) throw new Error("the migration's result was not read");
  return outcome;
}

describe("the migration is there", () => {
  it("is a migration named ..._hours_notice, after every existing one", () => {
    expect(at).toBe(directories.length - 1);
  });
});

describe("the release backfill (plan § Release backfill)", () => {
  it("announces exactly the meeting that has a duration and started within 14 days: one notice at seq 1, one queued job, hoursSeq 1 on it only", async () => {
    const result = await backfill([
      { id: "recent", startedAgo: "3 days", durationMs: 1_800_000 },
      { id: "old", startedAgo: "20 days", durationMs: 1_800_000 },
      { id: "no-duration", startedAgo: "3 days", durationMs: null },
    ]);

    expect(result.meetings).toEqual([
      { id: "no-duration", hoursSeq: 0 },
      { id: "old", hoursSeq: 0 },
      { id: "recent", hoursSeq: 1 },
    ]);
    expect(result.notices).toHaveLength(1);
    const notice = result.notices[0]!;
    expect(notice).toMatchObject({ meetingId: "recent", seq: 1, kind: "state", state: "pending", attempts: 0, lastErrorCode: null });
    expect(notice.id.length).toBeGreaterThan(10);

    expect(result.jobs).toEqual([
      // until delivered (never capped by the runner), due now, no meetingId (a deleted meeting must not cascade it away)
      { kind: "deliver_hours_notice", state: "queued", noticeId: notice.id, meetingId: null, maxAttempts: 1_000_000, attempts: 0, runAfterIsNow: true },
    ]);
  });

  it("leaves a meeting whose duration is 0 (not known) alone", async () => {
    const result = await backfill([{ id: "zero", startedAgo: "1 day", durationMs: 0 }]);
    expect(result.meetings).toEqual([{ id: "zero", hoursSeq: 0 }]);
    expect(result.notices).toEqual([]);
    expect(result.jobs).toEqual([]);
  });

  it("announces every qualifying meeting once, each with its own notice and job", async () => {
    const result = await backfill([
      { id: "a", startedAgo: "1 hour", durationMs: 600_000 },
      { id: "b", startedAgo: "13 days", durationMs: 600_000 },
      { id: "c", startedAgo: "15 days", durationMs: 600_000 },
    ]);
    expect(result.notices.map((n) => n.meetingId)).toEqual(["a", "b"]);
    expect(result.jobs.map((j) => j.noticeId).sort()).toEqual(result.notices.map((n) => n.id).sort());
    expect(new Set(result.notices.map((n) => n.id)).size).toBe(2);
    expect(result.meetings).toEqual([
      { id: "a", hoursSeq: 1 },
      { id: "b", hoursSeq: 1 },
      { id: "c", hoursSeq: 0 },
    ]);
  });

  it("measures the 14 days in UTC whatever time zone the session runs in", async () => {
    // Read naively, a `timestamp` start is taken to be in the session's zone: at UTC+14 it would be 14 hours older than
    // it is, and the meeting that started 13 days 22 hours ago would fall outside the window.
    const fixtures: Fixture[] = [
      { id: "inside", startedAgo: "13 days 22 hours", durationMs: 600_000 },
      { id: "outside", startedAgo: "14 days 2 hours", durationMs: 600_000 },
    ];
    for (const zone of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      const result = await backfill(fixtures, zone);
      expect(result.notices.map((n) => n.meetingId)).toEqual(["inside"]);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.runAfterIsNow).toBe(true);
    }
  });

  it("applies to a database with no meeting and leaves the outbox empty", async () => {
    const result = await backfill([]);
    expect(result.meetings).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.jobs).toEqual([]);
  });
});
