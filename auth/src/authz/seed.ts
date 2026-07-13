/**
 * Bootstrap seed for the authorization domain (T11, specs/004-auth-roles-permissions
 * — refs AC-6.1, AC-6.2, AC-6.3; plan.md "Bootstrap & seed"; ADR-0007).
 *
 * Two independent, idempotent responsibilities, both safe to re-run any
 * number of times (at every deploy, and from tests):
 *
 *   1. {@link seedSystemRoles} — upsert the four system roles `employee`,
 *      `admin`, `accounting`, `hr` (`isSystem: true`, AC-6.2). `isSystem`
 *      roles are never deletable by admins (T8's guard) but remain
 *      editable — an admin may still attach rules to them.
 *   2. {@link seedAppAccessCatalog} — register the suite-wide "can see this
 *      app" catalog via `upsertAppCatalog` (T5): one resource per suite app
 *      (`estimai`, `refund`, `admin`), keyed by the app id itself (per
 *      `catalog.ts`'s convention for the app-access resource), each with a
 *      single `access` action. This lets an admin grant/deny app visibility
 *      (US-7) from day one, independent of any app's own domain-resource
 *      catalog. EstimAI's `estimate` resource (view/create/edit/delete) is
 *      deliberately NOT seeded here — T26 is EstimAI's own job to declare
 *      and register its full catalog (including its own `access` entry,
 *      which supersedes this placeholder for `estimai` via the same
 *      full-replace-per-appId upsert — see `catalog.ts`'s doc comment).
 *
 * A THIRD, per-user concern — assigning the baseline `employee` role (and
 * `admin` for the configured bootstrap email) to every newly created user —
 * is NOT part of this deploy-time seed: it happens once per user, in
 * `auth.config.ts`'s `databaseHooks.user.create.after` hook, via
 * {@link assignBaselineRolesToNewUser} below (also exported from here so the
 * hook stays a thin wire-up and the logic itself is unit-testable directly).
 */

import { ADMIN_ROLE_NAME } from "../admin/lastAdminGuard";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { upsertAppCatalog } from "./catalog";

export const EMPLOYEE_ROLE_NAME = "employee";

/** The four seed system roles (AC-6.2). Order is insignificant; upserts run sequentially for deterministic logging. */
export const SYSTEM_ROLE_NAMES = [
  EMPLOYEE_ROLE_NAME,
  ADMIN_ROLE_NAME,
  "accounting",
  "hr",
] as const;

/** Suite apps that get a baseline app-access catalog resource (US-7). */
const SUITE_APPS: { appId: string; label: string }[] = [
  { appId: "estimai", label: "EstimAI" },
  { appId: "refund", label: "Rimborsi" },
  { appId: "admin", label: "Admin" },
];

/**
 * Upserts the four system roles (AC-6.2). Idempotent: re-running never
 * creates duplicates (unique on `Role.name`) and never flips `isSystem`
 * back to `false` for a role an admin might have inspected in between.
 */
export async function seedSystemRoles(): Promise<void> {
  for (const name of SYSTEM_ROLE_NAMES) {
    await db.role.upsert({
      where: { name },
      update: { isSystem: true },
      create: { name, isSystem: true },
    });
  }
}

/**
 * Registers the app-access catalog for every suite app (US-7). Idempotent:
 * `upsertAppCatalog` is itself a full-replace upsert keyed by `appId`, so
 * re-running with the same `SUITE_APPS` list is a no-op on the resulting
 * state.
 */
export async function seedAppAccessCatalog(): Promise<void> {
  for (const app of SUITE_APPS) {
    await upsertAppCatalog({
      appId: app.appId,
      resources: [
        {
          key: app.appId,
          label: app.label,
          actions: [{ key: "access", label: "Access", supportedConditions: [] }],
        },
      ],
    });
  }
}

/** Runs both deploy-time seed steps. */
export async function seed(): Promise<void> {
  await seedSystemRoles();
  await seedAppAccessCatalog();
}

// ─── Per-user baseline role assignment (AC-6.1, AC-6.3) ─────────────────────

/** The minimal shape this needs from a better-auth `User`. */
export interface NewUserForBootstrap {
  id: string;
  email: string;
  emailVerified?: boolean;
}

/**
 * Assigns baseline roles to a newly created user. Called from
 * `auth.config.ts`'s `databaseHooks.user.create.after` — i.e. once per
 * sign-up, for every provider (Google, GitHub, and the dev-only test-auth
 * mint path), never from anything a client directly triggers.
 *
 *   - Every new user gets `employee` (AC-6.3).
 *   - A user whose email matches the configured `BOOTSTRAP_ADMIN_EMAIL`
 *     ALSO gets `admin` (AC-6.1). The comparison is against `user.email` as
 *     recorded by better-auth from the OAuth provider's verified profile —
 *     never anything a request body/header could influence — and is
 *     additionally gated on `emailVerified` being `true` so a hypothetical
 *     future unverified-email signup path can never self-claim the
 *     bootstrap identity by matching the address alone.
 *
 * Role rows are upserted defensively here (not just assumed present from
 * {@link seedSystemRoles}) so this hook is safe even if it fires before the
 * deploy-time seed has ever run (e.g. a fresh test DB). Assignment itself
 * uses `userRole.upsert` on the `(userId, roleId)` composite key, so calling
 * this twice for the same user (it never should, but hooks firing more than
 * once is a cheaper failure mode than a duplicate-key crash) stays a no-op.
 */
export async function assignBaselineRolesToNewUser(
  user: NewUserForBootstrap,
): Promise<void> {
  const employeeRole = await db.role.upsert({
    where: { name: EMPLOYEE_ROLE_NAME },
    update: {},
    create: { name: EMPLOYEE_ROLE_NAME, isSystem: true },
  });
  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: employeeRole.id } },
    update: {},
    create: { userId: user.id, roleId: employeeRole.id },
  });

  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const isBootstrapAdmin =
    bootstrapEmail !== undefined &&
    user.emailVerified !== false &&
    user.email.toLowerCase() === bootstrapEmail.toLowerCase();

  if (isBootstrapAdmin) {
    const adminRole = await db.role.upsert({
      where: { name: ADMIN_ROLE_NAME },
      update: {},
      create: { name: ADMIN_ROLE_NAME, isSystem: true },
    });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    });
  }
}

// ─── Standalone entrypoint (`bun run db:seed`) ───────────────────────────────
// Lets the deploy-time seed run as its own process (e.g. a Railway
// preDeployCommand step, alongside the existing `bun run db:deploy`), in
// addition to being imported directly by tests.
if (import.meta.main) {
  seed()
    .then(() => {
      console.log("Seeded system roles + suite app-access catalog");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
