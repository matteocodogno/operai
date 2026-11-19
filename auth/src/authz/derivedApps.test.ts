/**
 * Unit tests for the derived-apps table (specs/20261119-accounting — T2; refs AC-8.1, AC-3.2; ADR
 * 20261117-an-app-is-reachable-through-a-capability-it-administers-… amendment of 2026-11-19) and for the
 * shared coverage vectors (`entity-coverage-vectors.json`, plan R12) that accounting-api and refund-api read too.
 * Pure: no DB, no network. The route-level behaviour (`GET /authz/me` `apps`) is in `authz.routes.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { adminAreaReachable, coveredEntities, entitiesCoveredByAny } from "../legalEntities/coverage";
import { DERIVED_APPS, derivedAppIds, withDerivedApps } from "./derivedApps";
import { type EffectivePermission, entityGrantFor } from "./resolver";

// ─── The shared vectors ──────────────────────────────────────────────────────────────

interface VectorCase {
  readonly name: string;
  readonly permissions: readonly EffectivePermission[];
  readonly user: { readonly entity: string | null };
  readonly covered: { readonly read: readonly string[]; readonly manage: readonly string[] };
  readonly appReachable: boolean;
}

interface Vectors {
  readonly entities: readonly string[];
  readonly cases: readonly VectorCase[];
}

const vectors = (await Bun.file(new URL("./entity-coverage-vectors.json", import.meta.url)).json()) as Vectors;

const ACCOUNTING_READ = { resource: "accounting", action: "read" } as const;
const ACCOUNTING_MANAGE = { resource: "accounting", action: "manage" } as const;
const sorted = (values: readonly string[]) => [...values].sort();

describe("entity-coverage-vectors.json is well formed", () => {
  test("lists the two entities and enough cases to cover the rule", () => {
    expect(sorted(vectors.entities)).toEqual(["welld_ch", "welld_it"]);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30);
  });

  test("case names are unique, so a failure names one case", () => {
    const names = vectors.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every case is self-consistent: entities known, manage inside read, appReachable iff read is not empty", () => {
    for (const c of vectors.cases) {
      for (const entity of [...c.covered.read, ...c.covered.manage]) expect(vectors.entities).toContain(entity);
      for (const entity of c.covered.manage) expect(c.covered.read, c.name).toContain(entity);
      expect(c.appReachable, c.name).toBe(c.covered.read.length > 0);
    }
  });

  test("it carries the four kinds the plan names: unconditioned, entity, entity with a null user entity, unknown condition", () => {
    const has = (predicate: (c: VectorCase) => boolean) => vectors.cases.some(predicate);
    expect(has((c) => c.permissions.some((p) => p.conditions === null) && c.covered.read.length === 2)).toBe(true);
    expect(has((c) => c.permissions.some((p) => p.conditions !== null) && c.covered.read.length === 1)).toBe(true);
    expect(has((c) => c.user.entity === null && c.permissions.some((p) => p.conditions !== null) && !c.appReachable)).toBe(
      true,
    );
    expect(has((c) => c.permissions.some((p) => p.conditions?.ownership !== undefined) && !c.appReachable)).toBe(true);
  });
});

describe("auth's derivation agrees with the shared vectors (plan R12)", () => {
  for (const c of vectors.cases) {
    test(c.name, () => {
      const read = entitiesCoveredByAny(c.permissions, c.user, [ACCOUNTING_READ, ACCOUNTING_MANAGE]);
      const manage = entitiesCoveredByAny(c.permissions, c.user, [ACCOUNTING_MANAGE]);
      expect(sorted(read)).toEqual(sorted(c.covered.read));
      expect(sorted(manage)).toEqual(sorted(c.covered.manage));
      expect(derivedAppIds(c.permissions, c.user).includes("accounting")).toBe(c.appReachable);
    });
  }

  test("the same cases, with the permissions renamed to legal-entity:manage, drive the admin row identically", () => {
    for (const c of vectors.cases) {
      const asLegalEntity = c.permissions
        .filter((p) => p.resource === "accounting" && p.action === "manage")
        .map((p) => ({ ...p, resource: "legal-entity" }));
      const expected = c.covered.manage.length > 0;
      expect(derivedAppIds(asLegalEntity, c.user).includes("admin"), c.name).toBe(expected);
      expect(adminAreaReachable(asLegalEntity, c.user), c.name).toBe(expected);
    }
  });
});

// ─── The table ───────────────────────────────────────────────────────────────────────

const grant = (resource: string, action: string, conditions: EffectivePermission["conditions"] = null) =>
  ({ resource, action, conditions }) satisfies EffectivePermission;
const ENTITY = { attributes: [{ key: "entity", match: "user" }] } as const;

describe("DERIVED_APPS", () => {
  test("has exactly the two rows, admin then accounting, each through its capability", () => {
    expect(DERIVED_APPS.map((row) => row.appId)).toEqual(["admin", "accounting"]);
    expect(DERIVED_APPS[0]?.grants).toEqual([{ resource: "legal-entity", action: "manage" }]);
    expect(DERIVED_APPS[1]?.grants).toEqual([
      { resource: "accounting", action: "read" },
      { resource: "accounting", action: "manage" },
    ]);
  });

  test("no row is derived from an `access` grant: accounting has none, and admin:access is not what derives admin", () => {
    for (const row of DERIVED_APPS) for (const g of row.grants) expect(g.action).not.toBe("access");
    expect(derivedAppIds([grant("admin", "access"), grant("accounting", "access")], { entity: "welld_ch" })).toEqual([]);
  });
});

describe("derivedAppIds", () => {
  const user = { entity: "welld_ch" };

  test("read only, manage only and both each derive accounting (AC-8.1)", () => {
    expect(derivedAppIds([grant("accounting", "read", ENTITY)], user)).toEqual(["accounting"]);
    expect(derivedAppIds([grant("accounting", "manage", ENTITY)], user)).toEqual(["accounting"]);
    expect(derivedAppIds([grant("accounting", "read", ENTITY), grant("accounting", "manage", ENTITY)], user)).toEqual([
      "accounting",
    ]);
  });

  test("no grant, a null user entity with an entity grant, and an unknown condition derive nothing", () => {
    expect(derivedAppIds([], user)).toEqual([]);
    expect(derivedAppIds([grant("accounting", "read", ENTITY)], { entity: null })).toEqual([]);
    expect(derivedAppIds([grant("accounting", "manage", { ownership: "own" })], user)).toEqual([]);
    expect(derivedAppIds([grant("accounting", "read", { attributes: [{ key: "entity", match: "any" }] })], user)).toEqual(
      [],
    );
  });

  test("an unconditioned grant derives accounting for a person with no entity", () => {
    expect(derivedAppIds([grant("accounting", "read")], { entity: null })).toEqual(["accounting"]);
  });

  test("both rows apply together, in table order, whatever the order of the permissions", () => {
    const permissions = [grant("accounting", "read", ENTITY), grant("legal-entity", "manage", ENTITY)];
    expect(derivedAppIds(permissions, user)).toEqual(["admin", "accounting"]);
    expect(derivedAppIds([...permissions].reverse(), user)).toEqual(["admin", "accounting"]);
  });

  test("the two rows are independent: one capability never derives the other app", () => {
    expect(derivedAppIds([grant("legal-entity", "manage")], user)).toEqual(["admin"]);
    expect(derivedAppIds([grant("accounting", "manage")], user)).toEqual(["accounting"]);
  });
});

describe("withDerivedApps", () => {
  const user = { entity: "welld_ch" };
  const permissions = [grant("accounting", "read", ENTITY), grant("legal-entity", "manage", ENTITY)];

  test("appends the derived ids after the access apps, in table order, and leaves the input alone", () => {
    const apps = ["estimai", "refund"];
    expect(withDerivedApps(apps, permissions, user)).toEqual(["estimai", "refund", "admin", "accounting"]);
    expect(apps).toEqual(["estimai", "refund"]);
  });

  test("never duplicates an id already present, and never reorders what was there", () => {
    expect(withDerivedApps(["accounting", "estimai", "admin"], permissions, user)).toEqual([
      "accounting",
      "estimai",
      "admin",
    ]);
  });

  test("returns the access apps unchanged when nothing is derived", () => {
    expect(withDerivedApps(["estimai"], [], user)).toEqual(["estimai"]);
    expect(withDerivedApps([], [], user)).toEqual([]);
  });
});

describe("coverage.ts keeps its existing answers through the shared function", () => {
  test("coveredEntities for legal-entity:manage is entitiesCoveredByAny over that one grant, in registry order", () => {
    const perms = [grant("legal-entity", "manage")];
    expect(coveredEntities(perms, { entity: null })).toEqual(["welld_it", "welld_ch"]);
    expect(entitiesCoveredByAny(perms, { entity: null }, [{ resource: "legal-entity", action: "manage" }])).toEqual([
      "welld_it",
      "welld_ch",
    ]);
  });

  test("entitiesCoveredByAny agrees with entityGrantFor entity by entity, and is empty for no grants", () => {
    const perms = [grant("accounting", "read", ENTITY)];
    const user = { entity: "welld_it" };
    for (const entity of ["welld_it", "welld_ch"]) {
      const viaTable = entitiesCoveredByAny(perms, user, [ACCOUNTING_READ]).includes(entity as "welld_it");
      expect(viaTable).toBe(entityGrantFor(perms, "accounting", "read", user, entity) !== null);
    }
    expect(entitiesCoveredByAny(perms, user, [])).toEqual([]);
  });
});
