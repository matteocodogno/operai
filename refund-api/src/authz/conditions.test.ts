/**
 * Unit tests for refund-api's local condition evaluators (T6,
 * specs/007-refund-service, ADR-0014/ADR-0015).
 *
 * Pure functions, no DB/network — see conditions.ts's own doc comment for
 * what each helper backs.
 */

import { describe, it, expect } from "bun:test";
import {
  hasCapability,
  findPermission,
  ownershipOwn,
  requestInScope,
  entityScopeForPermission,
  approveSelfRestricted,
  GLOBAL_ENTITY_SCOPE,
} from "./conditions";
import type { ResolvedPermission } from "./resolveClient";

// ─── hasCapability / findPermission ────────────────────────────────────────

describe("hasCapability", () => {
  const permissions: ResolvedPermission[] = [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    {
      resource: "request",
      action: "read",
      conditions: { ownership: "own" },
    },
  ];

  it("returns true when the exact (resource, action) grant is present", () => {
    expect(hasCapability(permissions, "request", "create")).toBe(true);
    expect(hasCapability(permissions, "request", "read")).toBe(true);
  });

  it("returns false when the resource/action pair is absent entirely", () => {
    expect(hasCapability(permissions, "request", "review")).toBe(false);
    expect(hasCapability(permissions, "request", "approve")).toBe(false);
  });

  it("returns false on an empty permission set (default-deny)", () => {
    expect(hasCapability([], "refund", "access")).toBe(false);
  });

  it("does not confuse a matching resource with a different action, or vice versa", () => {
    expect(hasCapability(permissions, "request", "delete")).toBe(false);
    expect(hasCapability(permissions, "line", "create")).toBe(false);
  });
});

describe("findPermission", () => {
  const reviewGrant: ResolvedPermission = {
    resource: "request",
    action: "review",
    conditions: { attributes: [{ key: "entity", match: "user" }] },
  };
  const permissions: ResolvedPermission[] = [reviewGrant];

  it("returns the matching permission object (including its conditions)", () => {
    expect(findPermission(permissions, "request", "review")).toBe(
      reviewGrant,
    );
  });

  it("returns undefined when no grant matches", () => {
    expect(
      findPermission(permissions, "request", "approve"),
    ).toBeUndefined();
  });
});

// ─── ownershipOwn ───────────────────────────────────────────────────────────

describe("ownershipOwn", () => {
  it("returns true when the record's ownerUserId matches the caller's sub", () => {
    expect(ownershipOwn({ ownerUserId: "user-a" }, "user-a")).toBe(true);
  });

  it("returns false when the record belongs to a different user", () => {
    expect(ownershipOwn({ ownerUserId: "user-a" }, "user-b")).toBe(false);
  });

  it("is case-sensitive / exact-match — no partial or normalized comparison", () => {
    expect(ownershipOwn({ ownerUserId: "User-A" }, "user-a")).toBe(false);
  });
});

// ─── requestInScope (ADR-0015) ──────────────────────────────────────────────

describe("requestInScope", () => {
  it("single-entity scope: matches when the caller's entity equals the request's single line entity", () => {
    const lines = [{ entity: "welld_it" }];
    expect(requestInScope(lines, "welld_it")).toBe(true);
  });

  it("single-entity scope: does NOT match when no line's entity equals the caller's entity", () => {
    const lines = [{ entity: "welld_ch" }];
    expect(requestInScope(lines, "welld_it")).toBe(false);
  });

  it("mixed-entity request: matches via 'at least one line' even though most lines are out of scope", () => {
    const lines = [
      { entity: "welld_ch" },
      { entity: "welld_ch" },
      { entity: "welld_it" }, // the ONE matching line is enough
      { entity: "welld_ch" },
    ];
    expect(requestInScope(lines, "welld_it")).toBe(true);
  });

  it("mixed-entity request: still excluded when NONE of the lines match the caller's entity", () => {
    const lines = [{ entity: "welld_ch" }, { entity: "welld_ch" }];
    expect(requestInScope(lines, "welld_it")).toBe(false);
  });

  it("global scope (GLOBAL_ENTITY_SCOPE) sees every request, regardless of line entities", () => {
    expect(requestInScope([{ entity: "welld_it" }], GLOBAL_ENTITY_SCOPE)).toBe(
      true,
    );
    expect(requestInScope([{ entity: "welld_ch" }], GLOBAL_ENTITY_SCOPE)).toBe(
      true,
    );
    expect(
      requestInScope(
        [{ entity: "welld_it" }, { entity: "welld_ch" }],
        GLOBAL_ENTITY_SCOPE,
      ),
    ).toBe(true);
  });

  it("global scope sees even a request with zero lines", () => {
    expect(requestInScope([], GLOBAL_ENTITY_SCOPE)).toBe(true);
  });

  it("single-entity scope never matches a request with zero lines", () => {
    expect(requestInScope([], "welld_it")).toBe(false);
  });
});

// ─── entityScopeForPermission (ADR-0015 point 1) ───────────────────────────

describe("entityScopeForPermission", () => {
  it("an unconditioned grant (conditions: null) resolves to GLOBAL_ENTITY_SCOPE", () => {
    expect(entityScopeForPermission(null, "welld_it")).toBe(
      GLOBAL_ENTITY_SCOPE,
    );
  });

  it("a grant with conditions but no entity attribute resolves to GLOBAL_ENTITY_SCOPE", () => {
    expect(
      entityScopeForPermission({ ownership: "own" }, "welld_it"),
    ).toBe(GLOBAL_ENTITY_SCOPE);
  });

  it("an entity-conditioned grant resolves to the caller's own entity value", () => {
    const conditions = { attributes: [{ key: "entity", match: "user" }] };
    expect(entityScopeForPermission(conditions, "welld_it")).toBe(
      "welld_it",
    );
    expect(entityScopeForPermission(conditions, "welld_ch")).toBe(
      "welld_ch",
    );
  });

  it("an entity-conditioned grant with no caller entity attribute resolves to null (matches nothing)", () => {
    const conditions = { attributes: [{ key: "entity", match: "user" }] };
    expect(entityScopeForPermission(conditions, null)).toBeNull();
  });

  it("ignores unrelated attribute conditions (only key:'entity', match:'user' counts)", () => {
    const conditions = {
      attributes: [{ key: "jobTitle", match: "user" }],
    };
    expect(entityScopeForPermission(conditions, "welld_it")).toBe(
      GLOBAL_ENTITY_SCOPE,
    );
  });
});

// ─── approveSelfRestricted (specs/010-self-approval-control, ADR-0026) ─────

describe("approveSelfRestricted", () => {
  it("returns true when attributes contains {key:'self-approval', match:'deny'}", () => {
    expect(
      approveSelfRestricted({
        attributes: [{ key: "self-approval", match: "deny" }],
      }),
    ).toBe(true);
  });

  it("returns false when the self-approval attribute is absent", () => {
    expect(
      approveSelfRestricted({ attributes: [{ key: "entity", match: "user" }] }),
    ).toBe(false);
  });

  it("returns false for null/undefined/empty conditions (no attribute to find)", () => {
    expect(approveSelfRestricted(null)).toBe(false);
    expect(approveSelfRestricted(undefined)).toBe(false);
    expect(approveSelfRestricted({})).toBe(false);
    expect(approveSelfRestricted({ ownership: "own" })).toBe(false);
  });

  it("returns false when the key matches but `match` is not 'deny' (wrong polarity)", () => {
    expect(
      approveSelfRestricted({
        attributes: [{ key: "self-approval", match: "user" }],
      }),
    ).toBe(false);
    expect(
      approveSelfRestricted({
        attributes: [{ key: "self-approval", match: "any" }],
      }),
    ).toBe(false);
  });

  it("(AC-2.4 unit) composes independently alongside an entity attribute — both present, both readable", () => {
    const conditions = {
      attributes: [
        { key: "entity", match: "user" },
        { key: "self-approval", match: "deny" },
      ],
    };
    expect(approveSelfRestricted(conditions)).toBe(true);
    expect(entityScopeForPermission(conditions, "welld_it")).toBe("welld_it");
  });

  it("(AC-2.4 unit) a grant with ONLY entity (no self-approval) is unrestricted", () => {
    const conditions = { attributes: [{ key: "entity", match: "user" }] };
    expect(approveSelfRestricted(conditions)).toBe(false);
  });

  it("(R4) the entity-scope path ignores a self-approval attribute — never treats it as a scope narrowing", () => {
    const conditions = {
      attributes: [{ key: "self-approval", match: "deny" }],
    };
    expect(entityScopeForPermission(conditions, "welld_it")).toBe(
      GLOBAL_ENTITY_SCOPE,
    );
  });

  it("(R4) approveSelfRestricted ignores an entity attribute — never treats it as a deny carve-out", () => {
    const conditions = { attributes: [{ key: "entity", match: "user" }] };
    expect(approveSelfRestricted(conditions)).toBe(false);
  });
});
