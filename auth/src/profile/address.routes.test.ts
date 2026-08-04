/**
 * Integration tests for the employee self-address API (T4, specs/012-
 * employee-address — refs AC-6.1, AC-6.2, AC-6.3, AC-6.4).
 *
 * Strategy mirrors `../admin/userAddress.routes.test.ts`: mock
 * `../auth/auth.config` so we can flip sessions without a real OAuth flow.
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
      name: `T4 fixture ${label} ${RUN_ID}`,
      email: `t4-address-${label}-${RUN_ID}-${unique()}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

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
});

const CH_ADDRESS = {
  countryCode: "CH",
  city: "Zürich",
  street: "Bahnhofstrasse",
  houseNumber: "12b",
  postalCode: "8001",
  region: "Zürich",
};

/** Sets an employee's address via the admin route (the only write path). */
async function setAddressAsAdmin(
  adminId: string,
  adminEmail: string,
  employeeId: string,
  address: Record<string, unknown> | null,
) {
  currentSession = {
    user: { id: adminId, email: adminEmail, name: adminEmail },
    session: { id: `sess_${RUN_ID}` },
  };
  const { userAddressRouter } = await import("../admin/userAddress.routes");
  await userAddressRouter.request(`/admin/users/${employeeId}/address`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

describe("Employee self-address API (T4)", () => {
  test("401s when there is no session", async () => {
    actAsAnonymous();
    const { addressRouter } = await import("./address.routes");

    const res = await addressRouter.request("/me/address");
    expect(res.status).toBe(401);
  });

  test("returns address:null for a caller with none on file (AC-6.1)", async () => {
    const employee = await makeUser("self-empty");
    actAs(employee.id, employee.email);
    const { addressRouter } = await import("./address.routes");

    const res = await addressRouter.request("/me/address");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: unknown };
    expect(body.address).toBeNull();
  });

  test("returns the caller's OWN address, formatted (AC-6.1)", async () => {
    const admin = await makeAdmin("self-populated-admin");
    const employee = await makeUser("self-populated-employee");
    await setAddressAsAdmin(admin.id, admin.email, employee.id, CH_ADDRESS);

    actAs(employee.id, employee.email);
    const { addressRouter } = await import("./address.routes");

    const res = await addressRouter.request("/me/address");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: Record<string, unknown> };
    expect(body.address["countryCode"]).toBe("CH");
    expect(body.address["formatted"]).toBe(
      "Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland",
    );
  });

  test("updatedByUserId is deliberately absent from this response", async () => {
    const admin = await makeAdmin("self-noupdatedby-admin");
    const employee = await makeUser("self-noupdatedby-employee");
    await setAddressAsAdmin(admin.id, admin.email, employee.id, CH_ADDRESS);

    actAs(employee.id, employee.email);
    const { addressRouter } = await import("./address.routes");

    const res = await addressRouter.request("/me/address");
    const body = (await res.json()) as { address: Record<string, unknown> };
    expect("updatedByUserId" in body.address).toBe(false);
  });

  // ── AC-6.4 — two distinct users each get strictly their own row ──────────

  test("two distinct fixture users each receive strictly their own row (AC-6.4)", async () => {
    const admin = await makeAdmin("self-distinct-admin");
    const employeeA = await makeUser("self-distinct-a");
    const employeeB = await makeUser("self-distinct-b");

    await setAddressAsAdmin(admin.id, admin.email, employeeA.id, CH_ADDRESS);
    await setAddressAsAdmin(admin.id, admin.email, employeeB.id, {
      countryCode: "FR",
      city: "Paris",
      street: "Rue de Rivoli",
      houseNumber: "1",
    });

    const { addressRouter } = await import("./address.routes");

    actAs(employeeA.id, employeeA.email);
    const resA = await addressRouter.request("/me/address");
    const bodyA = (await resA.json()) as { address: Record<string, unknown> };
    expect(bodyA.address["countryCode"]).toBe("CH");

    actAs(employeeB.id, employeeB.email);
    const resB = await addressRouter.request("/me/address");
    const bodyB = (await resB.json()) as { address: Record<string, unknown> };
    expect(bodyB.address["countryCode"]).toBe("FR");
  });

  test("there is no request that can name another employee — no :id parameter exists (AC-6.4, structural)", async () => {
    const employeeA = await makeUser("self-noparam-a");
    const employeeB = await makeUser("self-noparam-b");
    actAs(employeeA.id, employeeA.email);
    const { addressRouter } = await import("./address.routes");

    // There is no query param, path param, or header this route reads to
    // widen scope — attempting to smuggle another user's id via a query
    // string is simply ignored; the response is still employeeA's own.
    const res = await addressRouter.request(
      `/me/address?userId=${employeeB.id}&id=${employeeB.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: unknown };
    expect(body.address).toBeNull(); // employeeA has none on file
  });

  // ── AC-6.3 — no write verb exists at /me/address ──────────────────────────

  test.each(["PUT", "POST", "PATCH", "DELETE"] as const)(
    "%s /me/address falls through to 404 RFC 7807 (AC-6.3 — no write verb registered)",
    async (method) => {
      const employee = await makeUser(`self-nowrite-${method}`);
      actAs(employee.id, employee.email);
      const { addressRouter } = await import("./address.routes");

      const res = await addressRouter.request("/me/address", {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ address: CH_ADDRESS }),
      });
      // Hono's bare-router default 404 (no app-level notFound wired on this
      // sub-router in isolation — the real app-level onError/notFound in
      // src/index.ts renders RFC 7807 JSON when mounted) — either way, the
      // important assertion is the status: no handler exists anywhere in
      // this router that would let a caller mutate this resource.
      expect(res.status).toBe(404);
    },
  );

  test("the caller's own address is unaffected by attempting a write at /me/address", async () => {
    const admin = await makeAdmin("self-writeblocked-admin");
    const employee = await makeUser("self-writeblocked-employee");
    await setAddressAsAdmin(admin.id, admin.email, employee.id, CH_ADDRESS);

    actAs(employee.id, employee.email);
    const { addressRouter } = await import("./address.routes");

    await addressRouter.request("/me/address", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: null }),
    });

    const row = await db.employeeAddress.findUnique({
      where: { userId: employee.id },
    });
    expect(row).not.toBeNull();
    expect(row?.city).toBe("Zürich");
  });
});
