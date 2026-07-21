/**
 * Unit tests for `review.service.ts`'s pure, DB-free helpers.
 *
 * `approveRestrictedForCaller` (specs/010-self-approval-control, ADR-0026,
 * T2) — see conditions.test.ts for the underlying `approveSelfRestricted`
 * predicate's own coverage; this file exercises the thin wrapper that locates
 * the caller's `request:approve` grant via `findPermission`.
 */

import { describe, it, expect } from "bun:test";
import { approveRestrictedForCaller } from "./review.service";
import type { AuthzContext } from "../auth/authz.middleware";

describe("approveRestrictedForCaller (specs/010-self-approval-control, ADR-0026)", () => {
  it("true when the caller's approve grant carries the self-approval restriction", () => {
    const authz: AuthzContext = {
      permissions: [
        {
          resource: "request",
          action: "approve",
          conditions: { attributes: [{ key: "self-approval", match: "deny" }] },
        },
      ],
      entity: null,
    };
    expect(approveRestrictedForCaller(authz)).toBe(true);
  });

  it("false when the caller's approve grant has no self-approval attribute (unconditioned)", () => {
    const authz: AuthzContext = {
      permissions: [{ resource: "request", action: "approve", conditions: null }],
      entity: null,
    };
    expect(approveRestrictedForCaller(authz)).toBe(false);
  });

  it("false when the caller's approve grant carries only an entity attribute", () => {
    const authz: AuthzContext = {
      permissions: [
        {
          resource: "request",
          action: "approve",
          conditions: { attributes: [{ key: "entity", match: "user" }] },
        },
      ],
      entity: "welld_it",
    };
    expect(approveRestrictedForCaller(authz)).toBe(false);
  });

  it("false when the caller holds no `request:approve` grant at all", () => {
    const authz: AuthzContext = { permissions: [], entity: null };
    expect(approveRestrictedForCaller(authz)).toBe(false);
  });

  it("false when the caller holds grants for other (resource, action) pairs but not approve", () => {
    const authz: AuthzContext = {
      permissions: [
        { resource: "request", action: "reject", conditions: null },
        { resource: "request", action: "review", conditions: null },
      ],
      entity: null,
    };
    expect(approveRestrictedForCaller(authz)).toBe(false);
  });

  it("(AC-2.4) composes independently with an entity attribute on the SAME approve grant", () => {
    const authz: AuthzContext = {
      permissions: [
        {
          resource: "request",
          action: "approve",
          conditions: {
            attributes: [
              { key: "entity", match: "user" },
              { key: "self-approval", match: "deny" },
            ],
          },
        },
      ],
      entity: "welld_it",
    };
    expect(approveRestrictedForCaller(authz)).toBe(true);
  });
});
