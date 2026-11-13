/**
 * What the oversight check remembers (specs/029 T19; plan § Sequences "Oversight", AC-4.2, AC-5.4, ADR-0075): a REFUSAL is
 * kept 30 s per `(sub, perm_epoch)`, so a person without `time-entry:read-all` does not cost `auth` a call per request;
 * a GRANT is never kept, so a revocation holds on the very next request even while the caller's token still carries the
 * old epoch; an outage is kept neither way. The same shape as `time-list:manage` (src/authz/timeListManage.ts, T12) —
 * and a different cache: what is remembered about one permission says nothing about the other.
 *
 * Import order: `world` first (the trap in test-support/world.ts).
 */
import { afterAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { PERSONAS, call, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __resetTimeListManageCacheForTests } from "../authz/timeListManage";
import { __resetOversightCacheForTests } from "./oversight";

const hosts = startHosts();
afterAll(() => hosts.stop());

beforeEach(async () => {
  await resetWorld();
  __resetOversightCacheForTests();
  __resetTimeListManageCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const PERIOD = "from=2026-11-01&to=2026-11-30";
const listAll = (as: PersonaName, permEpoch?: number) => call("GET", `/time-entries?${PERIOD}&whose=all`, { as, ...(permEpoch !== undefined ? { permEpoch } : {}) });
const totalsAll = (as: PersonaName, permEpoch?: number) =>
  call("GET", `/time-entries/totals?groupBy=day&${PERIOD}&whose=all`, { as, ...(permEpoch !== undefined ? { permEpoch } : {}) });

/** What `auth` answers once the person has lost every grant. */
const NO_GRANTS = (sub: string) => ({ sub, epoch: 0, permissions: [], entity: null, jobTitle: null });

describe("a refusal", () => {
  it("is kept per (sub, perm_epoch): the same person and epoch is refused again without asking auth", async () => {
    expect((await listAll("alice", 7)).status).toBe(403);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

    // The permission is granted, but the token the person holds still says epoch 7.
    hosts.auth.grant(PERSONAS.alice.sub, "time-entry", "read-all");
    const again = await listAll("alice", 7);
    expect(again.status).toBe(403);
    expect(again.json.code).toBe("read_all_required");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);
  });

  it("is one memory for the list and the totals: a refusal on one is a refusal on the other", async () => {
    expect((await listAll("alice", 7)).status).toBe(403);
    expect((await totalsAll("alice", 7)).status).toBe(403);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);
  });

  it("does not outlive a new epoch: a grant bumps perm_epoch, and the person's next token is asked afresh", async () => {
    expect((await listAll("alice", 7)).status).toBe(403);
    hosts.auth.grant(PERSONAS.alice.sub, "time-entry", "read-all");
    expect((await listAll("alice", 8)).status).toBe(200);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });

  it("is kept for that person only: another person at the same epoch is asked for themselves", async () => {
    expect((await listAll("alice", 7)).status).toBe(403);
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    expect((await listAll("holder", 7)).status).toBe(200);
  });

  it("is kept for 30 s and asked again after", async () => {
    const start = Date.now();
    try {
      setSystemTime(new Date(start));
      expect((await listAll("alice", 7)).status).toBe(403);
      hosts.auth.grant(PERSONAS.alice.sub, "time-entry", "read-all");

      setSystemTime(new Date(start + 29_000));
      expect((await listAll("alice", 7)).status).toBe(403);
      expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

      setSystemTime(new Date(start + 31_000));
      expect((await listAll("alice", 7)).status).toBe(200);
      expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
    } finally {
      setSystemTime();
    }
  });

  it("is a refusal of time-entry:read-all only: it does not refuse time-list:manage, nor the other way round", async () => {
    expect((await listAll("manager", 7)).status).toBe(403);
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    const created = await call("POST", "/time-categories", { as: "manager", permEpoch: 7, body: { name: "Seminars" } });
    expect(created.status).toBe(201);

    // And the refusal of the list manager's own write (another person, same epoch) leaves read-all alone.
    expect((await call("POST", "/time-categories", { as: "alice", permEpoch: 9, body: { name: "Offsite" } })).status).toBe(403);
    hosts.auth.grant(PERSONAS.alice.sub, "time-entry", "read-all");
    expect((await listAll("alice", 9)).status).toBe(200);
  });
});

describe("a grant", () => {
  it("is never kept: a revocation holds on the very next request, whatever epoch the token carries", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    expect((await listAll("holder", 3)).status).toBe(200);

    hosts.fail("auth.resolve", { body: NO_GRANTS(PERSONAS.holder.sub) });
    const revoked = await listAll("holder", 3);
    expect(revoked.status).toBe(403);
    expect(revoked.json.code).toBe("read_all_required");
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });

  it("is asked on every request: two reads in a row are two calls to auth, on the list and on the totals", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    await listAll("holder", 3);
    await totalsAll("holder", 3);
    await listAll("holder", 3);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(3);
  });

  it("is asked as the caller: auth receives the caller's own Authorization header, and no credential of hours-api's", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    await listAll("holder", 3);

    const [recorded] = hosts.callsTo("auth.resolve");
    expect(recorded?.authorization).toMatch(/^Bearer /);
    expect(JSON.parse(atob(recorded!.authorization!.slice(7).split(".")[1]!))).toMatchObject({ sub: PERSONAS.holder.sub, perm_epoch: 3 });
    expect(hosts.auth.mints).toBe(0);
  });
});

describe("an outage", () => {
  it("is not kept: when auth answers again the very next request is decided by what it says", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    hosts.fail("auth.resolve", { status: 500, times: 1 });
    expect((await listAll("holder", 3)).status).toBe(503);
    expect((await listAll("holder", 3)).status).toBe(200);
  });

  it("is not read as a refusal either: a person refused earlier and a person unreachable now are told apart", async () => {
    hosts.fail("auth.resolve", { status: 500, times: 1 });
    expect((await listAll("alice", 7)).status).toBe(503);
    // Had the outage been remembered as a refusal, this would be a cached 403 with no call.
    hosts.auth.grant(PERSONAS.alice.sub, "time-entry", "read-all");
    expect((await listAll("alice", 7)).status).toBe(200);
  });
});
