/**
 * QE/e2e-only fixture helper (specs/006-user-invitations, T14).
 *
 * The invite-link raw token is NEVER retrievable through any production
 * surface once an invitation exists (plan.md: only `tokenHash` — a SHA-256
 * digest — is persisted; the admin API's `InvitationDetail` response never
 * echoes it back, by design, so a leaked admin-API response can't leak a
 * usable link). That is correct product behaviour, but it means a real
 * browser e2e test cannot drive `GET /invite?id&token=` (AC-2.2/AC-2.5) or
 * prove "resend invalidates the OLD link" (AC-3.3) without SOME way to know
 * a raw token in advance.
 *
 * This script plugs that gap the same way the codebase's own integration
 * tests do (`auth.config.test.ts`'s T8 describe blocks): it uses Prisma
 * directly against the local dev DB (via `direnv exec .`, same as `bun test`)
 * to insert an Invitation row with a token this script itself generated (the
 * exact `generateInvitationToken()`/`hashInvitationToken()` helpers the real
 * create-invitation route uses — auth/src/invitations/token.ts), so the raw
 * token is known to the caller (Playwright) while the DB only ever stores its
 * hash, exactly like production. It also grants a role directly (bypassing
 * the UI) so a Playwright-seeded @operai.test session can act as an admin —
 * there is no test-only "make me admin" endpoint, and there should not be
 * one in production code.
 *
 * NOT wired into any app's runtime — invoked only by `bun run` from the CLI,
 * by the e2e harness. Refuses to run with NODE_ENV=production as a floor,
 * same posture as `ENABLE_TEST_AUTH`.
 *
 * Usage:
 *   bun run scripts/e2e-invite-fixtures.ts grant-role <email> <roleName>
 *   bun run scripts/e2e-invite-fixtures.ts seed-invitation <email> [roleName ...]
 *   bun run scripts/e2e-invite-fixtures.ts cleanup <emailOrPrefix>
 *   bun run scripts/e2e-invite-fixtures.ts grant-refund-employee <email>
 *   bun run scripts/e2e-invite-fixtures.ts grant-refund-accounting <email> <entity|global>
 *   bun run scripts/e2e-invite-fixtures.ts grant-estimai-access <email>
 *
 * The two `grant-refund-*` commands (specs/007-refund-service, T21 QE
 * verification) plug the SAME kind of gap `grant-role` plugs above: refund
 * permissions are deliberately admin-assigned, not automatic for the
 * `employee` role (spec.md Constraints — "holding `employee` does not by
 * itself grant refund access"), and there is no test-only "make me an
 * accounting user with entity X" endpoint (nor should there be, for the same
 * reason `grant-role` above has none). Both commands create/reuse REAL Role +
 * PermissionRule rows via Prisma — the same tables `auth/src/authz/seed.ts`'s
 * `seedAccountingRoleGrants` and the admin API's role editor write to — so
 * refund-api's live `GET /authz/resolve` call resolves these test users
 * through the exact same code path a real admin-granted user would.
 *
 * `grant-estimai-access` (specs/013-estimate-sharing, T25 QE e2e) plugs the
 * identical gap for EstimAI's own `(estimai, access)` grant: the baseline
 * `employee` role assigned on sign-up (`assignBaselineRolesToNewUser`)
 * carries NO `estimai:access` PermissionRule (verified against
 * `auth/src/authz/seed.ts` — nothing grants it by default), yet T2's `POST
 * /authz/app-access-check` (ADR-0035) gates BOTH the calling owner (caller
 * gate: must hold `(appId,"access")` themselves) and the target collaborator
 * (eligibility: must hold it too) on exactly this grant. Without a way to
 * seed it, the T25 collaboration journey could never reach a real 201 — it
 * would 503 (owner ineligible to even ask) or floor-422 (target ineligible)
 * on every attempt. Mirrors `grantRefundEmployee`'s shape exactly: one
 * idempotent dedicated role, one PermissionRule, one assignment, one epoch
 * bump.
 * through the exact same code path a real admin-granted user would.
 */
import { db } from "../src/lib/db";
import { generateInvitationToken } from "../src/invitations/token";
import { ACCOUNTING_ROLE_NAME } from "../src/authz/seed";

async function grantRole(email: string, roleName: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `grant-role: no user row for ${email} — seed a session for this email first (POST /test-auth/session)`,
    );
  }
  const role = await db.role.findFirst({ where: { name: roleName } });
  if (!role) {
    throw new Error(`grant-role: role "${roleName}" does not exist`);
  }
  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });
  // Bump permissionEpoch so a live-resolved session picks the grant up
  // immediately (ADR-0007 — mirrors what the real admin role-grant route does).
  await db.user.update({
    where: { id: user.id },
    data: { permissionEpoch: { increment: 1 } },
  });
  console.log(JSON.stringify({ ok: true, userId: user.id, roleId: role.id }));
}

async function seedInvitation(email: string, roleNames: string[]): Promise<void> {
  const roleIds: string[] = [];
  for (const name of roleNames) {
    const role = await db.role.findFirst({ where: { name } });
    if (!role) throw new Error(`seed-invitation: role "${name}" does not exist`);
    roleIds.push(role.id);
  }

  const { raw, hash } = await generateInvitationToken();
  const invitation = await db.invitation.create({
    data: {
      email: email.toLowerCase(),
      status: "pending",
      roleIds,
      departmentIds: [],
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 72),
    },
  });
  console.log(JSON.stringify({ id: invitation.id, token: raw }));
}

/** e2e-only custom role carrying exactly the refund employee grants (specs/007). */
const E2E_REFUND_EMPLOYEE_ROLE_NAME = "e2e-refund-employee";

async function bumpEpoch(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { permissionEpoch: { increment: 1 } },
  });
}

async function assignRole(userId: string, roleId: string): Promise<void> {
  await db.userRole.upsert({
    where: { userId_roleId: { userId, roleId } },
    update: {},
    create: { userId, roleId },
  });
}

/**
 * Grants the (already test-auth-seeded) user at `email` the refund
 * employee permission set — `refund:access`, `request:create`,
 * `request:read` (ownership:own) — via a dedicated, idempotently-created
 * `e2e-refund-employee` role (spec.md Constraints: these are NEVER on the
 * built-in `employee` role by default; an admin grants them per-user or
 * per-role, which this role stands in for).
 */
async function grantRefundEmployee(email: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `grant-refund-employee: no user row for ${email} — seed a session for this email first (POST /test-auth/session)`,
    );
  }

  const role = await db.role.upsert({
    where: { name: E2E_REFUND_EMPLOYEE_ROLE_NAME },
    update: {},
    create: { name: E2E_REFUND_EMPLOYEE_ROLE_NAME, isSystem: false },
  });

  const rules: { resource: string; action: string; conditions: object | null }[] = [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ];
  for (const rule of rules) {
    const existing = await db.permissionRule.findFirst({
      where: { roleId: role.id, resource: rule.resource, action: rule.action },
    });
    if (existing) {
      await db.permissionRule.update({
        where: { id: existing.id },
        data: { conditions: rule.conditions ?? undefined },
      });
    } else {
      await db.permissionRule.create({
        data: { roleId: role.id, resource: rule.resource, action: rule.action, conditions: rule.conditions ?? undefined },
      });
    }
  }

  await assignRole(user.id, role.id);
  await bumpEpoch(user.id);
  console.log(JSON.stringify({ ok: true, userId: user.id, roleId: role.id }));
}

/**
 * Grants the (already test-auth-seeded) user at `email` the real,
 * admin-seeded `accounting` role (auth/src/authz/seed.ts
 * `seedAccountingRoleGrants` — entity-conditioned review/approve/reject/
 * set-approved-total) AND sets `user.entity` to `entity` (`welld_it` |
 * `welld_ch`) so ADR-0015's entity-scope predicate has a real attribute to
 * match against. `entity === "global"` instead sets `user.entity` to null
 * AND additionally grants an UNCONDITIONED `request:review`/`approve`/
 * `reject`/`set-approved-total` set via a second `e2e-refund-global` role
 * (plan.md's documented "widest-wins union" composition for a global
 * reviewer — no `accounting-global` role is ever seeded, an admin composes
 * it by adding an unconditioned grant on top).
 */
async function grantRefundAccounting(email: string, entity: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `grant-refund-accounting: no user row for ${email} — seed a session for this email first (POST /test-auth/session)`,
    );
  }

  const accountingRole = await db.role.findFirst({ where: { name: ACCOUNTING_ROLE_NAME } });
  if (!accountingRole) {
    throw new Error(
      `grant-refund-accounting: role "${ACCOUNTING_ROLE_NAME}" does not exist — has the seed run (bun run db:release)?`,
    );
  }
  await assignRole(user.id, accountingRole.id);

  if (entity === "global") {
    const globalRole = await db.role.upsert({
      where: { name: "e2e-refund-global" },
      update: {},
      create: { name: "e2e-refund-global", isSystem: false },
    });
    const actions = ["review", "set-approved-total", "approve", "reject"];
    for (const action of actions) {
      const existing = await db.permissionRule.findFirst({
        where: { roleId: globalRole.id, resource: "request", action },
      });
      if (!existing) {
        await db.permissionRule.create({
          data: { roleId: globalRole.id, resource: "request", action, conditions: undefined },
        });
      }
    }
    await assignRole(user.id, globalRole.id);
    await db.user.update({ where: { id: user.id }, data: { entity: null } });
  } else {
    await db.user.update({ where: { id: user.id }, data: { entity } });
  }

  await bumpEpoch(user.id);
  console.log(JSON.stringify({ ok: true, userId: user.id, roleId: accountingRole.id, entity }));
}

/** e2e-only custom role carrying exactly the EstimAI app-access grant (specs/013). */
const E2E_ESTIMAI_ACCESS_ROLE_NAME = "e2e-estimai-access";

/**
 * Grants the (already test-auth-seeded) user at `email` `(estimai, access)`
 * — via a dedicated, idempotently-created `e2e-estimai-access` role, the
 * same shape {@link grantRefundEmployee} uses. Needed by BOTH sides of a
 * specs/013 collaborator-add call: the owner (caller gate on `auth POST
 * /authz/app-access-check`) and the target collaborator (the eligibility
 * check itself).
 */
async function grantEstimaiAccess(email: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `grant-estimai-access: no user row for ${email} — seed a session for this email first (POST /test-auth/session)`,
    );
  }

  const role = await db.role.upsert({
    where: { name: E2E_ESTIMAI_ACCESS_ROLE_NAME },
    update: {},
    create: { name: E2E_ESTIMAI_ACCESS_ROLE_NAME, isSystem: false },
  });

  const existing = await db.permissionRule.findFirst({
    where: { roleId: role.id, resource: "estimai", action: "access" },
  });
  if (!existing) {
    await db.permissionRule.create({
      data: { roleId: role.id, resource: "estimai", action: "access", conditions: undefined },
    });
  }

  await assignRole(user.id, role.id);
  await bumpEpoch(user.id);
  console.log(JSON.stringify({ ok: true, userId: user.id, roleId: role.id }));
}

async function cleanup(emailOrPrefix: string): Promise<void> {
  const users = await db.user.findMany({
    where: { email: { contains: emailOrPrefix } },
    select: { id: true, email: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.userDepartment.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.account.deleteMany({ where: { userId: { in: userIds } } });
  }
  await db.invitation.deleteMany({ where: { email: { contains: emailOrPrefix } } });
  if (userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  console.log(JSON.stringify({ ok: true, deletedUsers: userIds.length }));
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("refusing to run in production");
    process.exit(1);
  }
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === "grant-role") {
      await grantRole(args[0]!, args[1]!);
    } else if (cmd === "seed-invitation") {
      await seedInvitation(args[0]!, args.slice(1));
    } else if (cmd === "cleanup") {
      await cleanup(args[0]!);
    } else if (cmd === "grant-refund-employee") {
      await grantRefundEmployee(args[0]!);
    } else if (cmd === "grant-refund-accounting") {
      await grantRefundAccounting(args[0]!, args[1]!);
    } else if (cmd === "grant-estimai-access") {
      await grantEstimaiAccess(args[0]!);
    } else {
      console.error("unknown command:", cmd);
      process.exit(1);
    }
  } catch (err) {
    console.error("ERROR", err);
    process.exit(1);
  }
  process.exit(0);
}

main();
