/** `assertCanManage` — the record-level half of AC-4.4: 403 `forbidden` vs `out_of_scope`. */
import { describe, expect, it } from "bun:test";
import "../test-support/world"; // sets up the auth mocks BEFORE guards.ts is first evaluated
import { ProblemError } from "../lib/problem";
import type { ResolvedPermission } from "../authz/resolveClient";

const { assertCanManage, canSetBexio, manageScope, managesAll } = await import("./guards");

const source = (permissions: ResolvedPermission[], entity: string | null) => ({
  get: () => ({ permissions, entity }),
});
const scoped: ResolvedPermission = {
  resource: "project",
  action: "manage",
  conditions: { attributes: [{ key: "entity", match: "user" }] },
};
const unscoped: ResolvedPermission = { resource: "project", action: "manage", conditions: null };

const refusal = (fn: () => void): ProblemError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("expected a ProblemError");
};

describe("assertCanManage", () => {
  it("lets an entity-scoped holder manage their own entity", () => {
    expect(() => assertCanManage(source([scoped], "welld_ch"), "welld_ch")).not.toThrow();
  });

  it("refuses the other entity with 403 `out_of_scope`", () => {
    const error = refusal(() => assertCanManage(source([scoped], "welld_ch"), "welld_it"));
    expect(error).toMatchObject({ status: 403, code: "out_of_scope" });
  });

  it("refuses a caller without project:manage with 403 `forbidden`", () => {
    const error = refusal(() => assertCanManage(source([], "welld_ch"), "welld_ch"));
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("refuses an entity-scoped holder with no entity (fails closed)", () => {
    const error = refusal(() => assertCanManage(source([scoped], null), "welld_ch"));
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("lets an unconditioned holder (admin) manage both entities", () => {
    const admin = source([unscoped], null);
    expect(() => assertCanManage(admin, "welld_ch")).not.toThrow();
    expect(() => assertCanManage(admin, "welld_it")).not.toThrow();
    expect(managesAll(admin)).toBe(true);
    expect(manageScope(admin)).toEqual(["welld_ch", "welld_it"]);
  });
});

describe("canSetBexio", () => {
  it("is true only for a purchase-order:bexio grant", () => {
    expect(canSetBexio(source([{ resource: "purchase-order", action: "bexio", conditions: null }], null))).toBe(true);
    expect(canSetBexio(source([unscoped], null))).toBe(false);
    // The capability of specs/021, retired with the contract (specs/022 D38), opens nothing any more.
    expect(canSetBexio(source([{ resource: "contract", action: "bexio", conditions: null }], null))).toBe(false);
  });
});
