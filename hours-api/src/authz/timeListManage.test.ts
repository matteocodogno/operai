/**
 * What `time-list:manage` remembers (specs/029 T12; plan § Sequences "Admin lists", AC-3.3; the
 * ADR-0075 rule projects-api and estimai-api follow): a REFUSAL is kept 30 s per `(sub, perm_epoch)`,
 * so a person without the permission does not cost `auth` a call per click; a GRANT is never kept,
 * so a revocation holds on the very next write even while the caller's token still carries the old
 * epoch; an outage is never kept either way.
 *
 * Import order: `world` first (the trap in test-support/world.ts).
 */
import { afterAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { PERSONAS, call, resetWorld } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __resetTimeListManageCacheForTests } from "./timeListManage";

const hosts = startHosts();
afterAll(() => hosts.stop());

beforeEach(async () => {
  await resetWorld();
  __resetTimeListManageCacheForTests();
});

const create = (as: "alice" | "manager", permEpoch?: number) =>
  call("POST", "/time-categories", { as, ...(permEpoch !== undefined ? { permEpoch } : {}), body: { name: `Category of ${as} ${Math.random()}` } });

/** What `auth` answers once the person has lost every grant. */
const NO_GRANTS = (sub: string) => ({ sub, epoch: 0, permissions: [], entity: null, jobTitle: null });

describe("a refusal", () => {
  it("is kept per (sub, perm_epoch): the same person and epoch is refused again without asking auth", async () => {
    expect((await create("alice", 7)).status).toBe(403);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

    // The permission is granted, but the token the person holds still says epoch 7.
    hosts.auth.grant(PERSONAS.alice.sub, "time-list", "manage");
    const again = await create("alice", 7);
    expect(again.status).toBe(403);
    expect(again.json.code).toBe("time_list_manage_required");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);
  });

  it("does not outlive a new epoch: a grant bumps perm_epoch, and the person's next token is asked afresh", async () => {
    expect((await create("alice", 7)).status).toBe(403);
    hosts.auth.grant(PERSONAS.alice.sub, "time-list", "manage");
    expect((await create("alice", 8)).status).toBe(201);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });

  it("is kept for that person only: another person at the same epoch is asked for themselves", async () => {
    expect((await create("alice", 7)).status).toBe(403);
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    expect((await create("manager", 7)).status).toBe(201);
  });

  it("is kept for 30 s and asked again after", async () => {
    const start = Date.now();
    try {
      setSystemTime(new Date(start));
      expect((await create("alice", 7)).status).toBe(403);
      hosts.auth.grant(PERSONAS.alice.sub, "time-list", "manage");

      setSystemTime(new Date(start + 29_000));
      expect((await create("alice", 7)).status).toBe(403);
      expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

      setSystemTime(new Date(start + 31_000));
      expect((await create("alice", 7)).status).toBe(201);
      expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
    } finally {
      setSystemTime();
    }
  });
});

describe("a grant", () => {
  it("is never kept: a revocation holds on the very next write, whatever epoch the token carries", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    expect((await create("manager", 3)).status).toBe(201);

    hosts.fail("auth.resolve", { body: NO_GRANTS(PERSONAS.manager.sub) });
    const revoked = await create("manager", 3);
    expect(revoked.status).toBe(403);
    expect(revoked.json.code).toBe("time_list_manage_required");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });

  it("is asked on every write: two writes in a row are two calls to auth", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    await create("manager", 3);
    await create("manager", 3);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });
});

describe("an outage", () => {
  it("is not kept: when auth answers again the very next write is decided by what it says", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    hosts.fail("auth.resolve", { status: 500, times: 1 });
    expect((await create("manager", 3)).status).toBe(503);
    expect((await create("manager", 3)).status).toBe(201);
  });

  it("is not read as a refusal either: a person refused earlier and a person unreachable now are told apart", async () => {
    hosts.fail("auth.resolve", { status: 500, times: 1 });
    expect((await create("alice", 7)).status).toBe(503);
    // Had the outage been remembered as a refusal, this would be a cached 403 with no call.
    hosts.auth.grant(PERSONAS.alice.sub, "time-list", "manage");
    expect((await create("alice", 7)).status).toBe(201);
  });
});
