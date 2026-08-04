/**
 * AC-5.2 regression tripwire (T6, specs/012-employee-address; ADR-0033
 * "Tier 2 — application-level immutability only" for `auth`'s `audit_log`).
 *
 * `audit_log` carries NO database-level immutability (no trigger, no rule,
 * no revoked grants — verified by grep across every existing migration,
 * plan.md "Audit mechanism"). AC-5.2, as amended 2026-08-04, requires
 * APPLICATION-level immutability only, proven by three independently
 * checkable clauses:
 *
 *   (a) Module surface  — `../authz/audit.ts` exports NO update/delete
 *       function: `Object.keys(await import("./audit")).sort()` is exactly
 *       `["listAuditLog","withAudit"]`.
 *   (b) Production source — a static scan of `auth/src/**\/*.ts` finds ZERO
 *       matches for a mutating `auditLog.*` call or a raw
 *       UPDATE/DELETE/TRUNCATE against `audit_log`. This is a TRIPWIRE, not
 *       a proof (a dynamic `db[model].delete(...)` would evade a static
 *       regex) — it catches the failure mode actually worth defending
 *       against: someone adding a mutating call to a route/service module.
 *       Excludes `**\/*.test.ts`, `src/test-setup.ts`, and
 *       `src/lib/generated/**` (the Prisma client, which necessarily
 *       *defines* those delegate methods). Test/fixture teardown
 *       (`db.auditLog.deleteMany` in the six existing test/fixture files) is
 *       EXPRESSLY OUT OF SCOPE of this assertion — those callers are exempt
 *       BY CONSTRUCTION via the exclusion, not individually allow-listed, so
 *       this test's pass/fail is never coupled to those files' contents.
 *       `scripts/**` and `prisma/generated/**` fall outside the `src/**`
 *       scan root entirely — the scan root itself is asserted explicitly
 *       (below) so a future widening cannot silently pull in
 *       `scripts/e2e-invite-fixtures.ts` (which hard-deletes users and,
 *       incidentally, is completely outside this scan already).
 *   (c) API surface — authenticated AS AN ADMIN (so a 404 proves
 *       route-absence rather than being masked by `requireAdmin`'s 403),
 *       every mutating verb on `/admin/audit` and `/admin/audit/{id}`
 *       returns `404`, while `GET /admin/audit` returns `200` in the SAME
 *       test — proving the 404s are method-specific, not a broken path.
 *
 * Do NOT build `auth/src/lib/db.audit-log-immutability.test.ts` — that
 * DB-level test belonged to the rejected Option A (plan.md "Mapping
 * completeness check": "removed and must not be built").
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);

// ─── (a) Module surface ────────────────────────────────────────────────────

describe("AC-5.2(a) — the audit module exposes no update/delete path", () => {
  test('Object.keys(await import("./audit")).sort() is exactly ["listAuditLog","withAudit"]', async () => {
    const auditModule = await import("./audit");
    expect(Object.keys(auditModule).sort()).toEqual([
      "listAuditLog",
      "withAudit",
    ]);
  });
});

// ─── (b) Production source — static scan ───────────────────────────────────

describe("AC-5.2(b) — no production code path mutates audit_log (tripwire)", () => {
  // The scan root, asserted explicitly (plan.md/T6): `auth/src`, NOT the repo
  // root or `auth/` itself — `scripts/**` and `prisma/generated/**` must fall
  // outside it so a future widening of this test cannot silently start
  // flagging (or silently start EXEMPTING via a broader exclude) files this
  // assertion was never meant to cover.
  const SRC_ROOT = resolve(import.meta.dir, "..");

  test("the scan root is exactly auth/src", () => {
    expect(SRC_ROOT.endsWith(`${sep}auth${sep}src`)).toBe(true);
  });

  function collectTsFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  function relativeToSrcRoot(absolutePath: string): string {
    return absolutePath.slice(SRC_ROOT.length + 1).split(sep).join("/");
  }

  function isExcluded(relPath: string): boolean {
    if (relPath.endsWith(".test.ts")) return true;
    if (relPath === "test-setup.ts") return true;
    if (relPath.startsWith("lib/generated/")) return true;
    return false;
  }

  // `\bauditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b`
  const MUTATING_DELEGATE_CALL =
    /\bauditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;
  // `(UPDATE|DELETE|TRUNCATE)\s+(FROM\s+)?["']?audit_log`
  const RAW_SQL_MUTATION = /(UPDATE|DELETE|TRUNCATE)\s+(FROM\s+)?["']?audit_log/i;

  test("zero matches for a mutating auditLog.* delegate call or raw SQL against audit_log", () => {
    const allFiles = collectTsFiles(SRC_ROOT);
    const scanned = allFiles
      .map((absolutePath) => ({
        absolutePath,
        relPath: relativeToSrcRoot(absolutePath),
      }))
      .filter(({ relPath }) => !isExcluded(relPath));

    // Sanity check: the exclusions above must not have accidentally excluded
    // everything (a vacuously-true scan would be worthless).
    expect(scanned.length).toBeGreaterThan(0);
    // And this file's own source and the sibling audit.ts/audit.routes.ts
    // MUST be part of what was scanned — proving the walk actually reaches
    // the directory this feature touches. (Deliberately NOT asserting
    // admin/userAddress.routes.ts here — T6 has no task dependency on T3 and
    // must pass standalone regardless of task execution order.)
    const scannedRelPaths = new Set(scanned.map((f) => f.relPath));
    expect(scannedRelPaths.has("authz/audit.ts")).toBe(true);
    expect(scannedRelPaths.has("authz/audit.routes.ts")).toBe(true);

    const violations: string[] = [];
    for (const { absolutePath, relPath } of scanned) {
      const content = readFileSync(absolutePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (MUTATING_DELEGATE_CALL.test(line) || RAW_SQL_MUTATION.test(line)) {
          violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the six existing test/fixture deleteMany teardown callers are exempt by construction (excluded, not individually allow-listed)", () => {
    // These files DO call db.auditLog.deleteMany(...) as ordinary teardown
    // (plan.md "Audit mechanism" — the finding that led to the AC-5.2
    // amendment). This test asserts they are excluded by the *.test.ts /
    // test-setup.ts / lib/generated/** rule, not individually special-cased —
    // so this contract test never needs editing when teardown code changes.
    const knownTeardownFiles = [
      "authz/audit.test.ts",
      "auth/auth.config.test.ts",
      "invitations/invitations.routes.test.ts",
      "admin/users.routes.test.ts",
    ];
    for (const relPath of knownTeardownFiles) {
      expect(isExcluded(relPath)).toBe(true);
    }
    // scripts/e2e-invite-fixtures.ts is outside the src/** root entirely —
    // never reached by collectTsFiles(SRC_ROOT) in the first place.
  });
});

// ─── (c) API surface — no mutating verb ────────────────────────────────────

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

describe("AC-5.2(c) — no mutating verb on the audit API surface (admin-authenticated)", () => {
  let adminUserId: string;
  const seededAuditId = `t6-contract-seed-${RUN_ID}`;

  test("POST/PUT/PATCH/DELETE on /admin/audit and /admin/audit/{id} each 404, while GET 200s — same test", async () => {
    const adminRoleId = await ensureAdminRole();
    const admin = await db.user.create({
      data: {
        email: `t6-contract-admin-${RUN_ID}@operai.test`,
        name: "T6 Contract Fixture Admin",
        emailVerified: true,
      },
    });
    adminUserId = admin.id;
    await db.userRole.create({ data: { userId: adminUserId, roleId: adminRoleId } });

    const seededRow = await db.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: "role.create",
        targetType: "role",
        targetId: seededAuditId,
        summary: `t6-contract-${RUN_ID}`,
      },
    });

    currentSession = {
      user: { id: adminUserId, email: admin.email, name: admin.name },
      session: { id: `sess_${RUN_ID}` },
    };

    try {
      const { auditRouter } = await import("./audit.routes");

      const getRes = await auditRouter.request("/admin/audit");
      expect(getRes.status).toBe(200);

      const postRes = await auditRouter.request("/admin/audit", {
        method: "POST",
      });
      expect(postRes.status).toBe(404);

      const putRes = await auditRouter.request("/admin/audit", {
        method: "PUT",
      });
      expect(putRes.status).toBe(404);

      const patchRes = await auditRouter.request("/admin/audit", {
        method: "PATCH",
      });
      expect(patchRes.status).toBe(404);

      const deleteRes = await auditRouter.request("/admin/audit", {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(404);

      // The same four verbs against /admin/audit/{id} — a plausible
      // "delete this one row" shape that also must not exist.
      const postByIdRes = await auditRouter.request(
        `/admin/audit/${seededRow.id}`,
        { method: "POST" },
      );
      expect(postByIdRes.status).toBe(404);

      const putByIdRes = await auditRouter.request(
        `/admin/audit/${seededRow.id}`,
        { method: "PUT" },
      );
      expect(putByIdRes.status).toBe(404);

      const patchByIdRes = await auditRouter.request(
        `/admin/audit/${seededRow.id}`,
        { method: "PATCH" },
      );
      expect(patchByIdRes.status).toBe(404);

      const deleteByIdRes = await auditRouter.request(
        `/admin/audit/${seededRow.id}`,
        { method: "DELETE" },
      );
      expect(deleteByIdRes.status).toBe(404);
    } finally {
      await db.auditLog.deleteMany({ where: { id: seededRow.id } });
    }
  });

  afterAll(async () => {
    if (adminUserId) {
      await db.userRole.deleteMany({ where: { userId: adminUserId } });
      await db.user.deleteMany({ where: { id: adminUserId } });
    }
  });
});
