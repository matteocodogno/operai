/**
 * T9 of specs/20261117-legal-entities: the copy of the CRM's legal details (AC-7.1 to AC-7.5; plan E11), against REAL
 * Postgres on both sides, on the MIG fixture set (specs/20261117-legal-entities/fixtures/crm-entity-profiles.json).
 *
 * Two databases, both required:
 *   - the registry's (`DATABASE_URL`, as every auth test): `legal_entity_version` is append-only, so every write
 *     happens inside `inRolledBackTx` and nothing is ever committed (testDb.ts); the immutability is never worked
 *     around except inside that rolled-back transaction, to make the registry empty whatever a developer ran before;
 *   - the CRM's, a scratch database that holds `entity_profile` (crm-api's migrations applied): `CRM_TEST_DATABASE_URL`.
 *     A different variable from the script's own `CRM_DATABASE_URL` on purpose: this suite empties and re-seeds
 *     `entity_profile`, and must never be pointed at a CRM database by an exported production-like variable.
 *     Without it the suite is skipped, loudly.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import {
  type CrmSource,
  ImportError,
  type ImportReport,
  type Tx,
  differingFields,
  mapProfile,
  main,
  openCrmSource,
  runImport,
  type OpenedCrmSource,
} from "./import";
import type { Problem, RequiredField } from "./rules";
import { ibanTail } from "./ibanTail";
import { committedVersionCount, inRolledBackTx } from "./testDb";

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

interface FixtureProfile {
  legalName: string;
  addressLines: string[];
  vatNumber: string | null;
  iban: string | null;
}
interface FixtureCase {
  name: string;
  entity: LegalEntity;
  crm: FixtureProfile | null;
  expect: {
    legalName: string;
    address: string[];
    vatNumber: string;
    iban: string;
    missing: RequiredField[];
    invalid: Problem[];
    ibanPrintChanged: boolean;
  };
}

const FIXTURE_PATH = join(import.meta.dir, "../../../specs/20261117-legal-entities/fixtures/crm-entity-profiles.json");
const CASES = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { cases: FixtureCase[] }).cases;
const byName = (name: string): FixtureCase => {
  const found = CASES.find((c) => c.name === name);
  if (!found) throw new Error(`fixture case ${name} not found`);
  return found;
};

const CRM_URL = process.env["CRM_TEST_DATABASE_URL"];
const AUTH_URL = process.env["DATABASE_URL"] ?? "";

/** The scratch CRM database must not be one a developer or an environment really uses. */
function assertScratch(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (/^(crm|auth|operai_auth|postgres|template\d)$/.test(name) || url === AUTH_URL) {
    throw new Error(`CRM_TEST_DATABASE_URL must name a scratch database, not "${name}"`);
  }
}

if (!CRM_URL) {
  console.warn(
    "import.test.ts SKIPPED: set CRM_TEST_DATABASE_URL to a scratch database with crm-api's migrations applied " +
      "(e.g. postgresql://postgres:postgres@localhost:5435/crm_scratch) to run the legal-entities copy tests.",
  );
}
const suite = CRM_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------------------------------------------
// Helpers

let crmAdmin: SQL; // writable session on the scratch CRM database: seeds the fixtures
let crm: OpenedCrmSource; // the script's own read-only source

async function seedCrm(rows: { entity: LegalEntity; profile: FixtureProfile }[]): Promise<void> {
  await crmAdmin`DELETE FROM "entity_profile"`;
  for (const { entity, profile } of rows) {
    const lines = JSON.stringify(profile.addressLines);
    await crmAdmin`
      INSERT INTO "entity_profile" ("entity", "legalName", "addressLines", "vatNumber", "iban", "updatedBy", "updatedAt")
      VALUES (${entity}::"Entity", ${profile.legalName},
              ARRAY(SELECT t.v FROM jsonb_array_elements_text((${lines}::text)::jsonb) WITH ORDINALITY AS t(v, n) ORDER BY t.n),
              ${profile.vatNumber}, ${profile.iban}, 'fixture', '2026-11-10 09:08:07.123')`;
  }
}

/** Seed the cases' rows (each case names its entity; at most one per entity). */
const seedCases = (...cases: FixtureCase[]) =>
  seedCrm(cases.flatMap((c) => (c.crm ? [{ entity: c.entity, profile: c.crm }] : [])));

/** A registry with no version, whatever was committed before: the rows are removed inside the rolled-back tx only. */
async function emptyRegistry(tx: Tx): Promise<void> {
  if ((await tx.legalEntityVersion.count()) === 0) return;
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
  await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  inRolledBackTx(async (tx) => {
    await emptyRegistry(tx);
    return fn(tx);
  });

/** A later registry save (what T8 will write): version `version` = `base` with `changes`, by a person. */
async function saveVersion(
  tx: Tx,
  base: { entity: string; legalName: string; addressIt: string[]; addressEn: string[]; vatNumber: string; iban: string; contactsIt: string; contactsEn: string },
  version: number,
  changes: Partial<{ legalName: string; addressIt: string[]; addressEn: string[] }>,
  changed: string[],
): Promise<void> {
  const { entity, legalName, addressIt, addressEn, vatNumber, iban, contactsIt, contactsEn } = base;
  await tx.legalEntityVersion.create({
    data: {
      entity, legalName, addressIt, addressEn, vatNumber, iban, contactsIt, contactsEn,
      ...changes,
      version,
      action: "save",
      changedFields: changed,
      createdByUserId: "u1",
      createdByName: "A Person",
    },
  });
}

const run = (tx: Tx, apply: boolean, source: CrmSource = crm): Promise<ImportReport> =>
  runImport({ apply, crm: source, transact: (fn) => fn(tx) });

const entityReport = (report: ImportReport, entity: LegalEntity) => {
  const found = report.entities.find((e) => e.entity === entity);
  if (!found) throw new Error(`no report for ${entity}`);
  return found;
};

async function importAudit(tx: Tx, entity: LegalEntity) {
  return tx.auditLog.findMany({ where: { action: "legal_entity.import", targetType: "legal_entity", targetId: entity } });
}

/** Runs `main` in-process on the rolled-back transaction, capturing both streams. */
async function runMain(tx: Tx, args: string[], source: CrmSource = crm) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({
    argv: args,
    env: { CRM_DATABASE_URL: "crm-url-for-test", DATABASE_URL: "auth-url-for-test" },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    transact: (fn) => fn(tx),
    openCrm: () => ({ ...source, close: async () => undefined }),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

// ---------------------------------------------------------------------------------------------------------------

suite("T9 — the copy of the CRM's legal details", () => {
  beforeAll(async () => {
    assertScratch(CRM_URL as string);
    crmAdmin = new SQL(CRM_URL as string, { max: 1 });
    crm = openCrmSource(CRM_URL as string);
    // A previous crashed run may have left the legal columns dropped.
    await restoreColumns();
  });
  afterAll(async () => {
    await crm.close();
    await crmAdmin.close();
  });
  beforeEach(async () => {
    await seedCases(byName("complete-it"), byName("complete-ch"));
  });
  afterEach(async () => {
    await restoreColumns();
  });

  test("the fixture set covers every case of the plan's MIG list and is self-consistent", () => {
    const names = CASES.map((c) => c.name);
    for (const n of [
      "complete-it",
      "complete-ch",
      "missing-vat",
      "no-row",
      "five-address-lines",
      "iban-spaces-lower-case",
      "iban-bad-check-digits",
      "line-break",
    ]) {
      expect(names).toContain(n);
    }
    for (const c of CASES) {
      // ibanPrintChanged, derived here independently of the code under test: the typed text after the CRM's
      // print rule against the electronic IBAN in groups of four.
      const typed = (c.crm?.iban ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
      const grouped = c.expect.iban.replace(/(.{4})(?=.)/g, "$1 ");
      expect(c.expect.ibanPrintChanged).toBe(typed !== grouped);
    }
  });

  describe("AC-7.1 / AC-7.2 — dry run, then apply", () => {
    test("a dry run writes nothing: no version, no audit row, categories would_insert", async () => {
      const committed = await committedVersionCount();
      await inTx(async (tx) => {
        const audits = await tx.auditLog.count({ where: { action: "legal_entity.import" } });
        const report = await run(tx, false);
        expect(report.applied).toBe(false);
        expect(report.found).toBe(2);
        expect(report.wouldInsert).toBe(2);
        expect(report.inserted).toBe(0);
        expect(report.mismatched).toBe(0);
        expect(await tx.legalEntityVersion.count()).toBe(0);
        expect(await tx.auditLog.count({ where: { action: "legal_entity.import" } })).toBe(audits);
        // a dry run takes no lock either
        const locks = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
        expect(Number(locks[0]?.n)).toBe(0);
      });
      expect(await committedVersionCount()).toBe(committed); // nothing committed
    });

    test("apply: version 1 per entity with the mapping, attributed to the system, one audit row each, actor null", async () => {
      await inTx(async (tx) => {
        const report = await run(tx, true);
        expect(report.inserted).toBe(2);
        expect(report.present).toBe(0);
        const before = new Map<string, number>();
        for (const c of [byName("complete-it"), byName("complete-ch")]) {
          const rows = await tx.legalEntityVersion.findMany({ where: { entity: c.entity } });
          expect(rows).toHaveLength(1);
          const v = rows[0]!;
          expect(v.version).toBe(1);
          expect(v.legalName).toBe(c.expect.legalName);
          expect(v.vatNumber).toBe(c.expect.vatNumber);
          expect(v.iban).toBe(c.expect.iban);
          expect(v.addressIt).toEqual(c.expect.address);
          expect(v.addressEn).toEqual(c.expect.address); // the CRM's one address, in both languages (AC-7.1)
          expect(v.contactsIt).toBe("");
          expect(v.contactsEn).toBe("");
          expect(v.action).toBe("import");
          expect(v.restoredFrom).toBeNull();
          expect(v.createdByUserId).toBeNull();
          expect(v.createdByName).toBeNull();
          expect(v.changedFields).toEqual(["legalName", "address.it", "address.en", "vatNumber", "iban"]);

          const audits = await importAudit(tx, c.entity);
          before.set(c.entity, audits.length);
          // exactly one for this run (committed rows of a dev database may add others: look at the newest)
          const audit = audits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
          expect(audit.actorUserId).toBeNull();
          expect(audit.action).toBe("legal_entity.import");
          expect(audit.targetType).toBe("legal_entity");
          expect(audit.targetId).toBe(c.entity);
          const data = audit.data as {
            version: number;
            source: { table: string; row: boolean; updatedAt: string | null; updatedBy: string | null };
            changes: Record<string, { before?: unknown; after: unknown }>;
            missing: string[];
            ibanPrintChanged: boolean;
          };
          expect(data.version).toBe(1);
          // T54 (F5 item 2): who last edited the CRM row (an id) is the only new member
          expect(data.source).toEqual({
            table: "crm.entity_profile",
            row: true,
            updatedAt: "2026-11-10T09:08:07.123Z",
            updatedBy: "fixture",
          });
          expect(data.changes["legalName"]).toEqual({ after: c.expect.legalName });
          expect(data.changes["address.it"]).toEqual({ after: c.expect.address });
          expect(data.changes["iban"]).toEqual({ after: c.expect.iban });
          expect("before" in (data.changes["legalName"] ?? {})).toBe(false);
          expect(data.missing).toEqual([]);
          expect(data.ibanPrintChanged).toBe(false);
        }
        // the apply holds each entity's advisory lock until the end of its transaction: two here (one tx)
        const locks = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
        expect(Number(locks[0]?.n)).toBe(2);
      });
    });

    test("the apply takes the SAME lock as a registry save (hashtext('legal_entity:<entity>'))", async () => {
      await inTx(async (tx) => {
        await run(tx, true);
        // Another connection cannot take it while the apply's transaction is open.
        const other = await db.$queryRaw<{ got: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${"legal_entity:welld_it"})) AS got`;
        expect(other[0]?.got).toBe(false);
      });
    });
  });

  describe("T54 — who last edited the CRM row, and each IBAN's tail (F5 items 2 and 3)", () => {
    const tailLine = (stdout: string, entity: LegalEntity): string => {
      const block = stdout.split("\n\n").find((b) => b.startsWith(`${entity}:`));
      if (!block) throw new Error(`no block for ${entity}`);
      const ibanLines = block.split("\n").filter((l) => l.trim().startsWith("IBAN "));
      expect(ibanLines).toHaveLength(1);
      return ibanLines[0]!.trim();
    };

    test("the audit row's source carries the CRM row's updatedBy as stored, null without a row, and no other new member", async () => {
      await seedCases(byName("complete-it"));
      await crmAdmin`UPDATE "entity_profile" SET "updatedBy" = 'person-42' WHERE "entity" = 'welld_it'::"Entity"`;
      await inTx(async (tx) => {
        expect((await run(tx, true)).inserted).toBe(2);
        const withRow = (await importAudit(tx, "welld_it"))[0]!.data as { source: Record<string, unknown> };
        expect(withRow.source).toEqual({
          table: "crm.entity_profile",
          row: true,
          updatedAt: "2026-11-10T09:08:07.123Z",
          updatedBy: "person-42",
        });
        const noRow = (await importAudit(tx, "welld_ch"))[0]!.data as { source: Record<string, unknown> };
        expect(noRow.source).toEqual({ table: "crm.entity_profile", row: false, updatedAt: null, updatedBy: null });
        // the audit row holds no fragment of the IBAN beyond the moved value itself (changes.iban, T9): no tail member
        const keys = Object.keys((await importAudit(tx, "welld_it"))[0]!.data as object).sort();
        expect(keys).toEqual(["changes", "ibanPrintChanged", "invalid", "missing", "source", "version"]);
      });
    });

    test("the dry run and the apply print per entity IBAN …1234 / IBAN set / IBAN none, and the JSON form carries the same", async () => {
      await seedCases(byName("complete-it"), byName("complete-ch"));
      await inTx(async (tx) => {
        for (const args of [[], ["--apply"], []]) {
          const r = await runMain(tx, args);
          expect(r.code).toBe(0);
          expect(tailLine(r.stdout, "welld_it")).toBe("IBAN \u20263456");
          expect(tailLine(r.stdout, "welld_ch")).toBe("IBAN \u20262957");
        }
        const json = JSON.parse((await runMain(tx, ["--json"])).stdout) as ImportReport;
        expect(entityReport(json, "welld_it").iban).toEqual({ state: "tail", last4: "3456" });
        expect(entityReport(json, "welld_ch").iban).toEqual({ state: "tail", last4: "2957" });
      });
    });

    test("no CRM row, a null IBAN and an IBAN of 8 characters or fewer: none / none / set, with no character shown", async () => {
      const base = byName("complete-it").crm!;
      await seedCrm([
        { entity: "welld_it", profile: { ...base, iban: "AB12 CD34" } }, // 8 characters
      ]);
      await inTx(async (tx) => {
        const r = await runMain(tx, []);
        expect(tailLine(r.stdout, "welld_it")).toBe("IBAN set");
        expect(tailLine(r.stdout, "welld_ch")).toBe("IBAN none"); // no row
        expect(r.stdout).not.toContain("CD34");
      });
      await seedCrm([{ entity: "welld_it", profile: { ...base, iban: null } }]);
      await inTx(async (tx) => {
        expect(tailLine((await runMain(tx, [])).stdout, "welld_it")).toBe("IBAN none");
      });
      await seedCrm([{ entity: "welld_it", profile: { ...base, iban: "AB12 CD34 5" } }]); // 9 characters
      await inTx(async (tx) => {
        expect(tailLine((await runMain(tx, [])).stdout, "welld_it")).toBe("IBAN \u2026D345");
      });
    });

    test("every fixture case: the line is exactly what the shared rule says of the moved IBAN, and only its tail is shown", async () => {
      for (const c of CASES) {
        await seedCases(c);
        await inTx(async (tx) => {
          const stdout = (await runMain(tx, [])).stdout;
          const tail = ibanTail(c.expect.iban);
          const want = tail.state === "tail" ? `IBAN \u2026${tail.last4}` : `IBAN ${tail.state}`;
          expect(tailLine(stdout, c.entity)).toBe(want);
          // a tail of the print form must not be accompanied by more of the value
          if (c.expect.iban.length > 8) expect(stdout).not.toContain(c.expect.iban.slice(-8));
        });
      }
    });

    test("a CRM IBAN with a character outside A-Z / 0-9 in its tail is shown as set, never printed", async () => {
      const base = byName("complete-it").crm!;
      await seedCrm([{ entity: "welld_it", profile: { ...base, iban: "CH9300762011623852\u202e95" } }]);
      await inTx(async (tx) => {
        const r = await runMain(tx, []);
        expect(tailLine(r.stdout, "welld_it")).toBe("IBAN set");
        expect(r.stdout).not.toContain("\u202e");
      });
    });
  });

  describe("AC-7.4 — a second run changes nothing", () => {
    test("second apply: inserted 0, present 2, exit 0, no new version, no new audit row", async () => {
      await inTx(async (tx) => {
        const first = await runMain(tx, ["--apply"]);
        expect(first.code).toBe(0);
        const versions = await tx.legalEntityVersion.count();
        const audits = await tx.auditLog.count({ where: { action: "legal_entity.import" } });

        const second = await runMain(tx, ["--apply", "--json"]);
        expect(second.code).toBe(0);
        const report = JSON.parse(second.stdout) as ImportReport;
        expect(report.inserted).toBe(0);
        expect(report.present).toBe(2);
        expect(report.mismatched).toBe(0);
        expect(await tx.legalEntityVersion.count()).toBe(versions);
        expect(await tx.auditLog.count({ where: { action: "legal_entity.import" } })).toBe(audits);

        // and a dry run after the apply (release steps 3-4) is no refusal either
        const dry = await runMain(tx, []);
        expect(dry.code).toBe(0);
        expect(dry.stdout).toContain("present 2");
        expect(dry.stdout).toContain("ACCOUNTED FOR");
      });
    });

    test("a CRM value changed afterwards: mismatched, the registry untouched, exit 1; a registry save carrying it: resolved", async () => {
      await inTx(async (tx) => {
        await run(tx, true);
        await crmAdmin`UPDATE "entity_profile" SET "legalName" = 'Qwerty Fixture Italia Renamed S.r.l.' WHERE "entity" = 'welld_it'::"Entity"`;
        const versions = await tx.legalEntityVersion.count();
        const audits = await tx.auditLog.count({ where: { action: "legal_entity.import" } });

        const apply = await runMain(tx, ["--apply"]);
        expect(apply.code).toBe(1);
        expect(apply.stdout).toContain("welld_it: mismatched");
        expect(apply.stdout).toContain("differs from version 1: legalName");
        expect(apply.stdout).toContain("NOT ACCOUNTED FOR");
        expect(await tx.legalEntityVersion.count()).toBe(versions);
        expect(await tx.auditLog.count({ where: { action: "legal_entity.import" } })).toBe(audits);
        const v1 = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity: "welld_it", version: 1 } } });
        expect(v1?.legalName).toBe(byName("complete-it").expect.legalName);
        // the other entity is still present
        expect(entityReport(await run(tx, false), "welld_ch").category).toBe("present");

        // a registry save that does NOT carry the CRM's value leaves it mismatched
        await saveVersion(tx, v1!, 2, { legalName: "Something Else Entirely" }, ["legalName"]);
        expect(entityReport(await run(tx, false), "welld_it").category).toBe("mismatched");

        // a registry save that carries it: resolved, and the gate is green
        await saveVersion(tx, v1!, 3, { legalName: "Qwerty Fixture Italia Renamed S.r.l." }, ["legalName"]);
        const resolved = await runMain(tx, ["--apply"]);
        expect(resolved.code).toBe(0);
        expect(entityReport(JSON.parse((await runMain(tx, ["--json"])).stdout) as ImportReport, "welld_it").category).toBe("resolved");
        expect(resolved.stdout).toContain("resolved 1");
        expect(await tx.legalEntityVersion.count()).toBe(versions + 2); // only my two saves
      });
    });

    test("later registry saves are not drift: the CRM unchanged, the registry saved since, is still present", async () => {
      await inTx(async (tx) => {
        await run(tx, true);
        const v1 = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity: "welld_ch", version: 1 } } });
        // a new legal name AND a new English address in the registry
        await saveVersion(tx, v1!, 2, { legalName: "Changed In The Registry SA", addressEn: ["Another line"] }, ["legalName", "address.en"]);
        const report = await run(tx, true);
        expect(report.present).toBe(2);
        expect(report.mismatched).toBe(0);
      });
    });

    test("address.en is not compared: only an English address saved in the registry never makes a mismatch or a resolved", async () => {
      await inTx(async (tx) => {
        await run(tx, true);
        await crmAdmin`UPDATE "entity_profile" SET "addressLines" = ARRAY['Via Nuova 9'] WHERE "entity" = 'welld_it'::"Entity"`;
        const v1 = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity: "welld_it", version: 1 } } });
        // version 2 has the CRM's new Italian lines but a different English address: resolved (en is not compared)
        await saveVersion(tx, v1!, 2, { addressIt: ["Via Nuova 9"], addressEn: ["New street 9"] }, ["address.it", "address.en"]);
        expect(entityReport(await run(tx, false), "welld_it").category).toBe("resolved");
      });
    });
  });

  describe("AC-7.3 / D2 / D3 — what is moved as it is, and what is flagged", () => {
    for (const c of CASES) {
      test(`case ${c.name}: moved as it is (apply) with the flags the fixture states`, async () => {
        await seedCases(c);
        await inTx(async (tx) => {
          const dry = await run(tx, false);
          expect(entityReport(dry, c.entity).category).toBe("would_insert");
          const report = await run(tx, true);
          const e = entityReport(report, c.entity);
          expect(e.category).toBe("inserted");
          expect(e.crmRow).toBe(c.crm !== null);
          expect(e.missing).toEqual(c.expect.missing);
          expect(e.incomplete).toBe(c.expect.missing.length > 0);
          expect(e.invalid).toEqual(c.expect.invalid);
          expect(e.ibanPrintChanged).toBe(c.expect.ibanPrintChanged);

          // version 1 exists in every case, with what there is (AC-7.3)
          const v = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity: c.entity, version: 1 } } });
          expect(v).not.toBeNull();
          expect(v!.legalName).toBe(c.expect.legalName);
          expect(v!.addressIt).toEqual(c.expect.address);
          expect(v!.addressEn).toEqual(c.expect.address);
          expect(v!.vatNumber).toBe(c.expect.vatNumber);
          expect(v!.iban).toBe(c.expect.iban);
          expect(v!.createdByUserId).toBeNull();

          // the audit row names the flags
          const audit = (await importAudit(tx, c.entity))[0]!;
          const data = audit.data as { missing: string[]; invalid: unknown[]; ibanPrintChanged: boolean; source: { row: boolean } };
          expect(data.missing).toEqual(c.expect.missing);
          expect(data.invalid).toEqual(c.expect.invalid);
          expect(data.ibanPrintChanged).toBe(c.expect.ibanPrintChanged);
          expect(data.source.row).toBe(c.crm !== null);

          // the other entity has no CRM row: moved empty, incomplete
          const other = LEGAL_ENTITIES.find((x) => x !== c.entity)!;
          const o = entityReport(report, other);
          expect(o.crmRow).toBe(false);
          expect(o.incomplete).toBe(true);
          expect(report.found).toBe(c.crm ? 1 : 0);
        });
      });
    }

    test("ibanPrintChanged is true exactly for the fixtures whose typed IBAN text differs from the printed one", async () => {
      const flagged: string[] = [];
      for (const c of CASES) {
        await seedCases(c);
        await inTx(async (tx) => {
          if (entityReport(await run(tx, false), c.entity).ibanPrintChanged) flagged.push(c.name);
        });
      }
      expect(flagged.sort()).toEqual(CASES.filter((c) => c.expect.ibanPrintChanged).map((c) => c.name).sort());
      expect(flagged).toContain("missing-vat"); // typed without spaces
      expect(flagged).toContain("iban-spaces-lower-case"); // typed in lower case
      expect(flagged).not.toContain("complete-ch"); // typed already in groups of four
      expect(flagged).not.toContain("line-break"); // the CRM printed the wrapped text on one line
    });

    test("mapping unit: the CRM's own print rule, blank lines dropped, IBAN without whitespace and upper case, contacts empty", () => {
      const d = mapProfile({
        legalName: "  A\r\n  B  ",
        addressLines: ["x \n y", "   ", "", "z"],
        vatNumber: null,
        iban: " ab12 \n cd ",
        updatedAt: "",
        updatedBy: null,
      });
      expect(d.legalName).toBe("A B");
      expect(d.address.it).toEqual(["x y", "z"]);
      expect(d.address.en).toEqual(["x y", "z"]);
      expect(d.address.en).not.toBe(d.address.it); // separate arrays
      expect(d.vatNumber).toBe("");
      expect(d.iban).toBe("AB12CD");
      expect(d.contacts).toEqual({ it: "", en: "" });
      expect(differingFields(d, d)).toEqual([]);
    });
  });

  describe("the CRM connection is read only", () => {
    test("a write on it fails (and the row is untouched); a read works", async () => {
      expect(await crm.isReadOnly()).toBe(true);
      for (const statement of [
        `UPDATE "entity_profile" SET "legalName" = 'x'`,
        `DELETE FROM "entity_profile"`,
        `INSERT INTO "entity_profile" ("entity","legalName","updatedBy","updatedAt") VALUES ('welld_it','x','x',now())`,
        `CREATE TABLE zz_must_not_exist (a int)`,
      ]) {
        let failure: unknown;
        try {
          await crm.sql.unsafe(statement);
        } catch (e) {
          failure = e;
        }
        expect(failure).toBeDefined();
        expect(String((failure as Error).message)).toContain("read-only transaction");
      }
      const rows = await crmAdmin`SELECT "legalName" FROM "entity_profile" WHERE "entity" = 'welld_it'::"Entity"`;
      expect((rows[0] as { legalName: string }).legalName).toBe(byName("complete-it").expect.legalName);
      expect((await crm.profile("welld_it"))?.legalName).toBe(byName("complete-it").expect.legalName);
    });

    test("a source that is not read only is refused before any row is read", async () => {
      let profileCalls = 0;
      const writable: CrmSource = {
        isReadOnly: async () => false,
        legalColumns: async () => ({ table: true, absent: [] }),
        profile: async () => {
          profileCalls++;
          return null;
        },
        close: async () => undefined,
      };
      await inTx(async (tx) => {
        const result = await runMain(tx, ["--apply"], writable);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("crm_not_read_only");
        expect(result.stdout).toBe("");
        expect(profileCalls).toBe(0);
        expect(await tx.legalEntityVersion.count()).toBe(0);
      });
    });
  });

  describe("E11 — it stops when the source is gone", () => {
    test("with the four CRM columns dropped: exit 2 crm_legal_columns_absent, no row read, nothing written, nothing printed on stdout", async () => {
      await crmAdmin.unsafe(`ALTER TABLE "entity_profile" DROP COLUMN "legalName", DROP COLUMN "addressLines", DROP COLUMN "vatNumber", DROP COLUMN "iban"`);
      let profileCalls = 0;
      const spy: CrmSource = { ...crm, profile: async (e) => (profileCalls++, crm.profile(e)) };
      await inTx(async (tx) => {
        for (const args of [["--apply"], []]) {
          const result = await runMain(tx, args, spy);
          expect(result.code).toBe(2);
          expect(result.stderr).toContain("crm_legal_columns_absent");
          expect(result.stdout).toBe("");
          expect(profileCalls).toBe(0);
          expect(await tx.legalEntityVersion.count()).toBe(0);
        }
        // the typed error too
        let thrown: unknown;
        try {
          await run(tx, true);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ImportError);
        expect((thrown as ImportError).code).toBe("crm_legal_columns_absent");
        expect((thrown as ImportError).exitCode).toBe(2);
      });
    });

    test("with just one of them dropped it is also over (the mapping cannot be applied)", async () => {
      await crmAdmin.unsafe(`ALTER TABLE "entity_profile" DROP COLUMN "iban"`);
      await inTx(async (tx) => {
        const result = await runMain(tx, []);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("crm_legal_columns_absent");
        expect(result.stderr).toContain("iban");
      });
    });

    test("even when both entities already have a version (it never 'refuses to run' while the columns exist)", async () => {
      await inTx(async (tx) => {
        await run(tx, true);
        expect((await runMain(tx, ["--apply"])).code).toBe(0); // columns exist: exit 0
        await crmAdmin.unsafe(`ALTER TABLE "entity_profile" DROP COLUMN "iban"`);
        expect((await runMain(tx, ["--apply"])).code).toBe(2); // columns gone: exit 2
      });
    });

    test("a database without entity_profile at all is a different failure (wrong database), not the move being over", async () => {
      const wrong = openCrmSource(AUTH_URL); // the registry's own database has no entity_profile
      try {
        await inTx(async (tx) => {
          const result = await runMain(tx, [], wrong);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("crm_entity_profile_absent");
        });
      } finally {
        await wrong.close();
      }
    });

  });

  describe("no value is ever printed (marker scan)", () => {
    /** Every string of every fixture, in each form it takes (typed, mapped, printed), and its words. */
    function markers(): string[] {
      const out = new Set<string>();
      const add = (s: string | null | undefined) => {
        if (!s || s.trim() === "") return;
        out.add(s);
        for (const part of s.split(/[\s\u2028,;"'{}\\]+/)) if (part.length >= 4) out.add(part);
      };
      for (const c of CASES) {
        if (c.crm) {
          add(c.crm.legalName);
          c.crm.addressLines.forEach(add);
          add(c.crm.vatNumber);
          add(c.crm.iban);
        }
        add(c.expect.legalName);
        c.expect.address.forEach(add);
        add(c.expect.vatNumber);
        add(c.expect.iban);
        add(c.expect.iban.replace(/(.{4})(?=.)/g, "$1 "));
      }
      return [...out].filter((m) => m !== "NULL"); // a SQL word, also in the report's vocabulary? kept out of the scan only
    }

    test("stdout and stderr of dry runs, applies, the JSON form and the failures hold none of the fixture's values", async () => {
      const all = markers();
      expect(all.length).toBeGreaterThan(40);
      const captured: string[] = [];
      for (const c of CASES) {
        await seedCases(c);
        await inTx(async (tx) => {
          for (const args of [[], ["--json"], ["--apply"], ["--apply", "--json"], ["--apply"], ["--bogus"]]) {
            const r = await runMain(tx, args);
            captured.push(r.stdout, r.stderr);
          }
          // a mismatch run
          if (c.crm) {
            await crmAdmin`UPDATE "entity_profile" SET "legalName" = 'Qwerty Moved Elsewhere Ltd' WHERE "entity" = ${c.entity}::"Entity"`;
            const r = await runMain(tx, ["--apply"]);
            captured.push(r.stdout, r.stderr);
          }
        });
      }
      // a failing statement whose message carries a row (a CHECK violation does): only its code is shown
      const leaky = Object.assign(new Error('new row for relation "legal_entity_version" violates check constraint; Failing row contains (Qwerty Fixture Italia S.r.l., IT60X0542811101000000123456)'), { code: "23514" });
      const out: string[] = [];
      const err: string[] = [];
      const code = await main({
        argv: ["--apply"],
        env: { CRM_DATABASE_URL: "a", DATABASE_URL: "b" },
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        transact: async () => {
          throw leaky;
        },
        openCrm: () => ({ ...crm, close: async () => undefined }),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("23514");
      captured.push(...out, ...err);

      const text = captured.join("\n");
      expect(text.length).toBeGreaterThan(500);
      const found = all.filter((m) => text.includes(m));
      expect(found).toEqual([]);
      // control: the scan does catch a leak (a report that printed a value would fail it)
      const leaked = `legalName: ${byName("complete-it").expect.legalName}`;
      expect(all.filter((m) => leaked.includes(m)).length).toBeGreaterThan(0);
    });
  });

  describe("the command (scripts/import-crm-legal-details.ts)", () => {
    const AUTH_DIR = join(import.meta.dir, "../..");

    async function script(args: string[], env: Record<string, string>) {
      const proc = Bun.spawn([process.execPath, "run", "scripts/import-crm-legal-details.ts", ...args], {
        cwd: AUTH_DIR,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    }

    test("a dry run against the two databases reports, exits 0 or 1 by the gate, and commits nothing", async () => {
      const before = await committedVersionCount();
      const r = await script(["--json"], { DATABASE_URL: AUTH_URL, CRM_DATABASE_URL: CRM_URL as string });
      expect([0, 1]).toContain(r.code);
      const report = JSON.parse(r.stdout) as ImportReport;
      expect(report.applied).toBe(false);
      expect(report.entities.map((e) => e.entity)).toEqual([...LEGAL_ENTITIES]);
      expect(await committedVersionCount()).toBe(before);
    });

    test("a connection string given as an argument is refused (usage, 64) and is not echoed; missing or equal environment too", async () => {
      const secret = "postgresql://u:s3cr3tpw@h/d";
      const arg = await script([`--database-url=${secret}`], { DATABASE_URL: AUTH_URL, CRM_DATABASE_URL: CRM_URL as string });
      expect(arg.code).toBe(64);
      expect(arg.stdout + arg.stderr).not.toContain("s3cr3tpw");
      const missing = await script([], { DATABASE_URL: AUTH_URL });
      expect(missing.code).toBe(64);
      const same = await script([], { DATABASE_URL: AUTH_URL, CRM_DATABASE_URL: AUTH_URL });
      expect(same.code).toBe(64);
      expect(same.stdout + same.stderr).not.toContain(AUTH_URL);
    });
  });

  /** Puts the four dropped columns back (as crm-api's migrations define them), whatever a test did. */
  async function restoreColumns(): Promise<void> {
    await crmAdmin.unsafe(`ALTER TABLE "entity_profile" ADD COLUMN IF NOT EXISTS "legalName" TEXT NOT NULL DEFAULT ''`);
    await crmAdmin.unsafe(`ALTER TABLE "entity_profile" ALTER COLUMN "legalName" DROP DEFAULT`);
    await crmAdmin.unsafe(`ALTER TABLE "entity_profile" ADD COLUMN IF NOT EXISTS "addressLines" TEXT[]`);
    await crmAdmin.unsafe(`ALTER TABLE "entity_profile" ADD COLUMN IF NOT EXISTS "vatNumber" TEXT`);
    await crmAdmin.unsafe(`ALTER TABLE "entity_profile" ADD COLUMN IF NOT EXISTS "iban" TEXT`);
  }
});
