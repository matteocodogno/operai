/**
 * DB-level CHECK constraint tests for `employee_address` (T1,
 * specs/012-employee-address/tasks.md; plan.md "Data model" migration
 * `20260804094012_employee_address`).
 *
 * QE fix (specs/012-employee-address fix round): T1 was implemented and its
 * CHECKs were verified BY HAND with `psql` at the time, but no test was ever
 * committed proving they actually bite — this file is that test. Every case
 * below inserts directly via `$executeRawUnsafe`, deliberately bypassing
 * `userAddress.routes.ts`'s zod/handler-level validation, so a genuine gap
 * in the DATABASE constraint itself (not the application layer sitting in
 * front of it) would be caught here even if the route's own validation were
 * ever removed, weakened, or bypassed by a future direct-DB write path.
 *
 * ── CHECK-count reconciliation (QE fix) ─────────────────────────────────────
 * The eval report (specs/012-employee-address/eval-report.md) observed "five
 * DB CHECKs" on the live schema; plan.md's migration SQL names four. Verified
 * directly against the live schema (`pg_constraint` for `employee_address`,
 * `contype` column): there are EXACTLY FOUR constraints of type `c` (CHECK) —
 *   employee_address_required_nonblank
 *   employee_address_country_alpha2
 *   employee_address_coords_paired
 *   employee_address_coords_range
 * — plus a PRIMARY KEY (`employee_address_pkey`, contype `p`) and a FOREIGN
 * KEY (`employee_address_userId_fkey`, contype `f`, `ON DELETE CASCADE`).
 * The eval's "five" count folded the FK's `ON DELETE CASCADE` in as if it
 * were a fifth CHECK — it isn't one (`contype = 'f'`, not `'c'`); plan.md's
 * SQL (four named CHECKs) is the accurate count, verified live below.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T1-checks fixture ${label} ${RUN_ID}`,
      email: `t1-checks-${label}-${RUN_ID}-${unique()}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

afterAll(async () => {
  await db.employeeAddress.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
});

/** Postgres's `check_violation` SQLSTATE — https://www.postgresql.org/docs/current/errcodes-appendix.html */
const CHECK_VIOLATION_SQLSTATE = "23514";

/**
 * Inserts directly via raw SQL (bypassing the app's zod/handler validation
 * entirely — this file tests the DATABASE constraint, not the route) and
 * asserts the insert is rejected with SQLSTATE 23514 naming the expected
 * constraint.
 */
async function expectCheckViolation(
  userId: string,
  columns: Record<string, string | number | null>,
  expectedConstraint: string,
) {
  const cols = ["userId", ...Object.keys(columns)];
  const values = [userId, ...Object.values(columns)];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const columnList = cols.map((c) => `"${c}"`).join(", ");

  let thrown: unknown;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "employee_address" (${columnList}, "updatedAt") VALUES (${placeholders}, now())`,
      ...values,
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeDefined();
  const message = String((thrown as { message?: unknown })?.message ?? "");
  expect(message).toContain(CHECK_VIOLATION_SQLSTATE);
  expect(message).toContain(expectedConstraint);

  // Belt and braces: the row must genuinely not exist (a partially-applied
  // insert would be worse than a rejected one).
  const row = await db.employeeAddress.findUnique({ where: { userId } });
  expect(row).toBeNull();
}

/** A fully valid row — the positive control proving the constraints aren't over-strict. */
const VALID_ROW = {
  countryCode: "CH",
  city: "Zürich",
  street: "Bahnhofstrasse",
  houseNumber: "12b",
};

describe("T1 — employee_address DB-level CHECK constraints", () => {
  test("positive control — a fully valid row is accepted (constraints aren't over-strict)", async () => {
    const user = await makeUser("valid");
    await db.employeeAddress.create({ data: { userId: user.id, ...VALID_ROW } });
    const row = await db.employeeAddress.findUnique({ where: { userId: user.id } });
    expect(row).not.toBeNull();
    expect(row?.countryCode).toBe("CH");
  });

  describe("employee_address_required_nonblank — city/street/houseNumber may not be blank or whitespace-only", () => {
    test.each([
      ["city", { ...VALID_ROW, city: "" }],
      ["city (whitespace-only)", { ...VALID_ROW, city: "   " }],
      ["street", { ...VALID_ROW, street: "" }],
      ["street (whitespace-only)", { ...VALID_ROW, street: "   " }],
      ["houseNumber", { ...VALID_ROW, houseNumber: "" }],
      ["houseNumber (whitespace-only)", { ...VALID_ROW, houseNumber: "   " }],
    ])("rejects a blank %s", async (label, columns) => {
      const user = await makeUser(`nonblank-${label.replace(/[^a-z0-9]/gi, "")}`);
      await expectCheckViolation(user.id, columns, "employee_address_required_nonblank");
    });
  });

  describe("employee_address_country_alpha2 — countryCode must be exactly two uppercase letters", () => {
    test.each([
      ["lowercase", "ch"],
      ["three letters", "CHE"],
      ["one letter", "C"],
      ["contains a digit", "C1"],
      ["empty", ""],
    ])("rejects countryCode = %s (%s)", async (_label, countryCode) => {
      const user = await makeUser(`alpha2-${_label.replace(/[^a-z0-9]/gi, "")}`);
      await expectCheckViolation(user.id, { ...VALID_ROW, countryCode }, "employee_address_country_alpha2");
    });
  });

  describe('employee_address_coords_paired — "(latitude IS NULL) = (longitude IS NULL)"', () => {
    test("rejects latitude set with longitude NULL", async () => {
      const user = await makeUser("paired-lat-only");
      await expectCheckViolation(user.id, { ...VALID_ROW, latitude: 47.3702, longitude: null }, "employee_address_coords_paired");
    });

    test("rejects longitude set with latitude NULL", async () => {
      const user = await makeUser("paired-lng-only");
      await expectCheckViolation(user.id, { ...VALID_ROW, latitude: null, longitude: 8.5397 }, "employee_address_coords_paired");
    });

    test("accepts both NULL (no coordinates on file)", async () => {
      const user = await makeUser("paired-both-null");
      await db.employeeAddress.create({ data: { userId: user.id, ...VALID_ROW } });
      const row = await db.employeeAddress.findUnique({ where: { userId: user.id } });
      expect(row?.latitude).toBeNull();
      expect(row?.longitude).toBeNull();
    });

    test("accepts both set (a genuine coordinate pair)", async () => {
      const user = await makeUser("paired-both-set");
      await db.employeeAddress.create({
        data: { userId: user.id, ...VALID_ROW, latitude: 47.3702, longitude: 8.5397 },
      });
      const row = await db.employeeAddress.findUnique({ where: { userId: user.id } });
      expect(row?.latitude?.toNumber()).toBeCloseTo(47.3702);
      expect(row?.longitude?.toNumber()).toBeCloseTo(8.5397);
    });
  });

  describe("employee_address_coords_range — latitude ∈ [-90,90], longitude ∈ [-180,180]", () => {
    test.each([
      ["latitude > 90", { latitude: 90.000001, longitude: 8.5397 }],
      ["latitude < -90", { latitude: -90.000001, longitude: 8.5397 }],
      ["longitude > 180", { latitude: 47.3702, longitude: 180.000001 }],
      ["longitude < -180", { latitude: 47.3702, longitude: -180.000001 }],
    ])("rejects %s", async (label, coords) => {
      const user = await makeUser(`range-${label.replace(/[^a-z0-9]/gi, "")}`);
      await expectCheckViolation(user.id, { ...VALID_ROW, ...coords }, "employee_address_coords_range");
    });

    test.each([
      ["latitude = 90 (boundary, inclusive)", { latitude: 90, longitude: 8.5397 }],
      ["latitude = -90 (boundary, inclusive)", { latitude: -90, longitude: 8.5397 }],
      ["longitude = 180 (boundary, inclusive)", { latitude: 47.3702, longitude: 180 }],
      ["longitude = -180 (boundary, inclusive)", { latitude: 47.3702, longitude: -180 }],
    ])("accepts %s", async (label, coords) => {
      const user = await makeUser(`range-ok-${label.replace(/[^a-z0-9]/gi, "")}`);
      await db.employeeAddress.create({ data: { userId: user.id, ...VALID_ROW, ...coords } });
      const row = await db.employeeAddress.findUnique({ where: { userId: user.id } });
      expect(row).not.toBeNull();
    });
  });

  describe("CHECK-count reconciliation — exactly four CHECK constraints on employee_address (contype = 'c')", () => {
    test("pg_constraint reports exactly the four CHECKs plan.md's migration SQL names — no more, no fewer", async () => {
      const rows = await db.$queryRawUnsafe<Array<{ conname: string; contype: string }>>(
        `SELECT conname, contype::text AS contype
         FROM pg_constraint
         WHERE conrelid = 'employee_address'::regclass
         ORDER BY conname`,
      );

      const checks = rows.filter((r) => r.contype === "c").map((r) => r.conname).sort();
      expect(checks).toEqual(
        [
          "employee_address_coords_paired",
          "employee_address_coords_range",
          "employee_address_country_alpha2",
          "employee_address_required_nonblank",
        ].sort(),
      );

      // The PRIMARY KEY and the FK (ON DELETE CASCADE) both exist, but neither
      // is a CHECK — this is precisely what the eval report's "five" count
      // conflated (see this file's module doc comment).
      const nonCheckTypes = rows.filter((r) => r.contype !== "c").map((r) => r.contype).sort();
      expect(nonCheckTypes).toEqual(["f", "p"]);
    });
  });
});
