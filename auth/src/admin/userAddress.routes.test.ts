/**
 * Integration tests for the Admin Employee Address API (T3, specs/012-
 * employee-address — refs AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-2.4, AC-2.5,
 * AC-3.3, AC-3.4, AC-4.1, AC-5.1, AC-5.4, AC-6.3, AC-6.4).
 *
 * Strategy mirrors `users.routes.test.ts` / `audit.routes.test.ts`: mock
 * `../auth/auth.config` so we can flip sessions without a real OAuth flow;
 * everything else (the router, its middleware chain incl. the REAL
 * `requireAdmin` role-membership query, and every Prisma query) runs for
 * real against the local Postgres (localhost:5435).
 *
 * ── The single highest-consequence assertion in this file ──────────────────
 * "non-admin gets 403 on BOTH verbs, against a colleague's id AND their own"
 * — proves `userAddressRouter`'s re-declared `requireAdmin` gate line is
 * actually present (plan.md / ADR-0031: a forgotten line here silently
 * exposes every employee's home address).
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);

// ─── Mock the session source ───────────────────────────────────────────────

type FakeSession = {
  user: { id: string; email: string; name: string };
  session: { id: string };
} | null;

let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: {
    api: {
      getSession: mock(async () => currentSession),
    },
  },
}));

function actAs(userId: string, email: string) {
  currentSession = {
    user: { id: userId, email, name: email },
    session: { id: `sess_${RUN_ID}` },
  };
}

function actAsAnonymous() {
  currentSession = null;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const createdUserIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T3 fixture ${label} ${RUN_ID}`,
      email: `t3-address-${label}-${RUN_ID}-${unique()}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

/** Idempotently ensures the single shared `Role` row named "admin" exists. */
async function ensureAdminRole(): Promise<string> {
  try {
    const role = await db.role.upsert({
      where: { name: "admin" },
      update: {},
      create: { name: "admin", isSystem: true },
    });
    return role.id;
  } catch {
    const existing = await db.role.findUnique({ where: { name: "admin" } });
    if (existing) return existing.id;
    throw new Error("Failed to ensure the shared 'admin' role exists");
  }
}

async function makeAdmin(label: string) {
  const adminRoleId = await ensureAdminRole();
  const user = await makeUser(label);
  await db.userRole.create({ data: { userId: user.id, roleId: adminRoleId } });
  return user;
}

afterAll(async () => {
  await db.employeeAddress.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.auditLog.deleteMany({ where: { targetId: { in: [...createdUserIds] } } });
  await db.userRole.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  // The shared "admin" Role row is intentionally left in place.
});

const CH_ADDRESS = {
  countryCode: "CH",
  city: "Zürich",
  street: "Bahnhofstrasse",
  houseNumber: "12b",
  postalCode: "8001",
  region: "Zürich",
};

const FR_ADDRESS = {
  countryCode: "FR",
  city: "Paris",
  street: "Rue de Rivoli",
  houseNumber: "1",
};

describe("Admin Employee Address API (T3)", () => {
  // ── AC-4.1 / R12 — the single highest-consequence assertion ──────────────

  test("403s a non-admin on GET and PUT, against a colleague's id AND their own id (AC-4.1)", async () => {
    const nonAdmin = await makeUser("nonadmin-guard");
    const colleague = await makeUser("colleague-guard");
    actAs(nonAdmin.id, nonAdmin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const getColleague = await userAddressRouter.request(
      `/admin/users/${colleague.id}/address`,
    );
    expect(getColleague.status).toBe(403);

    const putColleague = await userAddressRouter.request(
      `/admin/users/${colleague.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(putColleague.status).toBe(403);

    // AC-4.1 explicitly: "including their OWN" — a non-admin cannot even
    // read/write their OWN address through the admin route.
    const getOwn = await userAddressRouter.request(
      `/admin/users/${nonAdmin.id}/address`,
    );
    expect(getOwn.status).toBe(403);

    const putOwn = await userAddressRouter.request(
      `/admin/users/${nonAdmin.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(putOwn.status).toBe(403);

    for (const res of [getColleague, putColleague, getOwn, putOwn]) {
      const body = (await res.json()) as { status: number; title: string; type: string };
      expect(body.status).toBe(403);
      expect(body.title).toBe("Forbidden");
      expect(body.type).toBe("https://httpstatuses.com/403");
    }
  });

  test("401s GET and PUT when there is no session", async () => {
    actAsAnonymous();
    const { userAddressRouter } = await import("./userAddress.routes");
    const someId = "usr_does_not_matter";

    const getRes = await userAddressRouter.request(`/admin/users/${someId}/address`);
    expect(getRes.status).toBe(401);

    const putRes = await userAddressRouter.request(
      `/admin/users/${someId}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: null }),
      },
    );
    expect(putRes.status).toBe(401);
  });

  // ── AC-1.1/1.2 — read + persist + round-trip ──────────────────────────────

  test("GET returns address:null for an untouched user (AC-1.1)", async () => {
    const admin = await makeAdmin("get-empty-admin");
    const employee = await makeUser("get-empty-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; address: unknown };
    expect(body.userId).toBe(employee.id);
    expect(body.address).toBeNull();
  });

  test("PUT then a fresh GET round-trips byte-identically, with exactly one row for that userId (AC-1.1/1.2)", async () => {
    const admin = await makeAdmin("roundtrip-admin");
    const employee = await makeUser("roundtrip-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const putRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      userId: string;
      address: Record<string, unknown>;
    };
    expect(putBody.address["countryCode"]).toBe("CH");
    expect(putBody.address["formatted"]).toBe(
      "Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland",
    );

    const getRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
    );
    const getBody = (await getRes.json()) as {
      userId: string;
      address: Record<string, unknown>;
    };
    expect(getBody.address["countryCode"]).toBe(putBody.address["countryCode"]);
    expect(getBody.address["city"]).toBe(putBody.address["city"]);
    expect(getBody.address["street"]).toBe(putBody.address["street"]);
    expect(getBody.address["houseNumber"]).toBe(putBody.address["houseNumber"]);
    expect(getBody.address["postalCode"]).toBe(putBody.address["postalCode"]);
    expect(getBody.address["region"]).toBe(putBody.address["region"]);
    expect(getBody.address["formatted"]).toBe(putBody.address["formatted"]);

    const rows = await db.employeeAddress.findMany({
      where: { userId: employee.id },
    });
    expect(rows.length).toBe(1);

    // A second PUT replaces IN PLACE — still exactly one row for this userId.
    const putRes2 = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: { ...CH_ADDRESS, city: "Geneva" } }),
      },
    );
    expect(putRes2.status).toBe(200);
    const rowsAfterReplace = await db.employeeAddress.findMany({
      where: { userId: employee.id },
    });
    expect(rowsAfterReplace.length).toBe(1);
    expect(rowsAfterReplace[0]?.city).toBe("Geneva");
  });

  // ── AC-1.3 — intentional clear ────────────────────────────────────────────

  test("PUT {address:null} on a populated user clears it, and writes an audit row (AC-1.3)", async () => {
    const admin = await makeAdmin("clear-admin");
    const employee = await makeUser("clear-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: CH_ADDRESS }),
    });

    const auditCountBefore = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });

    const clearRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: null }),
      },
    );
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as { address: unknown };
    expect(clearBody.address).toBeNull();

    const row = await db.employeeAddress.findUnique({
      where: { userId: employee.id },
    });
    expect(row).toBeNull();

    const auditCountAfter = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });
    expect(auditCountAfter).toBe(auditCountBefore + 1);

    const clearAuditRow = await db.auditLog.findFirst({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
      orderBy: { createdAt: "desc" },
    });
    const data = clearAuditRow?.data as { before: unknown; after: unknown } | null;
    expect(data?.after).toBeNull();
    expect(data?.before).not.toBeNull();
  });

  // ── AC-1.4 — four-field completeness, table-driven ────────────────────────

  const REQUIRED_FIELDS = ["countryCode", "city", "street", "houseNumber"] as const;

  for (const field of REQUIRED_FIELDS) {
    for (const badValue of [undefined, "", "   "] as const) {
      test(`422s with code "address_incomplete" and missingFields:["${field}"] when ${field} is ${JSON.stringify(badValue)} (AC-1.4)`, async () => {
        const admin = await makeAdmin(`incomplete-admin-${field}-${String(badValue)}`);
        const employee = await makeUser(`incomplete-employee-${field}-${String(badValue)}`);
        actAs(admin.id, admin.email);
        const { userAddressRouter } = await import("./userAddress.routes");

        const address: Record<string, unknown> = { ...CH_ADDRESS };
        if (badValue === undefined) {
          delete address[field];
        } else {
          address[field] = badValue;
        }

        const res = await userAddressRouter.request(
          `/admin/users/${employee.id}/address`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address }),
          },
        );

        expect(res.status).toBe(422);
        const body = (await res.json()) as {
          code: string;
          missingFields: string[];
        };
        expect(body.code).toBe("address_incomplete");
        expect(body.missingFields).toContain(field);

        // Never persisted half-filled.
        const row = await db.employeeAddress.findUnique({
          where: { userId: employee.id },
        });
        expect(row).toBeNull();
      });
    }
  }

  test("both optional fields (postalCode, region) omitted ⇒ 200 (AC-1.4 — never a reason to reject)", async () => {
    const admin = await makeAdmin("optional-omitted-admin");
    const employee = await makeUser("optional-omitted-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: FR_ADDRESS }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: Record<string, unknown> };
    expect(body.address["postalCode"]).toBeNull();
    expect(body.address["region"]).toBeNull();
  });

  // ── Regression: a malformed-but-non-blank countryCode 422s, never 500s ────
  //
  // Flagged by QE during specs/012 verification: "CHE" (or any string that
  // isn't exactly two uppercase letters) is non-blank, so it sailed past
  // `normalizeAndValidate`'s completeness check, reached
  // `tx.employeeAddress.upsert(...)`, and was rejected by the DB's
  // `employee_address_country_alpha2` CHECK — an uncaught Postgres error the
  // global `app.onError` turned into a bare 500, not a 422. Unreachable from
  // admin-ui (the Country combobox only ever emits a value from its bundled
  // ISO 3166-1 alpha-2 list), but reachable by any raw API caller, and a
  // convention violation regardless (every validation failure on this route
  // is otherwise a 422 Problem JSON with a distinguishing `code`).

  for (const badCountryCode of ["CHE", "1x", "C", "  CHE  ", "🇨🇭"]) {
    test(`422s with code "address_country_invalid" when countryCode is ${JSON.stringify(badCountryCode)} — never 500s (regression)`, async () => {
      const admin = await makeAdmin(`bad-country-admin-${unique()}`);
      const employee = await makeUser(`bad-country-employee-${unique()}`);
      actAs(admin.id, admin.email);
      const { userAddressRouter } = await import("./userAddress.routes");

      const res = await userAddressRouter.request(
        `/admin/users/${employee.id}/address`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: { ...CH_ADDRESS, countryCode: badCountryCode },
          }),
        },
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        code: string;
        field: string;
        type: string;
        title: string;
        status: number;
        detail: string;
        instance: string;
      };
      expect(body.code).toBe("address_country_invalid");
      expect(body.field).toBe("countryCode");
      // Still RFC 7807 Problem JSON (CLAUDE.md), not a bare 500 text/plain body.
      expect(body.type).toBe("https://httpstatuses.com/422");
      expect(body.status).toBe(422);

      // Never persisted half-valid.
      const row = await db.employeeAddress.findUnique({
        where: { userId: employee.id },
      });
      expect(row).toBeNull();
    });
  }

  test("a lowercase-but-otherwise-valid countryCode is normalized and accepted, not rejected (AC-1.4 sanity check against the new format guard)", async () => {
    const admin = await makeAdmin(`lowercase-country-admin-${unique()}`);
    const employee = await makeUser(`lowercase-country-employee-${unique()}`);
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: { ...CH_ADDRESS, countryCode: "ch" },
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: Record<string, unknown> };
    expect(body.address["countryCode"]).toBe("CH");
  });

  // ── AC-2.4 — a non-CH/IT address saves normally ───────────────────────────

  test("an FR address saves normally, on identical terms to a CH one (AC-2.4)", async () => {
    const admin = await makeAdmin("fr-admin");
    const employee = await makeUser("fr-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: FR_ADDRESS }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: Record<string, unknown> };
    expect(body.address["countryCode"]).toBe("FR");
  });

  // ── AC-2.5 / AC-3.4 — coordinates ──────────────────────────────────────────

  test("PUT with coordinates round-trips through GET, quantized to 6dp (AC-2.5)", async () => {
    const admin = await makeAdmin("coords-admin");
    const employee = await makeUser("coords-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const putRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: { ...CH_ADDRESS, latitude: 47.37021234, longitude: 8.53971234 },
        }),
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      address: { latitude: number; longitude: number };
    };
    expect(putBody.address.latitude).toBeCloseTo(47.370212, 6);
    expect(putBody.address.longitude).toBeCloseTo(8.539712, 6);

    const getRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
    );
    const getBody = (await getRes.json()) as {
      address: { latitude: number; longitude: number };
    };
    expect(getBody.address.latitude).toBeCloseTo(47.370212, 6);
    expect(getBody.address.longitude).toBeCloseTo(8.539712, 6);
  });

  test("PUT with both coordinates null succeeds — the manual-entry path (AC-3.4)", async () => {
    const admin = await makeAdmin("nocoords-admin");
    const employee = await makeUser("nocoords-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: { ...CH_ADDRESS, latitude: null, longitude: null },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: { latitude: null; longitude: null };
    };
    expect(body.address.latitude).toBeNull();
    expect(body.address.longitude).toBeNull();

    const row = await db.employeeAddress.findUnique({
      where: { userId: employee.id },
    });
    expect(row?.latitude).toBeNull();
    expect(row?.longitude).toBeNull();
  });

  test("exactly one of lat/lng present is normalized to (null, null), never a 400", async () => {
    const admin = await makeAdmin("asymmetric-admin");
    const employee = await makeUser("asymmetric-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: { ...CH_ADDRESS, latitude: 47.37, longitude: null },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: { latitude: null; longitude: null };
    };
    expect(body.address.latitude).toBeNull();
    expect(body.address.longitude).toBeNull();
  });

  // ── AC-3.3 — a purely typed address is accepted on identical terms ───────

  test("a purely manually-typed address (no coordinates, no suggestion) saves on identical terms (AC-3.3)", async () => {
    const admin = await makeAdmin("manual-admin");
    const employee = await makeUser("manual-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(res.status).toBe(200);
  });

  // ── AC-4.1 (404 posture) ──────────────────────────────────────────────────

  test("404s GET and PUT for an unknown user id, as an admin", async () => {
    const admin = await makeAdmin("unknown-target-admin");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const getRes = await userAddressRouter.request(
      `/admin/users/does-not-exist-${RUN_ID}/address`,
    );
    expect(getRes.status).toBe(404);

    const putRes = await userAddressRouter.request(
      `/admin/users/does-not-exist-${RUN_ID}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(putRes.status).toBe(404);
  });

  test("404s GET and PUT for a soft-deleted user, as an admin", async () => {
    const admin = await makeAdmin("softdeleted-target-admin");
    const deletedUser = await makeUser("softdeleted-target-employee");
    await db.user.update({
      where: { id: deletedUser.id },
      data: { deletedAt: new Date() },
    });
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const getRes = await userAddressRouter.request(
      `/admin/users/${deletedUser.id}/address`,
    );
    expect(getRes.status).toBe(404);

    const putRes = await userAddressRouter.request(
      `/admin/users/${deletedUser.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(putRes.status).toBe(404);
  });

  // ── AC-5.1 — audit captures actor/timestamp/employee/old→new ─────────────

  test("a set writes an audit row with actor/timestamp/employee/before(null)→after (AC-5.1)", async () => {
    const admin = await makeAdmin("audit-set-admin");
    const employee = await makeUser("audit-set-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const before = Date.now();
    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(res.status).toBe(200);

    const row = await db.auditLog.findFirst({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row?.actorUserId).toBe(admin.id);
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const data = row?.data as { before: unknown; after: Record<string, unknown> };
    expect(data.before).toBeNull();
    expect(data.after["countryCode"]).toBe("CH");
    // Audit snapshot is always English, never re-rendered per viewer locale.
    expect(data.after["formatted"]).toBe(
      "Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland",
    );
  });

  test("a change writes an audit row with a non-null before AND after", async () => {
    const admin = await makeAdmin("audit-change-admin");
    const employee = await makeUser("audit-change-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: CH_ADDRESS }),
    });
    await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: { ...CH_ADDRESS, city: "Bern" } }),
    });

    const rows = await db.auditLog.findMany({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBe(2);
    const secondData = rows[1]?.data as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(secondData.before["city"]).toBe("Zürich");
    expect(secondData.after["city"]).toBe("Bern");
  });

  test("affectedUserIds is empty — an address change never bumps permissionEpoch (deliberate divergence)", async () => {
    const admin = await makeAdmin("epoch-admin");
    const employee = await makeUser("epoch-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const before = await db.user.findUniqueOrThrow({
      where: { id: employee.id },
      select: { permissionEpoch: true },
    });

    await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: CH_ADDRESS }),
    });

    const after = await db.user.findUniqueOrThrow({
      where: { id: employee.id },
      select: { permissionEpoch: true },
    });
    expect(after.permissionEpoch).toBe(before.permissionEpoch);
  });

  // ── AC-5.4 — no-op guard ───────────────────────────────────────────────────

  test("an identical double-PUT (incl. differing whitespace/case) writes exactly one audit row, and does not bump updatedAt (AC-5.4)", async () => {
    const admin = await makeAdmin("noop-admin");
    const employee = await makeUser("noop-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const firstRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    const firstBody = (await firstRes.json()) as {
      address: { updatedAt: string };
    };

    const auditCountAfterFirst = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });

    // Differing whitespace and case, but semantically identical after
    // normalization (trim + upper-case countryCode).
    const secondRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: {
            ...CH_ADDRESS,
            countryCode: "ch",
            city: "  Zürich  ",
            street: "Bahnhofstrasse  ",
          },
        }),
      },
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as {
      address: { updatedAt: string };
    };

    const auditCountAfterSecond = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);

    // updatedAt is unchanged by the no-op second call.
    expect(secondBody.address.updatedAt).toBe(firstBody.address.updatedAt);
  });

  // ── AC-5.4 completeness: the no-op guard's semantic comparison covers ALL
  // eight fields, not merely the required four ──────────────────────────────
  //
  // The tests above only ever change `countryCode`/`city`/`street` (three of
  // the eight fields `normalizedAddressesEqual` compares). Flagged by QE
  // during specs/012 verification: nothing previously proved that a change
  // confined to ONLY an optional field (postalCode, region) or ONLY the
  // coordinate pair is correctly detected as a REAL change rather than
  // silently swallowed as a no-op — a plausible regression (e.g. a future
  // edit to `normalizedAddressesEqual` that forgets to compare one of those
  // fields) would have shipped with every other test here still green.

  const BASE_WITH_COORDS = {
    ...CH_ADDRESS,
    latitude: 47.3702,
    longitude: 8.5397,
  };

  const OPTIONAL_FIELD_CHANGES: Array<{
    label: string;
    changed: Record<string, unknown>;
  }> = [
    { label: "postalCode", changed: { postalCode: "8002" } },
    { label: "region", changed: { region: "Bern" } },
    { label: "latitude+longitude", changed: { latitude: 46.948, longitude: 7.4474 } },
  ];

  for (const { label, changed } of OPTIONAL_FIELD_CHANGES) {
    test(`a change confined to ONLY ${label} is detected as genuine, not swallowed as a no-op (AC-5.4 completeness)`, async () => {
      const admin = await makeAdmin(`noop-completeness-admin-${unique()}`);
      const employee = await makeUser(`noop-completeness-employee-${unique()}`);
      actAs(admin.id, admin.email);
      const { userAddressRouter } = await import("./userAddress.routes");

      await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: BASE_WITH_COORDS }),
      });
      const auditCountAfterFirst = await db.auditLog.count({
        where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
      });

      const secondRes = await userAddressRouter.request(
        `/admin/users/${employee.id}/address`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: { ...BASE_WITH_COORDS, ...changed } }),
        },
      );
      expect(secondRes.status).toBe(200);

      const auditCountAfterSecond = await db.auditLog.count({
        where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
      });
      // A GENUINE change: exactly one more audit row, never treated as a no-op.
      expect(auditCountAfterSecond).toBe(auditCountAfterFirst + 1);

      const row = await db.employeeAddress.findUnique({ where: { userId: employee.id } });
      for (const [key, value] of Object.entries(changed)) {
        const stored = row ? (row as unknown as Record<string, unknown>)[key] : undefined;
        if (typeof value === "number") {
          expect(Number(stored)).toBeCloseTo(value, 5);
        } else {
          expect(stored).toBe(value);
        }
      }
    });
  }

  test("re-submitting an unchanged coordinate pair (identical lat/lng) is still a no-op (AC-5.4 completeness)", async () => {
    const admin = await makeAdmin(`noop-coords-admin-${unique()}`);
    const employee = await makeUser(`noop-coords-employee-${unique()}`);
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    await userAddressRouter.request(`/admin/users/${employee.id}/address`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: BASE_WITH_COORDS }),
    });
    const auditCountAfterFirst = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });

    const secondRes = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Byte-identical resubmission, including the coordinates.
        body: JSON.stringify({ address: BASE_WITH_COORDS }),
      },
    );
    expect(secondRes.status).toBe(200);

    const auditCountAfterSecond = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });

  test("a no-op clear (address already absent) writes nothing", async () => {
    const admin = await makeAdmin("noop-clear-admin");
    const employee = await makeUser("noop-clear-employee");
    actAs(admin.id, admin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const auditCountBefore = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });

    const res = await userAddressRouter.request(
      `/admin/users/${employee.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: null }),
      },
    );
    expect(res.status).toBe(200);

    const auditCountAfter = await db.auditLog.count({
      where: { targetType: "user", targetId: employee.id, action: "user.address.set" },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // ── AC-6.3 / AC-6.4 (the admin-route halves of these ACs) ────────────────

  test("a non-admin gets 403 (not 404) attempting to PUT their own address via the admin route (AC-6.3)", async () => {
    const nonAdmin = await makeUser("self-write-guard");
    actAs(nonAdmin.id, nonAdmin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${nonAdmin.id}/address`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: CH_ADDRESS }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("a non-admin gets 403 (not 404) attempting to GET a colleague's address via the admin route (AC-6.4)", async () => {
    const nonAdmin = await makeUser("colleague-read-guard");
    const colleague = await makeUser("colleague-read-target");
    actAs(nonAdmin.id, nonAdmin.email);
    const { userAddressRouter } = await import("./userAddress.routes");

    const res = await userAddressRouter.request(
      `/admin/users/${colleague.id}/address`,
    );
    expect(res.status).toBe(403);
  });
});
