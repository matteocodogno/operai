/**
 * The migration `*_attached_team` (specs/20261126-teams T11): a purely additive table of the team ids attached to a
 * project. It applies on the schema as shipped at `20261124160000` (init, purchase_order, project_tender_deal), keeps
 * NO name and no member (AC-1.3: both are auth's, read live), cascades with its project and refuses an id outside
 * 1..64 characters.
 *
 * Built in a scratch schema INSIDE a transaction that is rolled back (the pattern of migration.purchaseOrder.test.ts):
 * nothing outlives the test and the shared schema is never touched. Runs against the `*_test` database.
 */
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "..", "prisma", "migrations");
const DIRS = readdirSync(MIGRATIONS).filter((name) => name !== "migration_lock.toml").sort();
const sqlOf = (dir: string): string => readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf-8");

type Tx = { unsafe(query: string): Promise<Record<string, unknown>[]> };
class Rollback extends Error {}

const databaseUrl = (): string => {
  const url = new URL(process.env["DATABASE_URL"]!);
  url.search = "";
  return url.toString();
};

/** The schema at 20261124160000 in a scratch schema, the new migration not yet applied; rolled back afterwards. */
async function atPreviousMigration(scenario: (tx: Tx) => Promise<void>): Promise<void> {
  const sql = new SQL(databaseUrl());
  try {
    await sql.begin(async (tx: Tx) => {
      await tx.unsafe("CREATE SCHEMA migration_scratch_teams; SET LOCAL search_path TO migration_scratch_teams");
      for (const dir of DIRS.filter((name) => name <= "20261124160000_project_tender_deal")) await tx.unsafe(sqlOf(dir));
      await scenario(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await sql.close();
  }
}

const NEW_MIGRATION = DIRS.find((name) => name.endsWith("_attached_team"))!;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const seedProject = (id: string) =>
  `INSERT INTO "project" ("id", "name", "type", "entity", "companyId", "projectManagerId", "createdById", "updatedAt")
   VALUES ('${id}', 'P ${id}', 't_and_m', 'welld_ch', 'co-1', 'user-1', 'user-1', now())`;

describe("migration attached_team", () => {
  it("is the one after `20261124160000_project_tender_deal`, and the last", () => {
    expect(NEW_MIGRATION).toBe("20261126120000_attached_team");
    expect(DIRS.indexOf(NEW_MIGRATION)).toBe(DIRS.indexOf("20261124160000_project_tender_deal") + 1);
  });

  it("applies on the schema as of 20261124160000", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(seedProject("p1"));
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      const rows = await tx.unsafe(`SELECT count(*)::int AS n FROM "project_attached_team"`);
      expect(rows[0]!["n"]).toBe(0);
      // the project that was there is untouched
      expect((await tx.unsafe(`SELECT count(*)::int AS n FROM "project"`))[0]!["n"]).toBe(1);
    });
  });

  it("holds the project, the team id and when it was attached: no name column, no member column (AC-1.3)", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      const columns = await tx.unsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'migration_scratch_teams' AND table_name = 'project_attached_team'
          ORDER BY ordinal_position`,
      );
      expect(columns.map((row) => row["column_name"])).toEqual(["projectId", "teamId", "attachedAt"]);
    });
  });

  it("attaches a team to a project once, many teams to one project, one team to many projects", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      await tx.unsafe(seedProject("p1"));
      await tx.unsafe(seedProject("p2"));
      await tx.unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('p1', 't1'), ('p1', 't2'), ('p2', 't1')`);
      const duplicate = await tx
        .unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('p1', 't1')`)
        .then(
          () => null,
          (error: unknown) => message(error),
        );
      expect(duplicate).toContain("project_attached_team_pkey");
    });
  });

  it("refuses a team on a project that does not exist, and goes with its project", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      const orphan = await tx.unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('nope', 't1')`).then(
        () => null,
        (error: unknown) => message(error),
      );
      expect(orphan).toContain("project_attached_team_projectId_fkey");
    });
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      await tx.unsafe(seedProject("p1"));
      await tx.unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('p1', 't1')`);
      await tx.unsafe(`DELETE FROM "project" WHERE "id" = 'p1'`);
      expect((await tx.unsafe(`SELECT count(*)::int AS n FROM "project_attached_team"`))[0]!["n"]).toBe(0);
    });
  });

  it("refuses a team id outside 1..64 characters, and accepts the bounds (attached_team_id_shape)", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      await tx.unsafe(seedProject("p1"));
      const insert = (teamId: string) =>
        tx.unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('p1', '${teamId}')`).then(
          () => null,
          (error: unknown) => message(error),
        );
      expect(await insert("x")).toBeNull();
      expect(await insert("y".repeat(64))).toBeNull();
    });
    for (const bad of ["", "z".repeat(65)]) {
      await atPreviousMigration(async (tx) => {
        await tx.unsafe(sqlOf(NEW_MIGRATION));
        await tx.unsafe(seedProject("p1"));
        const error = await tx.unsafe(`INSERT INTO "project_attached_team" ("projectId", "teamId") VALUES ('p1', '${bad}')`).then(
          () => null,
          (e: unknown) => message(e),
        );
        expect(error).toContain("attached_team_id_shape");
      });
    }
  });

  it("indexes the team id (the list filter and GET /attached-teams)", async () => {
    await atPreviousMigration(async (tx) => {
      await tx.unsafe(sqlOf(NEW_MIGRATION));
      const indexes = await tx.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'migration_scratch_teams' AND tablename = 'project_attached_team'`,
      );
      expect(indexes.map((row) => row["indexname"])).toContain("project_attached_team_teamId_idx");
    });
  });
});
