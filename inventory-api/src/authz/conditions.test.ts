/**
 * Unit tests for inventory-api's condition evaluators (T7, specs/015-hardware-
 * inventory; AC-9.4, AC-9.5; ADR-0007/0014/0015). Pure functions: no DB, no
 * network.
 */

import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  ENTITIES,
  assetInScope,
  findPermission,
  hasCapability,
  scopeFor,
} from "./conditions";
import type { ResolvedPermission } from "./resolveClient";

const ENTITY_CONDITION = {
  attributes: [{ key: "entity", match: "user" }],
} as const;

const conditioned = (resource: string, action: string): ResolvedPermission => ({
  resource,
  action,
  conditions: ENTITY_CONDITION,
});
const unconditioned = (resource: string, action: string): ResolvedPermission => ({
  resource,
  action,
  conditions: null,
});

describe("hasCapability / findPermission", () => {
  const permissions: ResolvedPermission[] = [
    unconditioned("inventory", "access"),
    conditioned("asset", "manage"),
  ];

  it("is true only for the exact (resource, action) pair", () => {
    expect(hasCapability(permissions, "asset", "manage")).toBe(true);
    expect(hasCapability(permissions, "asset", "access")).toBe(false);
    expect(hasCapability(permissions, "ledger", "manage")).toBe(false);
  });

  it("denies by default on an empty set", () => {
    expect(hasCapability([], "inventory", "access")).toBe(false);
  });

  it("findPermission returns the grant with its conditions, or undefined", () => {
    expect(findPermission(permissions, "asset", "manage")?.conditions).toEqual(
      ENTITY_CONDITION,
    );
    expect(findPermission(permissions, "ledger", "manage")).toBeUndefined();
  });
});

describe("scopeFor (AC-9.4, AC-9.5)", () => {
  it("an entity-conditioned grant scopes the holder to their own entity", () => {
    expect(
      scopeFor([conditioned("asset", "manage")], "asset", "manage", "welld_ch"),
    ).toEqual(["welld_ch"]);
    expect(
      scopeFor([conditioned("asset", "manage")], "asset", "manage", "welld_it"),
    ).toEqual(["welld_it"]);
  });

  it("an unconditioned grant covers both entities, whatever the caller's entity", () => {
    for (const callerEntity of ["welld_ch", "welld_it", null]) {
      expect(
        scopeFor([unconditioned("ledger", "manage")], "ledger", "manage", callerEntity),
      ).toEqual([...ENTITIES]);
    }
  });

  it("an entity-conditioned grant with no user.entity covers nothing (fails closed, R-7)", () => {
    expect(
      scopeFor([conditioned("asset", "manage")], "asset", "manage", null),
    ).toEqual([]);
  });

  it("an entity value that is not one of ours covers nothing", () => {
    expect(
      scopeFor([conditioned("asset", "manage")], "asset", "manage", "welld_xx"),
    ).toEqual([]);
    expect(
      scopeFor([conditioned("asset", "manage")], "asset", "manage", ""),
    ).toEqual([]);
  });

  it("no grant for the pair → empty, even if the caller holds other capabilities", () => {
    expect(
      scopeFor([unconditioned("asset", "manage")], "ledger", "manage", "welld_ch"),
    ).toEqual([]);
    expect(scopeFor([], "asset", "manage", "welld_ch")).toEqual([]);
  });

  it("two grants of one pair: widest wins, in either order (ADR-0007)", () => {
    const both = [conditioned("asset", "manage"), unconditioned("asset", "manage")];
    expect(scopeFor(both, "asset", "manage", "welld_ch")).toEqual([...ENTITIES]);
    expect(scopeFor([...both].reverse(), "asset", "manage", "welld_ch")).toEqual([
      ...ENTITIES,
    ]);
  });

  it("two conditioned grants stay at the one entity (no duplicates)", () => {
    expect(
      scopeFor(
        [conditioned("asset", "manage"), conditioned("asset", "manage")],
        "asset",
        "manage",
        "welld_it",
      ),
    ).toEqual(["welld_it"]);
  });

  it("the two capabilities are scoped independently of each other", () => {
    const permissions = [conditioned("asset", "manage"), unconditioned("ledger", "manage")];
    expect(scopeFor(permissions, "asset", "manage", "welld_ch")).toEqual(["welld_ch"]);
    expect(scopeFor(permissions, "ledger", "manage", "welld_ch")).toEqual([...ENTITIES]);
  });

  describe("an unrecognised condition contributes NOTHING (fails closed, unlike refund-api)", () => {
    const withConditions = (conditions: ResolvedPermission["conditions"]): ResolvedPermission => ({
      resource: "asset",
      action: "manage",
      conditions,
    });
    const warn = spyOn(console, "warn");
    beforeEach(() => warn.mockImplementation(() => {}));
    afterEach(() => warn.mockReset());

    it("a different attribute key", () => {
      const odd = withConditions({ attributes: [{ key: "department", match: "user" }] });
      expect(scopeFor([odd], "asset", "manage", "welld_ch")).toEqual([]);
    });

    it("the entity key with a match other than 'user'", () => {
      const odd = withConditions({ attributes: [{ key: "entity", match: "any" }] });
      expect(scopeFor([odd], "asset", "manage", "welld_ch")).toEqual([]);
    });

    it("an ownership condition", () => {
      for (const ownership of ["own", "any"] as const) {
        expect(scopeFor([withConditions({ ownership })], "asset", "manage", "welld_ch")).toEqual([]);
      }
    });

    it("the entity condition next to an unrecognised one is not trusted either", () => {
      const mixed = withConditions({
        attributes: [
          { key: "entity", match: "user" },
          { key: "department", match: "user" },
        ],
      });
      expect(scopeFor([mixed], "asset", "manage", "welld_ch")).toEqual([]);
    });

    it("a conditions object that restricts nothing (no ownership, no attributes) is unrestricted", () => {
      expect(scopeFor([withConditions({})], "asset", "manage", "welld_ch")).toEqual([...ENTITIES]);
      expect(scopeFor([withConditions({ attributes: [] })], "asset", "manage", null)).toEqual([...ENTITIES]);
    });

    it("widest wins still holds: an unconditioned grant alongside an unrecognised one covers both", () => {
      const odd = withConditions({ attributes: [{ key: "department", match: "user" }] });
      expect(scopeFor([odd, unconditioned("asset", "manage")], "asset", "manage", "welld_ch")).toEqual([...ENTITIES]);
      expect(scopeFor([unconditioned("asset", "manage"), odd], "asset", "manage", "welld_ch")).toEqual([...ENTITIES]);
    });

    it("it adds nothing to a recognised entity grant of the same pair", () => {
      const odd = withConditions({ attributes: [{ key: "department", match: "user" }] });
      expect(scopeFor([odd, conditioned("asset", "manage")], "asset", "manage", "welld_it")).toEqual(["welld_it"]);
    });

    it("logs one warning per dropped grant, naming resource/action/keys and nothing about the caller", () => {
      const odd = withConditions({ attributes: [{ key: "department", match: "user" }] });
      scopeFor([odd], "asset", "manage", "welld_ch");
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("asset:manage");
      expect(line).toContain("department");
      expect(line).not.toContain("welld_ch");
    });

    it("recognised and unconditioned grants log nothing", () => {
      scopeFor([conditioned("asset", "manage"), unconditioned("ledger", "manage")], "asset", "manage", "welld_ch");
      scopeFor([unconditioned("ledger", "manage")], "ledger", "manage", "welld_ch");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("returns entities in the fixed order whichever way they were reached", () => {
    expect(scopeFor([unconditioned("asset", "manage")], "asset", "manage", null)).toEqual([
      "welld_ch",
      "welld_it",
    ]);
  });
});

describe("assetInScope", () => {
  it("is true only when the asset's entity is in the scope", () => {
    expect(assetInScope({ entity: "welld_ch" }, ["welld_ch"])).toBe(true);
    expect(assetInScope({ entity: "welld_it" }, ["welld_ch"])).toBe(false);
    expect(assetInScope({ entity: "welld_it" }, ["welld_ch", "welld_it"])).toBe(true);
  });

  it("an empty scope sees no asset", () => {
    expect(assetInScope({ entity: "welld_ch" }, [])).toBe(false);
  });
});
