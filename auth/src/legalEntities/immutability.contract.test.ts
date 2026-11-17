/**
 * AC-2.7 (and AC-1.1's CHECKs), T1 of specs/20261117-legal-entities — against REAL Postgres.
 *
 * `legal_entity_version` is the first Tier 1 table in `auth` (ADR
 * 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database): the guarantee is a
 * property of the database, so a mock proves nothing. Every statement here runs in a transaction that is
 * rolled back (`testDb.ts`); nothing is committed and nothing is removed.
 *
 * A trigger that never fires on an empty table proves nothing, so every refusal test first inserts a valid
 * row, and the valid inserts themselves are asserted to succeed (the refusals are the CHECKs' doing, not a
 * broken fixture).
 */

import { describe, expect, test } from "bun:test";
import { LEGAL_ENTITIES } from "./entities";
import {
  attempt,
  committedVersionCount,
  inRolledBackTx,
  insertSql,
  validImportRow,
} from "./testDb";

const IMMUTABLE = "legal_entity_version_immutable";
const PERSON = { createdByUserId: "u1", createdByName: "A Person" };

describe("AC-2.7 — the triggers refuse changing or removing a version", () => {
  test("a valid system import is accepted (control for every refusal below)", async () => {
    await inRolledBackTx(async (tx) => {
      for (const entity of LEGAL_ENTITIES) {
        expect(await attempt(tx, insertSql(validImportRow(entity)))).toBeNull();
      }
      const rows = await tx.legalEntityVersion.findMany();
      expect(rows.map((r) => `${r.entity}:${r.version}`).sort()).toEqual([
        "welld_ch:1",
        "welld_it:1",
      ]);
    });
  });

  test("a raw UPDATE of an existing version raises legal_entity_version_immutable", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
      expect(
        await attempt(
          tx,
          `UPDATE legal_entity_version SET "iban" = 'CH9300762011623852957' WHERE "entity" = 'welld_it'`,
        ),
      ).toContain(IMMUTABLE);
      // An UPDATE that sets a column to its own value, touching every row, is refused too.
      expect(
        await attempt(tx, `UPDATE legal_entity_version SET "iban" = "iban"`),
      ).toContain(IMMUTABLE);
    });
  });

  test("a raw DELETE of an existing version raises legal_entity_version_immutable", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
      expect(
        await attempt(
          tx,
          `DELETE FROM legal_entity_version WHERE "entity" = 'welld_it' AND "version" = 1`,
        ),
      ).toContain(IMMUTABLE);
      expect(await attempt(tx, `DELETE FROM legal_entity_version`)).toContain(
        IMMUTABLE,
      );
      expect(await tx.legalEntityVersion.count()).toBe(1);
    });
  });

  test("a raw TRUNCATE raises legal_entity_version_immutable (row triggers do not fire on TRUNCATE)", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
      expect(await attempt(tx, `TRUNCATE legal_entity_version`)).toContain(
        IMMUTABLE,
      );
      expect(
        await attempt(
          tx,
          `TRUNCATE TABLE ONLY legal_entity_version RESTART IDENTITY`,
        ),
      ).toContain(IMMUTABLE);
      expect(await tx.legalEntityVersion.count()).toBe(1);
    });
  });

  test("TRUNCATE raises even on an empty table (statement trigger, not row trigger)", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, `TRUNCATE legal_entity_version`)).toContain(
        IMMUTABLE,
      );
    });
  });

  test("the Prisma delegate cannot change or remove a version either (same triggers)", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_ch")))).toBeNull();
      await tx.$executeRawUnsafe("SAVEPOINT le_prisma");
      await expect(
        (async () =>
          await tx.legalEntityVersion.update({
            where: { entity_version: { entity: "welld_ch", version: 1 } },
            data: { iban: "X" },
          }))(),
      ).rejects.toThrow(IMMUTABLE);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT le_prisma");
      await tx.$executeRawUnsafe("SAVEPOINT le_prisma");
      await expect(
        (async () =>
          await tx.legalEntityVersion.deleteMany({
            where: { entity: "welld_ch" },
          }))(),
      ).rejects.toThrow(IMMUTABLE);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT le_prisma");
    });
  });
});

describe("AC-1.1 — the CHECK constraints refuse an invalid version row", () => {
  test("an entity outside LEGAL_ENTITIES (welld_de) is refused by legal_entity_version_entity", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({ ...validImportRow("welld_it"), entity: "welld_de" }),
        ),
      ).toContain("legal_entity_version_entity");
    });
  });

  test("version 0 (and a negative one) is refused by legal_entity_version_positive", async () => {
    await inRolledBackTx(async (tx) => {
      for (const version of [0, -1]) {
        expect(
          await attempt(
            tx,
            // A person's save, so no other CHECK can be the one that fires (Postgres reports the first
            // failing constraint by name order).
            insertSql({
              ...validImportRow("welld_it"),
              ...PERSON,
              action: "save",
              version,
            }),
          ),
        ).toContain("legal_entity_version_positive");
      }
    });
  });

  test("an action outside import/save/restore is refused by legal_entity_version_action", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({
            ...validImportRow("welld_it"),
            ...PERSON,
            action: "edit",
          }),
        ),
      ).toContain("legal_entity_version_action");
    });
  });

  test("an import with a creator is refused by legal_entity_version_import_is_v1_by_system", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({ ...validImportRow("welld_it"), ...PERSON }),
        ),
      ).toContain("legal_entity_version_import_is_v1_by_system");
    });
  });

  test("an import at version 2 is refused by legal_entity_version_import_is_v1_by_system", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({ ...validImportRow("welld_it"), version: 2 }),
        ),
      ).toContain("legal_entity_version_import_is_v1_by_system");
    });
  });

  test("a save with no creator (the system may only import) is refused by the same CHECK", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({
            ...validImportRow("welld_it"),
            action: "save",
            version: 2,
          }),
        ),
      ).toContain("legal_entity_version_import_is_v1_by_system");
    });
  });

  test("a restore without restoredFrom is refused by legal_entity_version_restore", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await attempt(
          tx,
          insertSql({
            ...validImportRow("welld_it"),
            ...PERSON,
            version: 3,
            action: "restore",
          }),
        ),
      ).toContain("legal_entity_version_restore");
    });
  });

  test("a save carrying restoredFrom, and a restore of a version not lower than itself, are refused", async () => {
    await inRolledBackTx(async (tx) => {
      const base = { ...validImportRow("welld_it"), ...PERSON, version: 3 };
      expect(
        await attempt(
          tx,
          insertSql({ ...base, action: "save", restoredFrom: 1 }),
        ),
      ).toContain("legal_entity_version_restore");
      for (const restoredFrom of [3, 4]) {
        expect(
          await attempt(
            tx,
            insertSql({ ...base, action: "restore", restoredFrom }),
          ),
        ).toContain("legal_entity_version_restore");
      }
    });
  });

  test("valid save and restore rows are accepted (the CHECKs are not over-tight)", async () => {
    await inRolledBackTx(async (tx) => {
      const base = { ...validImportRow("welld_it"), ...PERSON };
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
      expect(
        await attempt(tx, insertSql({ ...base, version: 2, action: "save" })),
      ).toBeNull();
      expect(
        await attempt(
          tx,
          insertSql({ ...base, version: 3, action: "restore", restoredFrom: 1 }),
        ),
      ).toBeNull();
    });
  });

  test("the primary key (entity, version) refuses a second row for the same version", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toMatch(
        /legal_entity_version_pkey|Unique constraint|duplicate key/i,
      );
    });
  });
});

describe("R10 — registry tests leave nothing behind", () => {
  test("a rolled-back transaction commits no row", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, insertSql(validImportRow("welld_it")))).toBeNull();
    });
    expect(await committedVersionCount()).toBe(0);
  });

  test("an error thrown inside the transaction still rolls it back and is rethrown", async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        await attempt(tx, insertSql(validImportRow("welld_ch")));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await committedVersionCount()).toBe(0);
  });
});
