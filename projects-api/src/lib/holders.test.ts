/**
 * auth client for the holders of `purchase-order:receive` (specs/022 T24; AC-4.1, AC-4.2, T18 L4):
 * the candidates of a take's ops-manager picker and the list its choice is re-validated against.
 * Asked with the CALLER's own Bearer header, live, never cached, and fail-closed: any failure is a
 * `503 identity_unavailable`, never an empty list or a stale one. auth is the fake of
 * test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { holders, resetWorld } from "../test-support/world";
import { opsManagerCandidates } from "./holders";
import { ProblemError } from "./problem";

beforeEach(resetWorld);

const CALLER = "Bearer caller-jwt";

/** The problem a failed lookup throws, as a plain object. */
async function failure(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("expected the lookup to fail");
}

describe("opsManagerCandidates() — who may be a purchase order's ops-manager (AC-4.1)", () => {
  it("lists the holders for the entity as { id, name, unconditioned }, in auth's order", async () => {
    holders.users.welld_ch = [
      { id: "u-1", name: "Ann Ops", unconditioned: false },
      { id: "u-2", name: "Ben Ops", unconditioned: false },
      { id: "u-admin", name: "Ada Admin", unconditioned: true },
    ];
    expect(await opsManagerCandidates(CALLER, "welld_ch")).toEqual([
      { id: "u-1", name: "Ann Ops", unconditioned: false },
      { id: "u-2", name: "Ben Ops", unconditioned: false },
      { id: "u-admin", name: "Ada Admin", unconditioned: true },
    ]);
  });

  it("asks auth for exactly the pinned pair and the entity, with the CALLER's header, not a service token", async () => {
    await opsManagerCandidates(CALLER, "welld_it");
    expect(holders.calls).toBe(1);
    expect(holders.lastAuthorization).toBe(CALLER);
    expect(new URLSearchParams(holders.lastQuery).toString()).toBe("resource=purchase-order&action=receive&entity=welld_it");
  });

  it("is live: every call asks auth again", async () => {
    await opsManagerCandidates(CALLER, "welld_ch");
    holders.users.welld_ch = [];
    expect(await opsManagerCandidates(CALLER, "welld_ch")).toEqual([]);
    expect(holders.calls).toBe(2);
  });

  it("carries only the three members, whatever else auth sends", async () => {
    holders.body = { users: [{ id: "u-1", name: "Ann Ops", unconditioned: false, email: "ann@example.test", entity: "welld_ch" }] };
    expect(await opsManagerCandidates(CALLER, "welld_ch")).toEqual([{ id: "u-1", name: "Ann Ops", unconditioned: false }]);
  });

  it("skips an entry it cannot read rather than guess at it", async () => {
    holders.body = {
      users: [
        { id: "u-1", name: "Ann Ops", unconditioned: false },
        { id: "", name: "No Id", unconditioned: false },
        { id: "u-3", name: "Missing flag" },
        "not an object",
        null,
      ],
    };
    expect(await opsManagerCandidates(CALLER, "welld_ch")).toEqual([{ id: "u-1", name: "Ann Ops", unconditioned: false }]);
  });
});

describe("opsManagerCandidates() — fails closed (T18 L4)", () => {
  it.each([
    ["auth is down", () => void (holders.down = true)],
    ["auth refuses the caller (403)", () => void (holders.status = 403)],
    ["auth rate-limits the caller (429)", () => void (holders.status = 429)],
    ["auth answers 400", () => void (holders.status = 400)],
    ["the body has no users", () => void (holders.body = { people: [] })],
    ["the body is not an object", () => void (holders.body = "nope")],
  ])("503 identity_unavailable when %s", async (_label, break_) => {
    break_();
    const error = await failure(opsManagerCandidates(CALLER, "welld_ch"));
    expect(error.status).toBe(503);
    expect(error.code).toBe("identity_unavailable");
  });
});
