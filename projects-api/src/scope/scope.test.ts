/**
 * AC-4.1–4.6 as the UI reads them: `GET /scope` says what the caller may manage; specs/022 T24 adds
 * what they may take (`handoff:take`, AC-1.9) and whether they oversee every purchase order
 * (`purchase-order:receive` for EVERY entity, the admin override of AC-4.8).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, resetWorld } from "../test-support/world";
import type { ResolvedPermission } from "../authz/resolveClient";

// Imported only after the test world: it installs the JWT and authz mocks, and a static import of
// `auth/guards` would bind the real middleware first (test-support/testAuth.ts).
const { oversees, takeScope } = await import("../auth/guards");

beforeEach(resetWorld);

describe("GET /scope", () => {
  it("is 401 without a token", async () => {
    const res = await call("GET", "/scope", { as: null });
    expect(res.status).toBe(401);
  });

  it("is 403 `forbidden` without projects:access (AC-4.2)", async () => {
    const res = await call("GET", "/scope", { as: "outsider" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("gives a reader no manage scope, no take and no Bexio (AC-4.3)", async () => {
    const res = await call("GET", "/scope", { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ manage: [], managesAll: false, bexio: false, take: [], oversees: false });
  });

  it("scopes a project manager to their own entity, and gives them no take (AC-4.4, AC-1.9)", async () => {
    const res = await call("GET", "/scope", { as: "pmCh" });
    expect(res.json).toEqual({ manage: ["welld_ch"], managesAll: false, bexio: false, take: [], oversees: false });
  });

  it("scopes sales to its own entity, for managing and for taking deals (AC-4.4, AC-1.1)", async () => {
    const it = await call("GET", "/scope", { as: "salesIt" });
    expect(it.json).toEqual({ manage: ["welld_it"], managesAll: false, bexio: false, take: ["welld_it"], oversees: false });
    const ch = await call("GET", "/scope", { as: "salesCh" });
    expect(ch.json).toEqual({ manage: ["welld_ch"], managesAll: false, bexio: false, take: ["welld_ch"], oversees: false });
  });

  it("gives an ops-manager its own entity to manage, no take, and NO oversight — receiving for one entity is not for all (T18 L5)", async () => {
    const res = await call("GET", "/scope", { as: "opsCh" });
    expect(res.json).toEqual({ manage: ["welld_ch"], managesAll: false, bexio: false, take: [], oversees: false });
  });

  it("gives accounting the Bexio capability and nothing to manage or take (AC-4.5)", async () => {
    const res = await call("GET", "/scope", { as: "accounting" });
    expect(res.json).toEqual({ manage: [], managesAll: false, bexio: true, take: [], oversees: false });
  });

  it("gives an admin every entity, the Bexio capability, every take and oversight (AC-4.6, AC-4.8)", async () => {
    const res = await call("GET", "/scope", { as: "admin" });
    expect(res.json).toEqual({
      manage: ["welld_ch", "welld_it"],
      managesAll: true,
      bexio: true,
      take: ["welld_ch", "welld_it"],
      oversees: true,
    });
  });
});

describe("oversees() and takeScope() — conditions decide, not the mere presence of a grant (T18 L5)", () => {
  const ENTITY = { attributes: [{ key: "entity", match: "user" }] } as const;
  const receive = (conditions: ResolvedPermission["conditions"]): ResolvedPermission => ({ resource: "purchase-order", action: "receive", conditions });
  const take = (conditions: ResolvedPermission["conditions"]): ResolvedPermission => ({ resource: "handoff", action: "take", conditions });
  const caller = (permissions: ResolvedPermission[], entity: string | null) => ({ get: () => ({ permissions, entity }) });

  it("is true for an unconditioned grant, whatever the caller's own entity", () => {
    expect(oversees(caller([receive(null)], null))).toBe(true);
    expect(oversees(caller([receive(null)], "welld_ch"))).toBe(true);
  });

  it("is false for an entity-conditioned grant, even though the caller holds the capability", () => {
    expect(oversees(caller([receive(ENTITY)], "welld_ch"))).toBe(false);
    expect(oversees(caller([receive(ENTITY)], "welld_it"))).toBe(false);
  });

  it("is false for a grant the caller's entity cannot evaluate, and for one with a condition it does not recognise", () => {
    expect(oversees(caller([receive(ENTITY)], null))).toBe(false);
    expect(oversees(caller([receive({ attributes: [{ key: "department", match: "user" }] })], "welld_ch"))).toBe(false);
  });

  it("is false without the grant, or with a different one", () => {
    expect(oversees(caller([], null))).toBe(false);
    expect(oversees(caller([take(null)], null))).toBe(false);
  });

  it("takeScope() is the entities `handoff:take` covers: both for an unconditioned grant, the caller's own for a scoped one, none without", () => {
    expect(takeScope(caller([take(null)], null))).toEqual(["welld_ch", "welld_it"]);
    expect(takeScope(caller([take(ENTITY)], "welld_it"))).toEqual(["welld_it"]);
    expect(takeScope(caller([take(ENTITY)], null))).toEqual([]);
    expect(takeScope(caller([receive(null)], "welld_ch"))).toEqual([]);
  });
});
