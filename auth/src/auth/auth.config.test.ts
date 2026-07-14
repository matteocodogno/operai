/**
 * Unit tests for auth config structural correctness.
 *
 * These tests import the REAL auth config (no mock.module) to assert that
 * the options passed to betterAuth() match security requirements.
 *
 * Most of these do NOT require a live DB — betterAuth() is called at module
 * load and stores options on `auth.options`, but no DB connection is opened
 * until the first actual request. The one exception is the
 * `databaseHooks.user.create.after` group below (T11,
 * specs/004-auth-roles-permissions — AC-6.1/6.3), which DOES touch the real
 * Postgres: it is the one place that proves `auth.config.ts`'s registered
 * hook is actually wired to `authz/seed.ts`'s `assignBaselineRolesToNewUser`
 * (not merely that the function works in isolation — see
 * `authz/seed.test.ts` for that exhaustive direct coverage, including every
 * bootstrap-email edge case). It deliberately lives HERE rather than in
 * `src/authz/` — `src/authz/seed.test.ts`'s doc comment explains why a
 * same-directory attempt at this exact test reliably got a `mock.module`-
 * stubbed `auth.config` (from unrelated sibling test files) in a full
 * repo-wide `bun test` run, while resolving the module via `"./auth.config"`
 * from `src/auth/` (as this file and `jwt-claims.contract.test.ts` do)
 * does not collide with that.
 */

import { afterAll, describe, expect, test } from "bun:test";

describe("auth config — structural assertions (no mock)", () => {
  // DEFECT 1 fix verification:
  // betterAuth must receive trustedOrigins === env.ALLOWED_ORIGINS so that
  // state-mutating calls (sign-out, etc.) from UI origins are NOT rejected
  // with 403 INVALID_ORIGIN.
  //
  // Without this fix, better-auth's internal getTrustedOrigins() trusts only
  // BETTER_AUTH_URL (localhost:3001), rejecting requests from the UI origin
  // (localhost:5173 in dev / Vercel in prod).
  test("(DEFECT 1) trustedOrigins is set to ALLOWED_ORIGINS on the auth options", async () => {
    const { auth: realAuth } = await import("./auth.config");
    const { env } = await import("../lib/env");

    const options = realAuth.options as Record<string, unknown>;
    const trustedOrigins = options.trustedOrigins as string[] | undefined;

    expect(Array.isArray(trustedOrigins)).toBe(true);
    // Every entry in ALLOWED_ORIGINS must be trusted — strictly equal to the list
    // (not broader) so we do not accidentally expand the trusted surface.
    for (const origin of env.ALLOWED_ORIGINS) {
      expect(trustedOrigins).toContain(origin);
    }
    // Length equality confirms we have not added extra trusted origins beyond
    // what ALLOWED_ORIGINS declares.
    expect(trustedOrigins?.length).toBe(env.ALLOWED_ORIGINS.length);
  });

  test("emailAndPassword is not enabled (no password auth path added)", async () => {
    const { auth: realAuth } = await import("./auth.config");
    const options = realAuth.options as Record<string, unknown>;
    const eap = options.emailAndPassword as Record<string, unknown> | undefined;
    expect(eap?.enabled).not.toBe(true);
  });

  test("socialProviders includes google and github", async () => {
    const { auth: realAuth } = await import("./auth.config");
    const options = realAuth.options as Record<string, unknown>;
    const providers = options.socialProviders as Record<string, unknown> | undefined;
    expect(providers).toBeDefined();
    expect(providers?.google).toBeDefined();
    expect(providers?.github).toBeDefined();
  });
});

describe("databaseHooks.user.create.after — bootstrap wiring (T11, AC-6.1/AC-6.3)", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    const { db } = await import("../lib/db");
    if (createdUserIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  test("the registered after-hook is a function", async () => {
    const { auth: realAuth } = await import("./auth.config");
    const options = realAuth.options as {
      databaseHooks?: { user?: { create?: { after?: unknown } } };
    };
    expect(typeof options.databaseHooks?.user?.create?.after).toBe("function");
  });

  test("invoking the registered after-hook for a fresh user actually assigns the baseline `employee` role — proves the hook is wired to authz/seed.ts's assignBaselineRolesToNewUser, not a no-op", async () => {
    const { auth: realAuth } = await import("./auth.config");
    const { db } = await import("../lib/db");

    const options = realAuth.options as unknown as {
      databaseHooks?: {
        user?: {
          create?: {
            after?: (
              user: { id: string; email: string; emailVerified?: boolean },
              context: null,
            ) => Promise<void>;
          };
        };
      };
    };
    const afterHook = options.databaseHooks?.user?.create?.after;
    expect(afterHook).toBeDefined();

    const user = await db.user.create({
      data: {
        email: `t11-hook-wiring-${crypto.randomUUID()}@operai.test`,
        name: "T11 hook-wiring fixture",
        emailVerified: true,
      },
    });
    createdUserIds.push(user.id);

    // Call the REAL, registered hook function exactly as better-auth's
    // createWithHooks would (user, context) — proves the wiring, not a
    // reimplementation of it.
    await afterHook?.(user, null);

    const employeeRole = await db.userRole.findFirst({
      where: { userId: user.id, role: { name: "employee" } },
    });
    expect(employeeRole).not.toBeNull();
  });
});

// ─── T8, specs/006-user-invitations ─────────────────────────────────────────
//
// R1 spike, then the two activation hooks (AC-2.3/2.4, AC-5.2/5.10). See
// `auth.config.ts`'s doc comments on `applyLivePendingInvitationOnUserCreate`
// and `gateOrReactivateSoftDeletedSession` for the full design rationale —
// these tests prove the WIRING + the specific AC behaviours, not re-derive
// the design.

describe("R1 spike — session.create.before abort contract (T8, specs/006-user-invitations)", () => {
  // FINDING (recorded here and in the commit message): against the pinned
  // better-auth version (1.6.23, see bun.lock), a `session.create.before`
  // hook that returns `false` makes `internalAdapter.createSession(userId)`
  // resolve to `null` and persists NO session row — confirmed by reading
  // `node_modules/better-auth/dist/db/with-hooks.mjs`
  // (`if (result === false) return null;`), by the official type doc-comment
  // in `@better-auth/core`'s `init-options.d.mts` ("if the hook returns
  // false, the session will not be created"), by tracing the OAuth callback
  // path (`createSession` returning `null` → `handleOAuthUserInfo` returns
  // `{ error: "unable to create session" }` → `callback.mjs` redirects
  // WITHOUT ever calling `setSessionCookie`), and empirically by this test
  // itself against a real scratch `betterAuth()` instance sharing this
  // file's Postgres. Returning `false` is therefore a genuine, confirmed
  // deny — the documented `session.create.after` + immediate
  // `session.delete` fallback is NOT needed; `gateOrReactivateSoftDeletedSession`
  // is wired via a plain `return false`.
  test("returning false denies session creation; returning undefined allows it", async () => {
    const { betterAuth } = await import("better-auth");
    const { prismaAdapter } = await import("better-auth/adapters/prisma");
    const { db } = await import("../lib/db");

    const user = await db.user.create({
      data: {
        email: `t8-r1-spike-${crypto.randomUUID()}@operai.test`,
        name: "T8 R1 spike fixture",
        emailVerified: true,
      },
    });

    try {
      let hookCalledWith: string | undefined;
      const denyingAuth = betterAuth({
        baseURL: "http://localhost:3001",
        basePath: "/auth",
        database: prismaAdapter(db, { provider: "postgresql" }),
        secret: "test-secret-that-is-at-least-32-characters-long",
        databaseHooks: {
          session: {
            create: {
              before: async (session) => {
                hookCalledWith = session.userId;
                return false;
              },
            },
          },
        },
      });

      const denyingCtx = await denyingAuth.$context;
      const deniedResult = await denyingCtx.internalAdapter.createSession(user.id);

      expect(hookCalledWith).toBe(user.id);
      expect(deniedResult).toBeNull();
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);

      const allowingAuth = betterAuth({
        baseURL: "http://localhost:3001",
        basePath: "/auth",
        database: prismaAdapter(db, { provider: "postgresql" }),
        secret: "test-secret-that-is-at-least-32-characters-long",
        databaseHooks: {
          session: { create: { before: async () => undefined } },
        },
      });
      const allowingCtx = await allowingAuth.$context;
      const allowedResult = await allowingCtx.internalAdapter.createSession(user.id);

      expect(allowedResult).not.toBeNull();
      expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});

describe("user.create.after — invitation activation (T8, AC-2.3, AC-2.4)", () => {
  const RUN_ID = crypto.randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdDepartmentIds: string[] = [];
  const createdInvitationIds: string[] = [];

  afterAll(async () => {
    const { db } = await import("../lib/db");
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.userDepartment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.auditLog.deleteMany({ where: { targetId: { in: createdInvitationIds } } });
    await db.invitation.deleteMany({ where: { id: { in: createdInvitationIds } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await db.department.deleteMany({ where: { id: { in: createdDepartmentIds } } });
  });

  async function getRegisteredAfterHook() {
    const { auth: realAuth } = await import("./auth.config");
    const options = realAuth.options as unknown as {
      databaseHooks?: {
        user?: {
          create?: {
            after?: (
              user: { id: string; email: string; emailVerified?: boolean },
              context: null,
            ) => Promise<void>;
          };
        };
      };
    };
    const afterHook = options.databaseHooks?.user?.create?.after;
    if (!afterHook) throw new Error("user.create.after hook is not registered");
    return afterHook;
  }

  test("AC-2.3 (R9 RESOLVED, security-review fix #5): a live-pending invitation naming a role grants EXACTLY that role/department — the baseline employee role is REPLACED, not kept alongside it — marked accepted, epoch bumped, audited", async () => {
    const { db } = await import("../lib/db");
    const afterHook = await getRegisteredAfterHook();

    const role = await db.role.create({ data: { name: `t8-invite-role-${RUN_ID}` } });
    createdRoleIds.push(role.id);
    const department = await db.department.create({ data: { name: `t8-invite-dept-${RUN_ID}` } });
    createdDepartmentIds.push(department.id);

    const email = `t8-invitee-${RUN_ID}@operai.test`;
    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [role.id],
        departmentIds: [department.id],
        tokenHash: `t8-token-hash-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    const user = await db.user.create({
      data: { email, name: "T8 invitee", emailVerified: true },
    });
    createdUserIds.push(user.id);

    await afterHook(user, null);

    // Fix #5 — a named-role invite is EXACT (AC-2.3 "no more, no fewer"):
    // the baseline employee role assignBaselineRolesToNewUser just granted
    // is REPLACED, never kept alongside the invite's role.
    const employeeRole = await db.userRole.findFirst({
      where: { userId: user.id, role: { name: "employee" } },
    });
    expect(employeeRole).toBeNull();

    const roleRows = await db.userRole.findMany({ where: { userId: user.id } });
    expect(roleRows.map((r) => r.roleId)).toEqual([role.id]);

    const grantedDept = await db.userDepartment.findUnique({
      where: { userId_departmentId: { userId: user.id, departmentId: department.id } },
    });
    expect(grantedDept).not.toBeNull();

    const updatedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updatedInvitation.status).toBe("accepted");
    expect(updatedInvitation.acceptedByUserId).toBe(user.id);

    const updatedUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updatedUser.permissionEpoch).toBeGreaterThan(0);

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "invitation", targetId: invitation.id, action: "invitation.accept" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(user.id);
  });

  test("AC-2.3 (security-review fix #5): an EMPTY invitation (no roleIds) keeps the baseline employee role — the seed-role default", async () => {
    const { db } = await import("../lib/db");
    const afterHook = await getRegisteredAfterHook();

    const email = `t8-invitee-empty-${RUN_ID}@operai.test`;
    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: `t8-token-hash-empty-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    const user = await db.user.create({
      data: { email, name: "T8 empty-invite invitee", emailVerified: true },
    });
    createdUserIds.push(user.id);

    await afterHook(user, null);

    const roleRows = await db.userRole.findMany({
      where: { userId: user.id },
      include: { role: true },
    });
    expect(roleRows.map((r) => r.role.name)).toEqual(["employee"]);

    const updatedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updatedInvitation.status).toBe("accepted");
  });

  test("security-review fix #4: an invitation naming a role that was DELETED before acceptance still completes activation — invitation accepted, skipped id audited, no dangling FK crash", async () => {
    const { db } = await import("../lib/db");
    const afterHook = await getRegisteredAfterHook();

    const survivingRole = await db.role.create({ data: { name: `t8-invite-role-survivor-${RUN_ID}` } });
    createdRoleIds.push(survivingRole.id);

    // A role that existed at invite-create time but is deleted before the
    // invitee ever accepts (simulated by creating then deleting it — the
    // invitation still names its now-dangling id, exactly as if an admin had
    // deleted the role during the 72h window).
    const deletedRole = await db.role.create({ data: { name: `t8-invite-role-todelete-${RUN_ID}` } });
    const deletedRoleId = deletedRole.id;
    await db.role.delete({ where: { id: deletedRoleId } });

    const email = `t8-invitee-deletedrole-${RUN_ID}@operai.test`;
    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [survivingRole.id, deletedRoleId],
        departmentIds: [],
        tokenHash: `t8-token-hash-deletedrole-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    const user = await db.user.create({
      data: { email, name: "T8 deleted-role invitee", emailVerified: true },
    });
    createdUserIds.push(user.id);

    // Must not throw — a dangling FK on the deleted role must never roll
    // back the whole activation transaction.
    await afterHook(user, null);

    const roleRows = await db.userRole.findMany({ where: { userId: user.id } });
    expect(roleRows.map((r) => r.roleId)).toEqual([survivingRole.id]);

    // Fix #4 — the invitation is marked accepted REGARDLESS of the skipped id.
    const updatedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updatedInvitation.status).toBe("accepted");
    expect(updatedInvitation.acceptedByUserId).toBe(user.id);

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "invitation", targetId: invitation.id, action: "invitation.accept" },
    });
    expect(auditRow).not.toBeNull();
    const auditData = auditRow?.data as { skippedRoleIds?: string[] } | null;
    expect(auditData?.skippedRoleIds).toEqual([deletedRoleId]);
  });

  test("AC-2.4: a different verified identity's sign-up does not consume another email's pending invitation (cross-identity isolation)", async () => {
    const { db } = await import("../lib/db");
    const afterHook = await getRegisteredAfterHook();

    const role = await db.role.create({ data: { name: `t8-invite-role-iso-${RUN_ID}` } });
    createdRoleIds.push(role.id);

    const invitedEmail = `t8-invitee-iso-${RUN_ID}@operai.test`;
    const invitation = await db.invitation.create({
      data: {
        email: invitedEmail,
        status: "pending",
        roleIds: [role.id],
        departmentIds: [],
        tokenHash: `t8-token-hash-iso-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    // A DIFFERENT verified identity signs up (e.g. followed the same invite
    // link but authenticated with their own distinct Google/GitHub account).
    const otherUser = await db.user.create({
      data: {
        email: `t8-other-identity-${RUN_ID}@operai.test`,
        name: "T8 other identity",
        emailVerified: true,
      },
    });
    createdUserIds.push(otherUser.id);

    await afterHook(otherUser, null);

    // The other identity gets NOTHING from the invitation.
    const grantedRole = await db.userRole.findUnique({
      where: { userId_roleId: { userId: otherUser.id, roleId: role.id } },
    });
    expect(grantedRole).toBeNull();

    // The original invitation is untouched — still pending, unaccepted.
    const untouchedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(untouchedInvitation.status).toBe("pending");
    expect(untouchedInvitation.acceptedByUserId).toBeNull();
  });

  test("no invitation logic runs when the new user's email is not verified", async () => {
    const { db } = await import("../lib/db");
    const afterHook = await getRegisteredAfterHook();

    const role = await db.role.create({ data: { name: `t8-invite-role-unverified-${RUN_ID}` } });
    createdRoleIds.push(role.id);

    const email = `t8-invitee-unverified-${RUN_ID}@operai.test`;
    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [role.id],
        departmentIds: [],
        tokenHash: `t8-token-hash-unverified-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    const user = await db.user.create({
      data: { email, name: "T8 unverified invitee", emailVerified: false },
    });
    createdUserIds.push(user.id);

    await afterHook(user, null);

    const grantedRole = await db.userRole.findUnique({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
    });
    expect(grantedRole).toBeNull();
    const untouchedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(untouchedInvitation.status).toBe("pending");
  });
});

describe("session.create.before — soft-delete gate + re-activation (T8, AC-5.2, AC-5.10)", () => {
  const RUN_ID = crypto.randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdInvitationIds: string[] = [];

  afterAll(async () => {
    const { db } = await import("../lib/db");
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.auditLog.deleteMany({ where: { targetId: { in: [...createdUserIds, ...createdInvitationIds] } } });
    await db.invitation.deleteMany({ where: { id: { in: createdInvitationIds } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.role.deleteMany({ where: { id: { in: createdRoleIds } } });
  });

  async function getRegisteredBeforeHook() {
    const { auth: realAuth } = await import("./auth.config");
    const options = realAuth.options as unknown as {
      databaseHooks?: {
        session?: {
          create?: {
            before?: (
              session: { userId: string },
              context: null,
            ) => Promise<false | void>;
          };
        };
      };
    };
    const beforeHook = options.databaseHooks?.session?.create?.before;
    if (!beforeHook) throw new Error("session.create.before hook is not registered");
    return beforeHook;
  }

  test("active user (deletedAt null) is always allowed with no invitation side effects", async () => {
    const { db } = await import("../lib/db");
    const beforeHook = await getRegisteredBeforeHook();

    const user = await db.user.create({
      data: {
        email: `t8-active-${RUN_ID}@operai.test`,
        name: "T8 active user",
        emailVerified: true,
      },
    });
    createdUserIds.push(user.id);

    const result = await beforeHook({ userId: user.id }, null);
    expect(result).toBeUndefined();

    const unchanged = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.deletedAt).toBeNull();
  });

  test("AC-5.2: a soft-deleted user with no live-pending invitation is denied — false, not resurrected", async () => {
    const { db } = await import("../lib/db");
    const beforeHook = await getRegisteredBeforeHook();

    const user = await db.user.create({
      data: {
        email: `t8-deleted-noinvite-${RUN_ID}@operai.test`,
        name: "T8 soft-deleted, no invite",
        emailVerified: true,
        deletedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);

    const result = await beforeHook({ userId: user.id }, null);
    expect(result).toBe(false);

    const stillDeleted = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillDeleted.deletedAt).not.toBeNull();
  });

  test("AC-5.10: a soft-deleted user with a live-pending invitation is re-activated — deletedAt cleared, roles REPLACED (not merged) with exactly the invitation's set", async () => {
    const { db } = await import("../lib/db");
    const beforeHook = await getRegisteredBeforeHook();

    const priorRole = await db.role.create({ data: { name: `t8-prior-role-${RUN_ID}` } });
    createdRoleIds.push(priorRole.id);
    const newRole = await db.role.create({ data: { name: `t8-new-role-${RUN_ID}` } });
    createdRoleIds.push(newRole.id);

    const email = `t8-deleted-reinvited-${RUN_ID}@operai.test`;
    const user = await db.user.create({
      data: {
        email,
        name: "T8 soft-deleted, re-invited",
        emailVerified: true,
        deletedAt: new Date(),
        deletedByUserId: null,
      },
    });
    createdUserIds.push(user.id);
    // Prior (pre-deletion) role grant, physically retained per ADR-0012 —
    // re-activation must REPLACE this, not keep it alongside the new grant.
    await db.userRole.create({ data: { userId: user.id, roleId: priorRole.id } });

    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [newRole.id],
        departmentIds: [],
        tokenHash: `t8-token-hash-reinvite-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    const result = await beforeHook({ userId: user.id }, null);
    expect(result).toBeUndefined();

    const reactivated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reactivated.deletedAt).toBeNull();
    expect(reactivated.permissionEpoch).toBeGreaterThan(0);

    const roleRows = await db.userRole.findMany({ where: { userId: user.id } });
    expect(roleRows.map((r) => r.roleId)).toEqual([newRole.id]);
    // The prior role is GONE — a replace, not a resurrection/union (AC-5.10).
    expect(roleRows.some((r) => r.roleId === priorRole.id)).toBe(false);

    const acceptedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(acceptedInvitation.status).toBe("accepted");
    expect(acceptedInvitation.acceptedByUserId).toBe(user.id);

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "user", targetId: user.id, action: "user.reactivate" },
    });
    expect(auditRow).not.toBeNull();
  });

  test("security-review fix #4: re-activation via an invitation naming a role DELETED before acceptance still completes — deletedAt cleared, invitation accepted, skipped id audited, no dangling FK crash", async () => {
    const { db } = await import("../lib/db");
    const beforeHook = await getRegisteredBeforeHook();

    const survivingRole = await db.role.create({ data: { name: `t8-reactivate-survivor-${RUN_ID}` } });
    createdRoleIds.push(survivingRole.id);

    const deletedRole = await db.role.create({ data: { name: `t8-reactivate-todelete-${RUN_ID}` } });
    const deletedRoleId = deletedRole.id;
    await db.role.delete({ where: { id: deletedRoleId } });

    const email = `t8-deleted-reinvited-deletedrole-${RUN_ID}@operai.test`;
    const user = await db.user.create({
      data: {
        email,
        name: "T8 soft-deleted, re-invited with a since-deleted role",
        emailVerified: true,
        deletedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);

    const invitation = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [survivingRole.id, deletedRoleId],
        departmentIds: [],
        tokenHash: `t8-token-hash-reactivate-deletedrole-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    createdInvitationIds.push(invitation.id);

    // Must not throw — a dangling FK on the deleted role must never roll
    // back the whole re-activation transaction (which would leave the user
    // permanently locked out with a live-pending invitation for their email).
    const result = await beforeHook({ userId: user.id }, null);
    expect(result).toBeUndefined();

    const reactivated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reactivated.deletedAt).toBeNull();

    const roleRows = await db.userRole.findMany({ where: { userId: user.id } });
    expect(roleRows.map((r) => r.roleId)).toEqual([survivingRole.id]);

    const acceptedInvitation = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(acceptedInvitation.status).toBe("accepted");

    const auditRow = await db.auditLog.findFirst({
      where: { targetType: "user", targetId: user.id, action: "user.reactivate" },
    });
    expect(auditRow).not.toBeNull();
    const auditData = auditRow?.data as { skippedRoleIds?: string[] } | null;
    expect(auditData?.skippedRoleIds).toEqual([deletedRoleId]);
  });
});
