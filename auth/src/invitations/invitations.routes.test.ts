/**
 * Integration tests for the invitation admin API (T6, specs/006-user-
 * invitations — AC-1.1–1.14, AC-3.1–3.6, AC-4.1–4.4; plan.md's test table).
 *
 * Strategy mirrors `admin/departments.routes.test.ts`: `../auth/auth.config`
 * is `mock.module`d so we can flip between "no session" / "non-admin" /
 * "admin" without a real OAuth flow, and `../lib/notify` is `mock.module`d
 * per this task's instructions ("In tests, MOCK the notify client") so no
 * real notify-api call is ever made — every other write (the router's
 * middleware chain, `withAudit`, every Prisma read/write) runs for real
 * against the local Postgres (shared dev DB on localhost:5435).
 *
 * Because Bun's `mock.module` replaces a module for the whole test PROCESS
 * (not just this file — see `auth/auth.middleware.test.ts`'s doc comment),
 * this file dynamically `import()`s `./invitations.routes` INSIDE each test
 * (after the mocks are already registered at module load), exactly like
 * `departments.routes.test.ts` does. Run this file in isolation (`bun test
 * src/invitations/invitations.routes.test.ts`) if running it alongside
 * other files that need the REAL `auth.config` or `lib/notify`.
 *
 * DB-ISOLATION: every fixture row is suffixed with a per-run random id and
 * removed in `afterAll`; the shared "admin" `Role` row is `upsert`ed, never
 * deleted (same convention as every other admin-router test file).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;
const SEVENTY_TWO_HOURS = 72 * HOUR;

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

// ─── Mock the notify client ─────────────────────────────────────────────────

type NotifyResult =
  | { status: "sent"; deliveryId: string }
  | { status: "failed"; error: string };

let nextNotifyResult: NotifyResult = { status: "sent", deliveryId: "del_test" };
const sendInvitationEmailMock = mock(async () => nextNotifyResult);

mock.module("../lib/notify", () => ({
  sendInvitationEmail: sendInvitationEmailMock,
}));

function mockEmailSent() {
  nextNotifyResult = { status: "sent", deliveryId: `del_${crypto.randomUUID().slice(0, 8)}` };
}

function mockEmailFailed(error = "simulated Resend outage") {
  nextNotifyResult = { status: "failed", error };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();
const createdInvitationIds = new Set<string>();

let adminActorId: string;
let adminActorEmail: string;
let nonAdminUserId: string;

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

async function makeUser(label: string, extra: { deletedAt?: Date } = {}) {
  const user = await db.user.create({
    data: {
      name: `T6 fixture — ${label}`,
      email: `t6-inv-${label}-${RUN_ID}@operai.test`,
      emailVerified: true,
      ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string) {
  const role = await db.role.create({ data: { name: `t6-role-${label}-${RUN_ID}` } });
  createdRoleIds.add(role.id);
  return role;
}

async function makeDepartment(label: string) {
  const department = await db.department.create({
    data: { name: `t6-dept-${label}-${RUN_ID}` },
  });
  createdDepartmentIds.add(department.id);
  return department;
}

function trackInvitation(id: string) {
  createdInvitationIds.add(id);
  return id;
}

async function makeInvitationRow(
  email: string,
  overrides: Partial<{
    status: string;
    expiresAt: Date;
    roleIds: string[];
    departmentIds: string[];
    invitedByUserId: string;
    tokenHash: string;
  }> = {},
) {
  const row = await db.invitation.create({
    data: {
      email,
      status: overrides.status ?? "pending",
      roleIds: overrides.roleIds ?? [],
      departmentIds: overrides.departmentIds ?? [],
      tokenHash: overrides.tokenHash ?? `seed-hash-${crypto.randomUUID()}`,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + SEVENTY_TWO_HOURS),
      invitedByUserId: overrides.invitedByUserId ?? adminActorId,
    },
  });
  trackInvitation(row.id);
  return row;
}

function asAdmin() {
  currentSession = {
    user: { id: adminActorId, email: adminActorEmail, name: "Admin" },
    session: { id: "sess_admin" },
  };
}

function asNonAdmin() {
  currentSession = {
    user: { id: nonAdminUserId, email: "nonadmin-t6@operai.test", name: "Non-Admin" },
    session: { id: "sess_nonadmin" },
  };
}

function noSession() {
  currentSession = null;
}

beforeAll(async () => {
  const adminRoleId = await ensureAdminRole();

  const actor = await makeUser("actor");
  adminActorId = actor.id;
  adminActorEmail = actor.email;
  await db.userRole.create({ data: { userId: adminActorId, roleId: adminRoleId } });

  const nonAdmin = await makeUser("nonadmin");
  nonAdminUserId = nonAdmin.id;

  mockEmailSent();
});

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { targetType: "invitation", targetId: { in: Array.from(createdInvitationIds) } },
  });
  await db.invitation.deleteMany({ where: { id: { in: Array.from(createdInvitationIds) } } });
  await db.userRole.deleteMany({ where: { userId: { in: Array.from(createdUserIds) } } });
  await db.department.deleteMany({ where: { id: { in: Array.from(createdDepartmentIds) } } });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Invitation admin API (T6)", () => {
  test("401s with no session", async () => {
    noSession();
    const { invitationsRouter } = await import("./invitations.routes");

    const res = await invitationsRouter.request("/admin/invitations");
    expect(res.status).toBe(401);
  });

  test("403s (RFC 7807) for an authenticated non-admin — no row, no email sent (AC-1.8)", async () => {
    asNonAdmin();
    sendInvitationEmailMock.mockClear();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-1-8-${RUN_ID}@operai.test`;
    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(403);

    const row = await db.invitation.findFirst({ where: { email } });
    expect(row).toBeNull();
    expect(sendInvitationEmailMock).not.toHaveBeenCalled();
  });

  test("POST creates a pending invitation with no roles/departments (AC-1.1, AC-1.2, AC-1.7) and sends the email", async () => {
    asAdmin();
    mockEmailSent();
    sendInvitationEmailMock.mockClear();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-1-1-bare-${RUN_ID}@operai.test`;
    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      email: string;
      status: string;
      roles: unknown[];
      departments: unknown[];
      invitedBy: { id: string } | null;
      emailDelivery: string;
    };
    trackInvitation(body.id);

    expect(body.email).toBe(email);
    expect(body.status).toBe("pending");
    expect(body.roles).toEqual([]);
    expect(body.departments).toEqual([]);
    expect(body.invitedBy?.id).toBe(adminActorId);
    expect(body.emailDelivery).toBe("sent");
    expect(sendInvitationEmailMock).toHaveBeenCalledTimes(1);

    const row = await db.invitation.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.invitedByUserId).toBe(adminActorId);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.roleIds).toEqual([]);
    expect(row.departmentIds).toEqual([]);

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "invitation", targetId: body.id, action: "invitation.create" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(adminActorId);
  });

  test("POST with roleIds/departmentIds stores the assignment snapshot on the row — nothing applied to any user yet (AC-1.1)", async () => {
    asAdmin();
    mockEmailSent();
    const { invitationsRouter } = await import("./invitations.routes");

    const role = await makeRole("with-role");
    const department = await makeDepartment("with-dept");
    const email = `t6-1-1-full-${RUN_ID}@operai.test`;

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, roleIds: [role.id], departmentIds: [department.id] }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      roles: { id: string; name: string }[];
      departments: { id: string; name: string }[];
    };
    trackInvitation(body.id);

    expect(body.roles.map((r) => r.id)).toEqual([role.id]);
    expect(body.departments.map((d) => d.id)).toEqual([department.id]);

    // Nothing was applied to any user — this is invite-create, not accept.
    const roleHolders = await db.userRole.findMany({ where: { roleId: role.id } });
    expect(roleHolders).toEqual([]);
  });

  test("POST 422s on an unknown roleId/departmentId", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `t6-422-${RUN_ID}@operai.test`,
        roleIds: ["does-not-exist"],
      }),
    });

    expect(res.status).toBe(422);
  });

  test("POST 409s when an ACTIVE user already owns the email (AC-1.3) — no row, no email", async () => {
    asAdmin();
    sendInvitationEmailMock.mockClear();
    const { invitationsRouter } = await import("./invitations.routes");

    const existingUser = await makeUser("active-owner");

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: existingUser.email }),
    });

    expect(res.status).toBe(409);
    const row = await db.invitation.findFirst({ where: { email: existingUser.email.toLowerCase() } });
    expect(row).toBeNull();
    expect(sendInvitationEmailMock).not.toHaveBeenCalled();
  });

  test("POST creates pending even for a SOFT-DELETED user's email — not blocked (AC-1.14)", async () => {
    asAdmin();
    mockEmailSent();
    const { invitationsRouter } = await import("./invitations.routes");

    const deletedUser = await makeUser("soft-deleted", { deletedAt: new Date() });

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: deletedUser.email }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    trackInvitation(body.id);
    expect(body.status).toBe("pending");
  });

  test("POST 409s when a LIVE PENDING invitation already exists for the email, detail points at it (AC-1.4)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-1-4-${RUN_ID}@operai.test`;
    const existing = await makeInvitationRow(email);

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain(existing.id);
  });

  test("(security-review fix #7, specs/006-user-invitations, A04) two concurrent creates for the SAME email race past the pre-check — exactly one 201, the other 409 (never 500)", async () => {
    asAdmin();
    mockEmailSent();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-race-${RUN_ID}@operai.test`;

    const [resA, resB] = await Promise.all([
      invitationsRouter.request("/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      invitationsRouter.request("/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Never a 500 — the partial-unique-index loser must surface as 409.
    expect(statuses).toEqual([201, 409]);

    const winner = resA.status === 201 ? resA : resB;
    const winnerBody = (await winner.json()) as { id: string };
    trackInvitation(winnerBody.id);

    const rows = await db.invitation.findMany({ where: { email } });
    expect(rows.length).toBe(1);
  });

  test("POST creates pending for an email whose only prior invites are dead — reconcile-on-write flips the stale row (AC-1.5/AC-1.14)", async () => {
    asAdmin();
    mockEmailSent();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-1-5-${RUN_ID}@operai.test`;
    const stale = await makeInvitationRow(email, {
      status: "pending",
      expiresAt: new Date(Date.now() - HOUR), // already past window, never reconciled
    });

    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    trackInvitation(body.id);
    expect(body.status).toBe("pending");

    const reconciledStale = await db.invitation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(reconciledStale.status).toBe("expired");
  });

  test("email-send failure still returns 201 and records lastEmailStatus='failed' (cross-cutting, plan.md 'Failure handling')", async () => {
    asAdmin();
    mockEmailFailed("Resend is down");
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-email-fail-${RUN_ID}@operai.test`;
    const res = await invitationsRouter.request("/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; emailDelivery: string };
    trackInvitation(body.id);
    expect(body.emailDelivery).toBe("failed");

    const row = await db.invitation.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.lastEmailStatus).toBe("failed");
    expect(row.lastEmailError).toBe("Resend is down");
    // The invitation itself is NOT rolled back by a failed send.
    expect(row.status).toBe("pending");

    mockEmailSent();
  });

  test("GET lists invitations with effective status + assigned roles/departments (AC-1.6)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const role = await makeRole("list");
    const email = `t6-1-6-${RUN_ID}@operai.test`;
    const row = await makeInvitationRow(email, { roleIds: [role.id] });

    const res = await invitationsRouter.request(`/admin/invitations?q=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; status: string; roles: { id: string }[] }[];
      total: number;
    };

    const found = body.items.find((i) => i.id === row.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");
    expect(found?.roles.map((r) => r.id)).toEqual([role.id]);
  });

  test("GET renders a past-window pending row as effective 'expired' (AC-4.2)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-4-2-${RUN_ID}@operai.test`;
    const row = await makeInvitationRow(email, { expiresAt: new Date(Date.now() - HOUR) });

    const res = await invitationsRouter.request(`/admin/invitations?status=expired&q=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; status: string }[] };
    const found = body.items.find((i) => i.id === row.id);
    expect(found?.status).toBe("expired");
  });

  test("POST .../resend rotates the token, resets ~72h expiry, preserves id/roleIds/departmentIds (AC-3.1)", async () => {
    asAdmin();
    mockEmailSent();
    sendInvitationEmailMock.mockClear();
    const { invitationsRouter } = await import("./invitations.routes");

    const role = await makeRole("resend");
    const email = `t6-3-1-${RUN_ID}@operai.test`;
    const original = await makeInvitationRow(email, {
      roleIds: [role.id],
      expiresAt: new Date(Date.now() - HOUR), // effectively expired
      tokenHash: "original-hash-3-1",
    });

    const res = await invitationsRouter.request(`/admin/invitations/${original.id}/resend`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      roles: { id: string }[];
      emailDelivery: string;
    };
    expect(body.id).toBe(original.id);
    expect(body.status).toBe("pending");
    expect(body.roles.map((r) => r.id)).toEqual([role.id]);
    expect(body.emailDelivery).toBe("sent");
    expect(sendInvitationEmailMock).toHaveBeenCalledTimes(1);

    const updated = await db.invitation.findUniqueOrThrow({ where: { id: original.id } });
    expect(updated.tokenHash).not.toBe("original-hash-3-1");
    expect(updated.expiresAt.getTime()).toBeGreaterThan(Date.now() + SEVENTY_TWO_HOURS - HOUR);

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "invitation", targetId: original.id, action: "invitation.resend" },
    });
    expect(auditRow).not.toBeNull();
  });

  test("POST .../resend succeeds on an already-expired invitation (AC-4.4 — no action required to make it eligible)", async () => {
    asAdmin();
    mockEmailSent();
    const { invitationsRouter } = await import("./invitations.routes");

    const email = `t6-4-4-resend-${RUN_ID}@operai.test`;
    const expired = await makeInvitationRow(email, { expiresAt: new Date(Date.now() - HOUR) });

    const res = await invitationsRouter.request(`/admin/invitations/${expired.id}/resend`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("POST .../resend 422s on an accepted or revoked invitation (AC-3.4)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const accepted = await makeInvitationRow(`t6-3-4-accepted-${RUN_ID}@operai.test`, {
      status: "accepted",
    });
    const revoked = await makeInvitationRow(`t6-3-4-revoked-${RUN_ID}@operai.test`, {
      status: "revoked",
    });

    const resAccepted = await invitationsRouter.request(`/admin/invitations/${accepted.id}/resend`, {
      method: "POST",
    });
    expect(resAccepted.status).toBe(422);

    const resRevoked = await invitationsRouter.request(`/admin/invitations/${revoked.id}/resend`, {
      method: "POST",
    });
    expect(resRevoked.status).toBe(422);
  });

  test("POST .../resend 403s for a non-admin", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");
    const row = await makeInvitationRow(`t6-3-6-${RUN_ID}@operai.test`);

    asNonAdmin();
    const res = await invitationsRouter.request(`/admin/invitations/${row.id}/resend`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("POST .../revoke sets terminal status, writes audit_log (AC-1.9, AC-1.12)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const row = await makeInvitationRow(`t6-1-9-${RUN_ID}@operai.test`);

    const res = await invitationsRouter.request(`/admin/invitations/${row.id}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("revoked");

    const updated = await db.invitation.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("revoked");

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "invitation", targetId: row.id, action: "invitation.revoke" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(adminActorId);
  });

  test("POST .../revoke succeeds on an expired invitation (AC-4.4)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");
    const expired = await makeInvitationRow(`t6-4-4-revoke-${RUN_ID}@operai.test`, {
      expiresAt: new Date(Date.now() - HOUR),
    });

    const res = await invitationsRouter.request(`/admin/invitations/${expired.id}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("POST .../revoke 422s on an accepted invitation (AC-1.11) and a revoked one (AC-1.10)", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const accepted = await makeInvitationRow(`t6-1-11-${RUN_ID}@operai.test`, { status: "accepted" });
    const res1 = await invitationsRouter.request(`/admin/invitations/${accepted.id}/revoke`, {
      method: "POST",
    });
    expect(res1.status).toBe(422);

    const revoked = await makeInvitationRow(`t6-1-10-${RUN_ID}@operai.test`, { status: "revoked" });
    const res2 = await invitationsRouter.request(`/admin/invitations/${revoked.id}/revoke`, {
      method: "POST",
    });
    expect(res2.status).toBe(422);
  });

  test("POST .../revoke 403s for a non-admin (AC-1.13)", async () => {
    asAdmin();
    const row = await makeInvitationRow(`t6-1-13-${RUN_ID}@operai.test`);
    const { invitationsRouter } = await import("./invitations.routes");

    asNonAdmin();
    const res = await invitationsRouter.request(`/admin/invitations/${row.id}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("404s for an unknown invitation id on resend/revoke", async () => {
    asAdmin();
    const { invitationsRouter } = await import("./invitations.routes");

    const resendRes = await invitationsRouter.request("/admin/invitations/does-not-exist/resend", {
      method: "POST",
    });
    expect(resendRes.status).toBe(404);

    const revokeRes = await invitationsRouter.request("/admin/invitations/does-not-exist/revoke", {
      method: "POST",
    });
    expect(revokeRes.status).toBe(404);
  });
});
