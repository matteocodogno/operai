/**
 * The migration `*_purchase_order` (specs/022 T23) turns specs/021's schema (`contract`) into the
 * terms + purchase order model. It starts with a guard: data the new model cannot represent
 * unambiguously (a `contract` row, a `saas` project, which had no company) is handled by hand, so the
 * migration REFUSES to run over it; an empty or contract-free database migrates (no data conversion).
 *
 * Each case builds the 021 schema (`*_init`) in a scratch schema INSIDE a transaction, puts data in,
 * runs the migration, looks, and rolls everything back: nothing outlives the test and the shared
 * schema is never touched. Runs against the `*_test` database (src/test-support/env.ts).
 */
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "..", "prisma", "migrations");
const migrationSql = (suffix: string): string => {
  const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith(`_${suffix}`));
  if (!dir) throw new Error(`no migration ending in _${suffix}`);
  return readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf-8");
};

/** `prisma/migrations` holds specs/021's `init` (as shipped) and this one, in that order, and nothing else. */
const MIGRATION_DIRS = readdirSync(MIGRATIONS).filter((name) => name !== "migration_lock.toml").sort();

type Tx = { unsafe(query: string): Promise<Record<string, unknown>[]> };

class Rollback extends Error {}

/** The test database, without the query string some shells add (a schema, a search path). */
const databaseUrl = (): string => {
  const url = new URL(process.env["DATABASE_URL"]!);
  url.search = "";
  return url.toString();
};

/** Runs `scenario` in a scratch schema holding specs/021's tables, then rolls everything back. */
async function inScratchSchema(scenario: (tx: Tx) => Promise<void>): Promise<void> {
  const sql = new SQL(databaseUrl());
  try {
    await sql.begin(async (tx: Tx) => {
      await tx.unsafe("CREATE SCHEMA migration_scratch; SET LOCAL search_path TO migration_scratch");
      await tx.unsafe(migrationSql("init"));
      await scenario(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await sql.close();
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The error the migration ends with over the given state, or `null` when it ran. */
const migrationError = (tx: Tx): Promise<string | null> =>
  tx.unsafe(migrationSql("purchase_order")).then(
    () => null,
    (error: unknown) => message(error),
  );

const seedProject = (id: string, type: string, companyId: string | null) =>
  `INSERT INTO "project" ("id", "name", "type", "entity", "companyId", "projectManagerId", "createdById", "updatedAt")
   VALUES ('${id}', 'P ${id}', '${type}', 'welld_ch', ${companyId === null ? "NULL" : `'${companyId}'`}, 'user-1', 'user-1', now())`;

describe("the migrations directory", () => {
  it("holds specs/021's init as shipped, then purchase_order, and nothing else (one new migration)", () => {
    expect(MIGRATION_DIRS).toHaveLength(2);
    expect(MIGRATION_DIRS[0]).toBe("20261103163000_init");
    expect(MIGRATION_DIRS[1]).toMatch(/^\d{14}_purchase_order$/);
  });
});

describe("migration purchase_order — the guard", () => {
  it("refuses to run when a `contract` row exists, saying why and how many, and changes nothing", async () => {
    await inScratchSchema(async (tx) => {
      await tx.unsafe(seedProject("p1", "t_and_m", "co-1"));
      await tx.unsafe(
        `INSERT INTO "contract" ("id", "projectId", "type", "companyId", "startDate", "updatedAt")
         VALUES ('c1', 'p1', 't_and_m', 'co-1', '2026-01-01', now()), ('c2', 'p1', 't_and_m', 'co-1', '2026-02-01', now())`,
      );
      const error = await migrationError(tx);
      expect(error).not.toBeNull();
      expect(error).toContain("contract");
      expect(error).toContain("2");
    });
  });

  it("refuses to run when a `saas` project exists (it has no company, the new model needs one), even with no contract", async () => {
    await inScratchSchema(async (tx) => {
      await tx.unsafe(seedProject("p1", "saas", null));
      const error = await migrationError(tx);
      expect(error).not.toBeNull();
      expect(error).toContain("saas");
    });
  });

  it("is the first statement of the migration: nothing but comments precedes it, so a refusal has changed nothing", () => {
    const sql = migrationSql("purchase_order");
    const guardAt = sql.indexOf("DO $$");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(sql.slice(0, guardAt).replace(/--.*$/gm, "").trim()).toBe("");
  });
});

describe("migration purchase_order — over a database it can represent", () => {
  it("migrates a database with projects and no contract: contract → terms, a purchase order table, a project manager that may be null", async () => {
    await inScratchSchema(async (tx) => {
      await tx.unsafe(seedProject("p1", "fixed_price", "co-1"));
      await tx.unsafe(seedProject("p2", "internal", null));
      await tx.unsafe(`INSERT INTO "project_member" ("projectId", "userId") VALUES ('p1', 'user-2')`);
      expect(await migrationError(tx)).toBeNull();

      const tables = (await tx.unsafe(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      )) as { table_name: string }[];
      expect(tables.map((row) => row.table_name)).toEqual([
        "project",
        "project_member",
        "project_terms",
        "project_terms_position",
        "purchase_order",
      ]);
      // The projects and their members are kept.
      expect(await tx.unsafe(`SELECT count(*)::int AS n FROM "project"`)).toEqual([{ n: 2 }]);
      expect(await tx.unsafe(`SELECT count(*)::int AS n FROM "project_member"`)).toEqual([{ n: 1 }]);
      // The origin enum goes with the contract.
      expect(await tx.unsafe(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ContractOrigin' AND typnamespace = current_schema()::regnamespace`)).toEqual([
        { n: 0 },
      ]);
      // A project may now have no project manager.
      await tx.unsafe(`UPDATE "project" SET "projectManagerId" = NULL WHERE "id" = 'p1'`);
    });
  });

  it("keeps the 021 terms CHECKs under their new names and adds terms_not_internal", async () => {
    await inScratchSchema(async (tx) => {
      expect(await migrationError(tx)).toBeNull();
      const names = (await tx.unsafe(
        `SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = current_schema()::regnamespace ORDER BY 1`,
      )) as { conname: string }[];
      expect(names.map((row) => row.conname)).toEqual([
        "project_company_matches_type",
        "project_name_not_blank",
        "project_state_before_hold_from_open_state",
        "project_state_before_hold_iff_on_hold",
        "terms_dates_ordered",
        "terms_estimated_man_days_non_negative",
        "terms_fixed_price_terms",
        "terms_hour_package_expiry_capacity_only",
        "terms_hour_package_group",
        "terms_hour_package_hours_positive",
        "terms_maintenance_needs_sla_or_hours",
        "terms_not_internal",
        "terms_position_man_days_positive",
        "terms_position_profile_not_blank",
        "terms_sla_pair",
        "terms_sla_range",
      ]);
    });
  });

  it("makes `saas` a client type: a company is now required for it, and refused for `internal`", async () => {
    await inScratchSchema(async (tx) => {
      expect(await migrationError(tx)).toBeNull();
      // Each attempt in its own savepoint: a refused insert aborts the transaction otherwise.
      const attempt = async (sql: string): Promise<string | null> => {
        await tx.unsafe("SAVEPOINT attempt");
        const error = await tx.unsafe(sql).then(
          () => null,
          (e: unknown) => message(e),
        );
        await tx.unsafe(error === null ? "RELEASE SAVEPOINT attempt" : "ROLLBACK TO SAVEPOINT attempt");
        return error;
      };
      expect(await attempt(seedProject("s1", "saas", "co-1"))).toBeNull();
      expect(await attempt(seedProject("s2", "saas", null))).toContain("project_company_matches_type");
      expect(await attempt(seedProject("i1", "internal", "co-1"))).toContain("project_company_matches_type");
      expect(await attempt(seedProject("i2", "internal", null))).toBeNull();
    });
  });
});
