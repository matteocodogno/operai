/**
 * Tests for the effective-permissions resolver (spec 004, T2 — AC-4.2, AC-4.4).
 *
 * Two layers:
 *  - `dedupeWidest`/`toRuleConditions` (pure, no DB): exhaustive adversarial
 *    coverage of the union/dedup/widest-wins/precedence logic, fast and
 *    deterministic.
 *  - `resolveEffectivePermissions`/`bumpPermissionEpoch` (DB-backed): verifies
 *    the actual Prisma join wiring (direct `user_role` vs department-derived
 *    `user_department` → `department_role`) against the shared local
 *    Postgres (localhost:5435).
 *
 * DB-ISOLATION: other spec-004 tasks may run `bun test` concurrently against
 * the SAME database. Every fixture row uses a random suffix (never a fixed
 * name) so concurrent runs cannot collide on the `role.name`/`department.name`
 * /`user.email` unique constraints, and every id created by a test is tracked
 * and deleted in `afterAll` — regardless of which test created it — so a
 * failure mid-file still cleans up.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  bumpPermissionEpoch,
  dedupeWidest,
  resolveEffectivePermissions,
  toRuleConditions,
  type EffectivePermission,
} from "./resolver";

// ─── DB fixture helpers ───────────────────────────────────────────────────

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID();
}

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T2 fixture — ${label}`,
      email: `t2-resolver-${label}-${unique()}@resolver.test`,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string) {
  const role = await db.role.create({
    data: { name: `t2-resolver-role-${label}-${unique()}` },
  });
  createdRoleIds.add(role.id);
  return role;
}

async function makeDepartment(label: string) {
  const department = await db.department.create({
    data: { name: `t2-resolver-dept-${label}-${unique()}` },
  });
  createdDepartmentIds.add(department.id);
  return department;
}

async function addRule(
  roleId: string,
  resource: string,
  action: string,
  conditions?: Record<string, unknown>,
) {
  // Omitting `conditions` entirely (rather than passing `null`) leaves the
  // nullable JSON column NULL — see resolver.ts's `toRuleConditions` doc
  // comment for why `null` is the "fully unconditional" sentinel. Two
  // explicit branches (rather than a conditional spread) keep the Prisma
  // input type happy under `exactOptionalPropertyTypes`.
  if (conditions === undefined) {
    await db.permissionRule.create({ data: { roleId, resource, action } });
    return;
  }

  await db.permissionRule.create({
    data: { roleId, resource, action, conditions: conditions as Prisma.InputJsonValue },
  });
}

async function assignUserRole(userId: string, roleId: string) {
  await db.userRole.create({ data: { userId, roleId } });
}

async function assignDepartmentRole(departmentId: string, roleId: string) {
  await db.departmentRole.create({ data: { departmentId, roleId } });
}

async function addUserToDepartment(userId: string, departmentId: string) {
  await db.userDepartment.create({ data: { userId, departmentId } });
}

afterAll(async () => {
  // Deleting Role/Department cascades permission_rule/user_role/
  // department_role/user_department rows tied to them (schema.prisma
  // `onDelete: Cascade` on both sides of the join tables); deleting User
  // cascades any remaining user_role/user_department/audit_log rows. Order
  // is irrelevant since each deletion cascades independently.
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.department.deleteMany({
    where: { id: { in: Array.from(createdDepartmentIds) } },
  });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Pure logic: dedupeWidest + toRuleConditions ──────────────────────────

function perm(
  resource: string,
  action: string,
  conditions: EffectivePermission["conditions"],
): EffectivePermission {
  return { resource, action, conditions };
}

describe("toRuleConditions (pure)", () => {
  test("null and undefined both parse to null", () => {
    expect(toRuleConditions(null)).toBeNull();
    expect(toRuleConditions(undefined)).toBeNull();
  });

  test("an empty object parses to null (no recognized restriction)", () => {
    expect(toRuleConditions({})).toBeNull();
  });

  test("an object with only unrecognized keys parses to null", () => {
    expect(toRuleConditions({ foo: "bar" })).toBeNull();
  });

  test("a non-object (string/number/array) parses to null", () => {
    expect(toRuleConditions("own")).toBeNull();
    expect(toRuleConditions(42)).toBeNull();
    expect(toRuleConditions([1, 2, 3])).toBeNull();
  });

  test("an invalid ownership value is dropped, not trusted verbatim", () => {
    expect(toRuleConditions({ ownership: "everyone" })).toBeNull();
  });

  test("a valid ownership is preserved", () => {
    expect(toRuleConditions({ ownership: "own" })).toEqual({ ownership: "own" });
    expect(toRuleConditions({ ownership: "any" })).toEqual({ ownership: "any" });
  });

  test("attributes are preserved and coerced to strings", () => {
    expect(
      toRuleConditions({
        ownership: "own",
        attributes: [{ key: "entity", match: "user" }],
      }),
    ).toEqual({
      ownership: "own",
      attributes: [{ key: "entity", match: "user" }],
    });
  });

  test("non-object entries inside attributes are filtered out", () => {
    expect(
      toRuleConditions({
        ownership: "own",
        attributes: ["not-an-object", { key: "entity", match: "user" }],
      }),
    ).toEqual({
      ownership: "own",
      attributes: [{ key: "entity", match: "user" }],
    });
  });
});

describe("dedupeWidest (pure) — union, dedup, widest-wins precedence", () => {
  test("distinct (resource,action) pairs all pass through untouched", () => {
    const input = [perm("estimate", "view", null), perm("estimate", "edit", null)];
    expect(dedupeWidest(input)).toEqual(input);
  });

  test("resource and action are both part of the identity — same resource, different action, do not collapse", () => {
    const input = [
      perm("estimate", "view", { ownership: "own" }),
      perm("estimate", "delete", { ownership: "any" }),
    ];
    expect(dedupeWidest(input)).toHaveLength(2);
  });

  test("null conditions (fully unconditional) beats an explicit ownership condition", () => {
    const input = [perm("estimate", "view", { ownership: "own" }), perm("estimate", "view", null)];
    expect(dedupeWidest(input)).toEqual([perm("estimate", "view", null)]);
  });

  test("null wins regardless of which order the grants are supplied in", () => {
    const input = [perm("estimate", "view", null), perm("estimate", "view", { ownership: "any" })];
    expect(dedupeWidest(input)).toEqual([perm("estimate", "view", null)]);
  });

  test("ownership:any beats ownership:own (ADR-0007 / plan.md: ownership:any ⊃ own)", () => {
    const input = [
      perm("estimate", "view", { ownership: "own" }),
      perm("estimate", "view", { ownership: "any" }),
    ];
    expect(dedupeWidest(input)).toEqual([perm("estimate", "view", { ownership: "any" })]);
  });

  test("fewer attribute constraints win as a tie-break within the same ownership tier", () => {
    const input = [
      perm("estimate", "view", {
        ownership: "own",
        attributes: [
          { key: "entity", match: "user" },
          { key: "jobTitle", match: "user" },
        ],
      }),
      perm("estimate", "view", {
        ownership: "own",
        attributes: [{ key: "entity", match: "user" }],
      }),
    ];
    expect(dedupeWidest(input)).toEqual([
      perm("estimate", "view", {
        ownership: "own",
        attributes: [{ key: "entity", match: "user" }],
      }),
    ]);
  });

  test("ownership tier dominates attribute count — any+more-attrs still beats own+fewer-attrs", () => {
    const input = [
      perm("estimate", "view", { ownership: "own", attributes: [] }),
      perm("estimate", "view", {
        ownership: "any",
        attributes: [
          { key: "entity", match: "user" },
          { key: "jobTitle", match: "user" },
        ],
      }),
    ];
    expect(dedupeWidest(input)).toEqual([
      perm("estimate", "view", {
        ownership: "any",
        attributes: [
          { key: "entity", match: "user" },
          { key: "jobTitle", match: "user" },
        ],
      }),
    ]);
  });

  test("three overlapping grants on the same pair collapse to the single widest", () => {
    const input = [
      perm("estimate", "delete", {
        ownership: "own",
        attributes: [{ key: "entity", match: "user" }],
      }),
      perm("estimate", "delete", { ownership: "own" }),
      perm("estimate", "delete", { ownership: "any" }),
    ];
    expect(dedupeWidest(input)).toEqual([perm("estimate", "delete", { ownership: "any" })]);
  });

  test("identical duplicate rules collapse to exactly one entry", () => {
    const input = [
      perm("estimate", "view", { ownership: "own" }),
      perm("estimate", "view", { ownership: "own" }),
    ];
    const result = dedupeWidest(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(perm("estimate", "view", { ownership: "own" }));
  });

  test("empty input yields empty output — the vacuous case of default-deny", () => {
    expect(dedupeWidest([])).toEqual([]);
  });

  // specs/010-self-approval-control, ADR-0026, plan.md Risk R1 — the
  // self-approval attribute lives on the SAME `attributes[]` axis as
  // `entity`, so it is subject to the identical widest-wins composition
  // rules as every other attribute condition. These tests document (rather
  // than newly derive) that property so it is a tested, known behavior — not
  // a silently-discovered bypass.
  test(
    "(R1) a second role granting UNCONDITIONED approve unions away a self-approval-" +
      "restricted grant on the same (resource,action) — the restriction stops biting",
    () => {
      const input = [
        perm("request", "approve", {
          attributes: [{ key: "self-approval", match: "deny" }],
        }),
        perm("request", "approve", null),
      ];
      expect(dedupeWidest(input)).toEqual([perm("request", "approve", null)]);
    },
  );

  test(
    "(R1) order-independence: the unconditioned approve grant wins regardless of which " +
      "grant is supplied first",
    () => {
      const input = [
        perm("request", "approve", null),
        perm("request", "approve", {
          attributes: [{ key: "self-approval", match: "deny" }],
        }),
      ];
      expect(dedupeWidest(input)).toEqual([perm("request", "approve", null)]);
    },
  );

  test(
    "(R1) narrow tie: a self-approval-only grant and an entity-only grant score EQUALLY " +
      "under widthScore (both ownershipTier 1, 1 attribute) — dedupeWidest cannot correctly " +
      "join these two orthogonal-axis grants and keeps whichever was seen first, per plan.md's " +
      "documented (not escalated) limitation",
    () => {
      const selfApprovalOnly = perm("request", "approve", {
        attributes: [{ key: "self-approval", match: "deny" }],
      });
      const entityOnly = perm("request", "approve", {
        attributes: [{ key: "entity", match: "user" }],
      });

      // Self-approval-only supplied first → it "wins" the tie (first-seen),
      // even though this drops the entity scope a second role also granted.
      expect(dedupeWidest([selfApprovalOnly, entityOnly])).toEqual([selfApprovalOnly]);
      // Entity-only supplied first → IT wins instead, silently dropping the
      // self-approval restriction. Neither outcome is a correct multi-axis
      // join — this is the documented R1 gap, not a bug to fix here.
      expect(dedupeWidest([entityOnly, selfApprovalOnly])).toEqual([entityOnly]);
    },
  );

  test(
    "(R1) a self-approval-restricted grant composed with a WIDER (any-ownership) grant on " +
      "an unrelated attribute still loses to the unconditioned grant, consistent with entity's " +
      "existing composition behavior",
    () => {
      const input = [
        perm("request", "approve", {
          attributes: [
            { key: "entity", match: "user" },
            { key: "self-approval", match: "deny" },
          ],
        }),
        perm("request", "approve", null),
      ];
      expect(dedupeWidest(input)).toEqual([perm("request", "approve", null)]);
    },
  );
});

// ─── DB-backed: resolveEffectivePermissions ───────────────────────────────

describe("resolveEffectivePermissions (DB-backed)", () => {
  test("direct-only: a user's directly-assigned role's rules are resolved", async () => {
    const user = await makeUser("direct-only");
    const role = await makeRole("direct-only");
    await addRule(role.id, "estimate", "view", { ownership: "own" });
    await assignUserRole(user.id, role.id);

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toEqual([perm("estimate", "view", { ownership: "own" })]);
  });

  test("department-only: rules conferred via department membership (no direct role) are resolved", async () => {
    const user = await makeUser("dept-only");
    const role = await makeRole("dept-only");
    const department = await makeDepartment("dept-only");
    await addRule(role.id, "estimate", "edit", { ownership: "any" });
    await assignDepartmentRole(department.id, role.id);
    await addUserToDepartment(user.id, department.id);

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toEqual([perm("estimate", "edit", { ownership: "any" })]);
  });

  test("union: direct + department rules on DIFFERENT pairs are both present, none lost", async () => {
    const user = await makeUser("union");
    const directRole = await makeRole("union-direct");
    const deptRole = await makeRole("union-dept");
    const department = await makeDepartment("union");

    await addRule(directRole.id, "estimate", "view", { ownership: "own" });
    await addRule(deptRole.id, "estimate", "delete", { ownership: "any" });

    await assignUserRole(user.id, directRole.id);
    await assignDepartmentRole(department.id, deptRole.id);
    await addUserToDepartment(user.id, department.id);

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(perm("estimate", "view", { ownership: "own" }));
    expect(result).toContainEqual(perm("estimate", "delete", { ownership: "any" }));
  });

  test("dedup/widest-wins: the SAME pair granted by both direct and department paths collapses to one entry using the widest condition", async () => {
    const user = await makeUser("widest-wins");
    const directRole = await makeRole("widest-wins-direct");
    const deptRole = await makeRole("widest-wins-dept");
    const department = await makeDepartment("widest-wins");

    // Direct role narrowly grants "own"; the department-derived role grants
    // the same (resource,action) unrestricted ("any"). The union must expose
    // the wider grant exactly once — not two entries, and not the narrower one.
    await addRule(directRole.id, "estimate", "edit", { ownership: "own" });
    await addRule(deptRole.id, "estimate", "edit", { ownership: "any" });

    await assignUserRole(user.id, directRole.id);
    await assignDepartmentRole(department.id, deptRole.id);
    await addUserToDepartment(user.id, department.id);

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(perm("estimate", "edit", { ownership: "any" }));
  });

  test("default-deny: a (resource,action) pair with no grant on either path is absent, not present-and-denied", async () => {
    const user = await makeUser("default-deny");
    const role = await makeRole("default-deny");
    await addRule(role.id, "estimate", "view"); // fully unconditional grant, no conditions
    await assignUserRole(user.id, role.id);

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toEqual([perm("estimate", "view", null)]);
    expect(
      result.find((p) => p.resource === "estimate" && p.action === "delete"),
    ).toBeUndefined();
    expect(result.find((p) => p.resource === "unrelated-resource")).toBeUndefined();
  });

  test("a user with no roles at all (direct or department) resolves to an empty list", async () => {
    const user = await makeUser("no-grants");

    const result = await Effect.runPromise(resolveEffectivePermissions(user.id));

    expect(result).toEqual([]);
  });
});

// ─── DB-backed: bumpPermissionEpoch ────────────────────────────────────────

describe("bumpPermissionEpoch (DB-backed)", () => {
  test("increments permissionEpoch only for the targeted users, leaving others untouched", async () => {
    const target = await makeUser("epoch-target");
    const bystander = await makeUser("epoch-bystander");

    const affected = await Effect.runPromise(bumpPermissionEpoch([target.id]));
    expect(affected).toBe(1);

    const [freshTarget, freshBystander] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: target.id } }),
      db.user.findUniqueOrThrow({ where: { id: bystander.id } }),
    ]);

    expect(freshTarget.permissionEpoch).toBe(1);
    expect(freshBystander.permissionEpoch).toBe(0);
  });

  test("bumping twice increments twice (monotonic, not idempotent-set)", async () => {
    const user = await makeUser("epoch-monotonic");

    await Effect.runPromise(bumpPermissionEpoch([user.id]));
    await Effect.runPromise(bumpPermissionEpoch([user.id]));

    const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.permissionEpoch).toBe(2);
  });

  test("duplicate ids in the same call are deduped — one user, one bump", async () => {
    const user = await makeUser("epoch-dedup");

    const affected = await Effect.runPromise(
      bumpPermissionEpoch([user.id, user.id, user.id]),
    );
    expect(affected).toBe(1);

    const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.permissionEpoch).toBe(1);
  });

  test("an empty user-id list is a no-op — no DB round-trip, no error", async () => {
    const affected = await Effect.runPromise(bumpPermissionEpoch([]));
    expect(affected).toBe(0);
  });
});
