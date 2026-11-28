/**
 * The initial lists (specs/20261112-time-tracking T10; AC-3.7, A15, AC-3.2): a NEW installation starts with exactly the
 * categories and work types of the spec, under the fixed ids of plan § Data model.
 *
 * "A new installation" has to mean a database nobody has touched, and `hours_test` is shared with
 * every other test file (which add, retire and delete rows). So this test builds its own: it
 * applies every migration, in order, to a throwaway schema inside a transaction that always
 * rolls back, and reads the rows from there. The migration SQL itself is what is proven, not a
 * copy of it, and nothing is left behind whatever happens.
 *
 * Runs against the `*_test` database (src/test-support/env.ts, the `bun test` preload).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./lib/db";
import type { Prisma } from "./lib/generated/prisma/client";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "prisma", "migrations");

const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));

interface CategoryRow {
  id: string;
  name: string;
  requiresNote: boolean;
  retiredAt: Date | null;
  createdBy: string;
}
interface WorkTypeRow {
  id: string;
  list: string;
  name: string;
  retiredAt: Date | null;
  createdBy: string;
}

class Rollback extends Error {}

/** The rows a database holds right after every migration, read from a schema that is dropped again. */
async function freshInstallation(): Promise<{ categories: CategoryRow[]; workTypes: WorkTypeRow[] }> {
  let result: { categories: CategoryRow[]; workTypes: WorkTypeRow[] } | undefined;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("CREATE SCHEMA seed_check");
      await tx.$executeRawUnsafe("SET LOCAL search_path TO seed_check");
      for (const sql of migrations) await tx.$executeRawUnsafe(sql);
      const categories = await tx.$queryRawUnsafe<CategoryRow[]>(
        `SELECT "id", "name", "requiresNote", "retiredAt", "createdBy" FROM time_category ORDER BY "id"`,
      );
      const workTypes = await tx.$queryRawUnsafe<WorkTypeRow[]>(
        `SELECT "id", "list"::text AS "list", "name", "retiredAt", "createdBy" FROM work_type ORDER BY "id"`,
      );
      result = { categories, workTypes };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!result) throw new Error("the seed rows were not read");
  return result;
}

describe("a new installation (AC-3.7, A15)", () => {
  it("holds exactly the four categories, Other being the one that requires a note", async () => {
    const { categories } = await freshInstallation();
    expect(categories.map(({ id, name, requiresNote }) => ({ id, name, requiresNote }))).toEqual([
      { id: "tc-administration", name: "Administration", requiresNote: false },
      { id: "tc-other", name: "Other", requiresNote: true },
      { id: "tc-talk-preparation", name: "Talk preparation", requiresNote: false },
      { id: "tc-training", name: "Training", requiresNote: false },
    ]);
  });

  it("holds exactly the four project work types and the four deal work types", async () => {
    const { workTypes } = await freshInstallation();
    expect(workTypes.map(({ id, list, name }) => ({ id, list, name }))).toEqual([
      { id: "wt-deal-analysis", list: "deal", name: "Analysis" },
      { id: "wt-deal-demo", list: "deal", name: "Demo" },
      { id: "wt-deal-estimate", list: "deal", name: "Estimate" },
      { id: "wt-deal-offer", list: "deal", name: "Offer" },
      { id: "wt-project-analysis", list: "project", name: "Analysis" },
      { id: "wt-project-development", list: "project", name: "Development" },
      { id: "wt-project-management", list: "project", name: "Project management" },
      { id: "wt-project-support", list: "project", name: "Support" },
    ]);
  });

  it("holds twelve rows in all, every one active and created by the migration", async () => {
    const { categories, workTypes } = await freshInstallation();
    const rows = [...categories, ...workTypes];
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.createdBy === "system:migration")).toBe(true);
    expect(rows.every((row) => row.retiredAt === null)).toBe(true);
  });

  it("holds no entry", async () => {
    let entries = -1;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("CREATE SCHEMA seed_check");
        await tx.$executeRawUnsafe("SET LOCAL search_path TO seed_check");
        for (const sql of migrations) await tx.$executeRawUnsafe(sql);
        const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM time_entry`);
        entries = row?.n ?? -1;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(entries).toBe(0);
  });

  it("has taken the names it seeded: `training` next to `Training` and a second project `development` are refused, the deal list's is free", async () => {
    const outcomes: Record<string, string> = {};
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("CREATE SCHEMA seed_check");
        await tx.$executeRawUnsafe("SET LOCAL search_path TO seed_check");
        for (const sql of migrations) await tx.$executeRawUnsafe(sql);
        // A refused INSERT aborts the whole transaction, so each attempt is its own savepoint.
        const attempt = async (label: string, insert: string) => {
          await tx.$executeRawUnsafe("SAVEPOINT attempt");
          try {
            await tx.$executeRawUnsafe(insert);
            outcomes[label] = "accepted";
          } catch (error) {
            outcomes[label] = error instanceof Error && error.message.includes("_name_lower_key") ? "refused by the name index" : `refused: ${String(error)}`;
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT attempt");
          }
        };
        await attempt(
          "category training",
          `INSERT INTO time_category ("id", "name", "createdBy", "updatedAt") VALUES ('c1', 'training', 'u', CURRENT_TIMESTAMP)`,
        );
        await attempt(
          "project development",
          `INSERT INTO work_type ("id", "list", "name", "createdBy", "updatedAt") VALUES ('w1', 'project', 'development', 'u', CURRENT_TIMESTAMP)`,
        );
        await attempt(
          "deal development",
          `INSERT INTO work_type ("id", "list", "name", "createdBy", "updatedAt") VALUES ('w2', 'deal', 'development', 'u', CURRENT_TIMESTAMP)`,
        );
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(outcomes).toEqual({
      "category training": "refused by the name index",
      "project development": "refused by the name index",
      "deal development": "accepted",
    });
  });

  it("leaves nothing behind in the database it ran against", async () => {
    await freshInstallation();
    const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'seed_check'`;
    expect(row?.n).toBe(0);
  });
});

// ─── The meeting-hours migration (specs/20261112-meeting-hours T3, plan § Data model "hours-api") ─────────

interface InstallationOptions {
  /** Session time zone the migrations run under (`SET LOCAL TIME ZONE`): what a server in another zone would apply them with. */
  readonly timeZone?: string;
  /** Runs right after the FIRST migration (the initial schema): rows an installation that predates the later ones already holds. */
  readonly afterFirst?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/** Applies every migration to a throwaway schema, runs `read` against it, and rolls everything back. */
async function inInstallation<T>(read: (tx: Prisma.TransactionClient) => Promise<T>, options: InstallationOptions = {}): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("CREATE SCHEMA seed_check");
      await tx.$executeRawUnsafe("SET LOCAL search_path TO seed_check");
      if (options.timeZone) await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${options.timeZone}'`);
      for (const [index, sql] of migrations.entries()) {
        await tx.$executeRawUnsafe(sql);
        if (index === 0) await options.afterFirst?.(tx);
      }
      result = { value: await read(tx) };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!result) throw new Error("the installation was not read");
  return result.value;
}

describe("entries that exist before the meeting-hours migration (backward compatibility, plan § Data model)", () => {
  it("become the person's own entries, remember no meeting and follow none", async () => {
    const rows = await inInstallation(
      (tx) =>
        tx.$queryRawUnsafe<{ id: string; origin: string; sourceMeetingId: string | null; followsMeeting: boolean }[]>(
          `SELECT "id", "origin"::text AS "origin", "sourceMeetingId", "followsMeeting" FROM time_entry ORDER BY "id"`,
        ),
      {
        afterFirst: async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO time_entry ("id", "userId", "day", "minutes", "target", "meetingId", "updatedAt")
             VALUES ('old-meeting', 'user-1', '2026-11-02', 60, 'meeting', 'meeting-1', CURRENT_TIMESTAMP)`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO time_entry ("id", "userId", "day", "minutes", "target", "projectId", "updatedAt")
             VALUES ('old-project', 'user-1', '2026-11-02', 90, 'project', 'project-1', CURRENT_TIMESTAMP)`,
          );
        },
      },
    );
    expect(rows).toEqual([
      { id: "old-meeting", origin: "person", sourceMeetingId: null, followsMeeting: false },
      { id: "old-project", origin: "person", sourceMeetingId: null, followsMeeting: false },
    ]);
  });
});

describe("the release day (AC-1.5)", () => {
  // The migration writes the Europe/Zurich date it ran, not the date of the server's zone: a Zurich
  // morning is still yesterday in the Americas and a Zurich evening already tomorrow in the Pacific.
  const ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago"] as const;

  it("is the one row of the table, dated the Europe/Zurich day the migration ran, whatever the session's time zone", async () => {
    const outcomes = [];
    for (const timeZone of ZONES) {
      outcomes.push(
        await inInstallation(
          async (tx) => {
            const [read] = await tx.$queryRawUnsafe<{ rows: number; id: number | null; since: string | null; zurich: string; naive: string }[]>(
              `SELECT (SELECT count(*)::int FROM meeting_hours_release) AS rows,
                      (SELECT min("id")::int FROM meeting_hours_release) AS id,
                      (SELECT min("since")::text FROM meeting_hours_release) AS since,
                      ((now() AT TIME ZONE 'Europe/Zurich')::date)::text AS zurich,
                      (now()::date)::text AS naive`,
            );
            return read;
          },
          { timeZone },
        ),
      );
    }
    for (const outcome of outcomes) expect(outcome).toMatchObject({ rows: 1, id: 1, since: outcome?.zurich });
    // The test can fail: in at least one of the two zones the server's own date is not Zurich's.
    expect(outcomes.some((outcome) => outcome?.naive !== outcome?.zurich)).toBe(true);
  });
});

describe("what the meeting-hours migration creates (plan § Data model)", () => {
  it("adds exactly the three time_entry columns and the three tables, with their defaults and nullability", async () => {
    const columns = await inInstallation((tx) =>
      tx.$queryRawUnsafe<{ line: string }[]>(
        `SELECT table_name || '.' || column_name || ' ' || CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END
                || ' ' || CASE WHEN is_nullable = 'YES' THEN 'null' ELSE 'not null' END
                || coalesce(' default ' || column_default, '') AS line
           FROM information_schema.columns
          WHERE table_schema = 'seed_check'
            AND ((table_name = 'time_entry' AND column_name IN ('origin', 'sourceMeetingId', 'followsMeeting'))
                 OR table_name LIKE 'meeting_hours_%')
          ORDER BY table_name, column_name COLLATE "C"`,
      ),
    );
    expect(columns.map((row) => row.line)).toEqual([
      `meeting_hours_block.createdAt timestamp without time zone not null default CURRENT_TIMESTAMP`,
      `meeting_hours_block.meetingId text not null`,
      `meeting_hours_block.reason MeetingHoursBlockReason not null`,
      `meeting_hours_block.userId text not null`,
      `meeting_hours_meeting.appliedAt timestamp without time zone null`,
      `meeting_hours_meeting.meetingId text not null`,
      `meeting_hours_meeting.seq integer not null`,
      `meeting_hours_release.id smallint not null`,
      `meeting_hours_release.since date not null`,
      `time_entry.followsMeeting boolean not null default false`,
      `time_entry.origin TimeEntryOrigin not null default 'person'::"TimeEntryOrigin"`,
      `time_entry.sourceMeetingId text null`,
    ]);
  });

  it("names the two enums with the plan's values, and makes the automatic-entry index partial", async () => {
    const read = await inInstallation(async (tx) => ({
      enums: await tx.$queryRawUnsafe<{ line: string }[]>(
        `SELECT t.typname || ': ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS line
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'seed_check' AND t.typname IN ('TimeEntryOrigin', 'MeetingHoursBlockReason') GROUP BY t.typname ORDER BY t.typname`,
      ),
      index: await tx.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'seed_check' AND indexname = 'time_entry_one_automatic_per_meeting'`,
      ),
    }));
    expect(read.enums.map((row) => row.line)).toEqual(["MeetingHoursBlockReason: had_entry,deleted", "TimeEntryOrigin: person,meeting"]);
    expect(read.index).toHaveLength(1);
    expect(read.index[0]?.indexdef).toContain(`UNIQUE INDEX`);
    expect(read.index[0]?.indexdef).toContain(`("userId", "sourceMeetingId")`);
    expect(read.index[0]?.indexdef).toContain(`WHERE ("sourceMeetingId" IS NOT NULL)`);
  });
});
