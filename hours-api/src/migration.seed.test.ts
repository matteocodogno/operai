/**
 * The initial lists (specs/029 T10; AC-3.7, A15, AC-3.2): a NEW installation starts with exactly the
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
