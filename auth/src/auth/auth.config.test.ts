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
