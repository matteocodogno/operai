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
 */
import { db } from "../src/lib/db";
import { generateInvitationToken } from "../src/invitations/token";

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
