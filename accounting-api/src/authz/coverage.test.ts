/**
 * coverage.ts (T6, specs/20261119-accounting, AC-3.2, AC-3.4 to AC-3.6, plan R12).
 *
 * The first block runs every case of auth's shared vectors (auth/src/authz/entity-coverage-vectors.json, read-only
 * here, owned by auth T2) through `coveredEntities`; the rest pins what the vectors do not say, and the gate
 * `requireEntityAccess` every route sits behind. Pure: no database, no network, no environment.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ENTITIES } from "../entities";
import { handleProblemError, ProblemError } from "../lib/problem";
import {
  accountingGrant,
  ENTITY_CONDITION,
  PERSONAS,
} from "../test-support/fakeResolve";
import type { AuthzContext } from "./authz.middleware";
import { coverageOf, coveredEntities, requireAnyAccess, requireEntityAccess } from "./coverage";
import type { ResolvedPermission } from "./resolveClient";

// ─── The shared vectors ──────────────────────────────────────────────────────

interface VectorCase {
  readonly name: string;
  readonly permissions: readonly ResolvedPermission[];
  readonly user: { readonly entity: string | null };
  readonly covered: { readonly read: readonly string[]; readonly manage: readonly string[] };
  readonly appReachable: boolean;
}

interface Vectors {
  readonly contract: readonly string[];
  readonly entities: readonly string[];
  readonly cases: readonly VectorCase[];
}

// Repo-relative, from accounting-api/src/authz: the file is auth's and is never copied or edited here.
const VECTORS_URL = new URL("../../../auth/src/authz/entity-coverage-vectors.json", import.meta.url);
const vectors = (await Bun.file(VECTORS_URL).json()) as Vectors;
const sorted = (values: readonly string[]) => [...values].sort();

describe("the shared vectors file", () => {
  it("is the one auth owns, with its contract, the two entities and the whole case list", () => {
    // A vacuous pass (an empty or moved file) would let the two derivations drift unnoticed.
    expect(Array.isArray(vectors.contract) && vectors.contract.length > 0).toBe(true);
    expect(sorted(vectors.entities)).toEqual(sorted(ENTITIES));
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30);
  });

  it("has an unconditioned, an entity, a null-entity and an unknown-condition case", () => {
    const has = (p: (c: VectorCase) => boolean) => vectors.cases.some(p);
    expect(has((c) => c.permissions.some((g) => g.conditions === null) && c.covered.read.length === 2)).toBe(true);
    expect(has((c) => c.permissions.some((g) => g.conditions !== null) && c.covered.read.length === 1)).toBe(true);
    expect(has((c) => c.user.entity === null && c.permissions.some((g) => g.conditions !== null) && c.covered.read.length === 0)).toBe(true);
    expect(has((c) => c.permissions.some((g) => g.conditions?.ownership !== undefined) && c.covered.read.length === 0)).toBe(true);
  });
});

describe("coveredEntities agrees with the shared vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const read = coveredEntities(c.permissions, c.user, "read");
      const manage = coveredEntities(c.permissions, c.user, "manage");
      expect(sorted(read)).toEqual(sorted(c.covered.read));
      expect(sorted(manage)).toEqual(sorted(c.covered.manage));
      // manage includes read (AC-3.2), and the app is reachable exactly when something is readable (AC-8.1).
      for (const entity of manage) expect(read).toContain(entity);
      expect(read.length > 0).toBe(c.appReachable);
    });
  }
});

// ─── What the vectors do not pin ─────────────────────────────────────────────

describe("coveredEntities", () => {
  const ch = { entity: "welld_ch" };

  it("lists entities in ENTITIES order (welld_ch first), whatever the order of the grants", () => {
    const perms = [accountingGrant("manage"), accountingGrant("read")];
    expect(coveredEntities(perms, ch, "read")).toEqual(["welld_ch", "welld_it"]);
    expect(coveredEntities([...perms].reverse(), { entity: null }, "manage")).toEqual(["welld_ch", "welld_it"]);
  });

  it("manage-only covers read, and read alone never covers manage", () => {
    expect(coveredEntities([accountingGrant("manage", ENTITY_CONDITION)], ch, "read")).toEqual(["welld_ch"]);
    expect(coveredEntities([accountingGrant("read")], ch, "manage")).toEqual([]);
  });

  it("an entity grant of a user attributed to welld_it covers welld_it only", () => {
    expect(coveredEntities([accountingGrant("read", ENTITY_CONDITION)], { entity: "welld_it" }, "read")).toEqual([
      "welld_it",
    ]);
  });

  it("fails closed on conditions it does not recognise, however they arrive", () => {
    const odd: unknown[] = [
      { ownership: "own" },
      { ownership: "any" },
      { attributes: [{ key: "department", match: "user" }] },
      { attributes: [{ key: "entity", match: "any" }] },
      { attributes: [{ key: "entity", match: "user" }, { key: "department", match: "user" }] },
      { attributes: "entity" },
      { attributes: [null] },
      { attributes: [{ key: "entity", match: "user" }], department: "x" },
      { department: "x" },
      "unrestricted",
      7,
      [],
      undefined,
    ];
    for (const conditions of odd) {
      const perms = [{ resource: "accounting", action: "read", conditions } as unknown as ResolvedPermission];
      expect(coveredEntities(perms, ch, "read")).toEqual([]);
      expect(coveredEntities(perms, { entity: null }, "read")).toEqual([]);
    }
  });

  it("reads an object with no restriction in it as unrestricted, as auth does", () => {
    for (const conditions of [{}, { attributes: [] }]) {
      expect(coveredEntities([{ resource: "accounting", action: "read", conditions }], ch, "read")).toEqual([
        "welld_ch",
        "welld_it",
      ]);
    }
  });

  it("ignores other resources, other actions and a prototype-named entity of the user", () => {
    const perms: ResolvedPermission[] = [
      { resource: "settings", action: "manage", conditions: null },
      { resource: "accounting", action: "access", conditions: null },
      { resource: "accounting-x", action: "read", conditions: null },
      { resource: "accounting", action: "read", conditions: ENTITY_CONDITION },
    ];
    expect(coveredEntities(perms, ch, "read")).toEqual(["welld_ch"]);
    expect(coveredEntities(perms, { entity: "__proto__" }, "read")).toEqual([]);
  });
});

// ─── The gate ────────────────────────────────────────────────────────────────

const ctxOf = (persona: { entity: string | null; permissions: readonly ResolvedPermission[] }) =>
  ({ var: { authz: { permissions: persona.permissions, entity: persona.entity } as AuthzContext } }) as const;

function refusal(fn: () => unknown): ProblemError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("expected a ProblemError, but the call returned");
}

describe("requireEntityAccess", () => {
  it("returns the validated entity for a covered read, and for a covered manage", () => {
    expect(requireEntityAccess(ctxOf(PERSONAS.accountingCh), "welld_ch", "read")).toBe("welld_ch");
    expect(requireEntityAccess(ctxOf(PERSONAS.accountingCh), "welld_ch", "manage")).toBe("welld_ch");
    expect(requireEntityAccess(ctxOf(PERSONAS.admin), "welld_it", "manage")).toBe("welld_it");
    expect(requireEntityAccess(ctxOf(PERSONAS.managerOnlyCh), "welld_ch", "read")).toBe("welld_ch");
  });

  it("404 not_found for an entity outside read coverage, with the body of an unknown entity", () => {
    const uncovered = refusal(() => requireEntityAccess(ctxOf(PERSONAS.accountingCh), "welld_it", "read"));
    const unknown = refusal(() => requireEntityAccess(ctxOf(PERSONAS.accountingCh), "welld_xx", "read"));
    expect([uncovered.status, uncovered.code]).toEqual([404, "not_found"]);
    expect([unknown.status, unknown.code]).toEqual([404, "not_found"]);
    expect(uncovered.message).toBe(unknown.message);
    expect(uncovered.extras).toEqual(unknown.extras);
    // A write to an uncovered entity is a 404 too, not a manage refusal that would confirm it exists.
    expect(refusal(() => requireEntityAccess(ctxOf(PERSONAS.accountingCh), "welld_it", "manage")).status).toBe(404);
  });

  it("rejects entity ids that are not exactly an entity (case, padding, prototype names)", () => {
    for (const bad of ["WELLD_CH", " welld_ch", "welld_ch ", "", "__proto__", "constructor", "welld_ch/../x"]) {
      expect(refusal(() => requireEntityAccess(ctxOf(PERSONAS.admin), bad, "read")).status).toBe(404);
    }
  });

  it("403 accounting_manage_required for a write by a reader of the entity", () => {
    const err = refusal(() => requireEntityAccess(ctxOf(PERSONAS.readerCh), "welld_ch", "manage"));
    expect([err.status, err.code]).toEqual([403, "accounting_manage_required"]);
  });

  it("403 accounting_forbidden when nothing is covered, whatever entity or level the path asks for", () => {
    for (const persona of [PERSONAS.outsider, PERSONAS.noEntity, PERSONAS.unknownCondition]) {
      for (const entity of ["welld_ch", "welld_it", "welld_xx"]) {
        for (const level of ["read", "manage"] as const) {
          const err = refusal(() => requireEntityAccess(ctxOf(persona), entity, level));
          expect([err.status, err.code]).toEqual([403, "accounting_forbidden"]);
        }
      }
    }
  });

  it("is rendered as Problem JSON by the app's error handler, with no entity in the body", async () => {
    const app = new Hono<{ Variables: { authz: AuthzContext } }>();
    app.use("*", async (c, next) => {
      c.set("authz", { permissions: PERSONAS.readerCh.permissions, entity: PERSONAS.readerCh.entity });
      await next();
    });
    app.post("/e/:entity", (c) => c.json({ entity: requireEntityAccess(c, c.req.param("entity"), "manage") }));
    app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.text("boom", 500));

    const refused = await app.request("/e/welld_ch", { method: "POST" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ status: 403, code: "accounting_manage_required", instance: "/e/welld_ch" });

    const hidden = await app.request("/e/welld_it", { method: "POST" });
    const unknown = await app.request("/e/nope", { method: "POST" });
    expect(hidden.status).toBe(404);
    const { instance: _a, ...hiddenBody } = (await hidden.json()) as Record<string, unknown>;
    const { instance: _b, ...unknownBody } = (await unknown.json()) as Record<string, unknown>;
    expect(hiddenBody).toEqual(unknownBody);
    expect(hiddenBody["code"]).toBe("not_found");
  });
});

describe("requireAnyAccess and coverageOf", () => {
  it("returns both coverages, welld_ch first", () => {
    expect(coverageOf(ctxOf(PERSONAS.admin))).toEqual({ read: ["welld_ch", "welld_it"], manage: ["welld_ch", "welld_it"] });
    expect(requireAnyAccess(ctxOf(PERSONAS.readerCh))).toEqual({ read: ["welld_ch"], manage: [] });
  });

  it("throws 403 accounting_forbidden when read covers nothing", () => {
    const err = refusal(() => requireAnyAccess(ctxOf(PERSONAS.outsider)));
    expect([err.status, err.code]).toEqual([403, "accounting_forbidden"]);
  });
});
