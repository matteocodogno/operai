/**
 * The 60 s name cache through the ASSEMBLED app, the real database and the fake hosts (specs/20261112-time-tracking T46; AC-4.8,
 * AC-4.7, AC-4.5; plan § Sequences "Names"). `src/lib/identities.test.ts` pins the client; this file pins what a person
 * reads through it: the list, the `groupBy=person` totals and a written entry's view share one map, a rename or a
 * deactivation shows from 60 s after the read that named the person, a refusal is never remembered, and a request asks only
 * for the people the map does not hold.
 *
 * `setSystemTime` moves the clock from the real start of each test (the harness's tokens expire an hour after they were
 * signed); `hosts.reset()` through `resetWorld` empties the map between tests.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { PERSONAS, SEED, call, makeNoEntityEntry, resetWorld } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const TRAINING = SEED.categories.training;
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

let start: number;
/** Moves the clock to `ms` after the start of the test. */
const at = (ms: number) => setSystemTime(new Date(start + ms));

beforeEach(async () => {
  start = Date.now();
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
  hosts.auth.setIdentity(ALICE, { name: "Alice Rossi" });
  hosts.auth.setIdentity(BOB, { name: "Bob Verdi" });
  hosts.auth.setIdentity(PERSONAS.holder.sub, { name: "Holder" });
  await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-05" });
  await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-05" });
});
afterEach(() => setSystemTime());

const identityCalls = () => hosts.callsTo("auth.identities");
const askedIds = (index: number): string[] => (identityCalls()[index]?.body as { ids: string[] }).ids;
/** The calls that asked for `id`, whoever else they asked for. */
const callsFor = (id: string) => identityCalls().filter((recorded) => (recorded.body as { ids: string[] }).ids.includes(id));

/** What a person is told of Alice through each way hours-api names a person, and the sources that did not answer. */
type Surface = "list" | "person totals" | "written entry";
const SURFACES: readonly Surface[] = ["list", "person totals", "written entry"];

interface Told {
  readonly name: string | null;
  readonly status: string;
  readonly unavailable: string[];
}

async function aliceThrough(surface: Surface): Promise<Told> {
  if (surface === "list") {
    const res = await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    expect(res.status).toBe(200);
    const item = res.json.items.find((entry: { person: { id: string } }) => entry.person.id === ALICE);
    return { name: item.person.name, status: item.person.status, unavailable: res.json.unavailable };
  }
  if (surface === "person totals") {
    const res = await call("GET", `/time-entries/totals?${NOVEMBER}&whose=all&groupBy=person`, { as: "holder" });
    expect(res.status).toBe(200);
    const group = res.json.groups.find((entry: { key?: string }) => entry.key === ALICE);
    return { name: group.label, status: group.status, unavailable: res.json.unavailable };
  }
  const res = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-11-12", minutes: 30, on: { type: "none", categoryId: TRAINING } } });
  expect(res.status).toBe(201);
  return { name: res.json.person.name, status: res.json.person.status, unavailable: [] };
}

describe("a rename or a deactivation shows from 60 s after the read that named the person (AC-4.8)", () => {
  it.each(SURFACES)("%s: the old name until 60 000 ms after the first call was sent, with no second call for her, then the new one", async (first) => {
    at(0);
    expect((await aliceThrough(first)).name).toBe("Alice Rossi");
    expect(callsFor(ALICE)).toHaveLength(1);
    // The instant the first call was SENT is the one the 60 s count from.
    expect(callsFor(ALICE)[0]?.at).toBe(start);

    hosts.auth.setIdentity(ALICE, { name: "Alice Bianchi" });
    at(59_999);
    for (const surface of SURFACES) expect({ surface, name: (await aliceThrough(surface)).name }).toEqual({ surface, name: "Alice Rossi" });
    expect(callsFor(ALICE)).toHaveLength(1);

    at(60_000);
    expect((await aliceThrough(first)).name).toBe("Alice Bianchi");
    expect(callsFor(ALICE)).toHaveLength(2);
    expect(callsFor(ALICE)[1]?.at).toBe(start + 60_000);
    // The refresh served the other two as well: one map, no third call for her.
    for (const surface of SURFACES) expect({ surface, name: (await aliceThrough(surface)).name }).toEqual({ surface, name: "Alice Bianchi" });
    expect(callsFor(ALICE)).toHaveLength(2);
  });

  it("a person deactivated after a read is active, with their name, until then and deleted after, on the list and in the person totals", async () => {
    at(0);
    expect(await aliceThrough("list")).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    hosts.auth.setIdentity(ALICE, { name: "Alice Rossi", status: "deleted" });
    at(59_999);
    expect(await aliceThrough("list")).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    expect(await aliceThrough("person totals")).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    expect(identityCalls()).toHaveLength(1);

    at(60_000);
    // `deleted` is an answer, not an outage: the person has no name, and `identities` is not named.
    expect(await aliceThrough("list")).toEqual({ name: null, status: "deleted", unavailable: [] });
    expect(await aliceThrough("person totals")).toEqual({ name: null, status: "deleted", unavailable: [] });
    expect(identityCalls()).toHaveLength(2);
  });
});

describe("a refusal is never remembered (AC-4.7)", () => {
  it.each(["list", "person totals"] as const)("%s: a 429 reads `unknown` with `identities` named, for that read only; the next read is named", async (surface) => {
    at(0);
    hosts.fail("auth.identities", { status: 429, times: 1 });
    expect(await aliceThrough(surface)).toEqual({ name: null, status: "unknown", unavailable: ["identities"] });
    expect(await aliceThrough(surface)).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    expect(identityCalls()).toHaveLength(2);
    // And now it is kept: a third read asks nothing.
    expect(await aliceThrough(surface)).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    expect(identityCalls()).toHaveLength(2);
  });

  it("a written entry's view after a 429 is `unknown`, and the next one is named", async () => {
    at(0);
    hosts.fail("auth.identities", { status: 429, times: 1 });
    expect(await aliceThrough("written entry")).toMatchObject({ name: null, status: "unknown" });
    expect(await aliceThrough("written entry")).toMatchObject({ name: "Alice Rossi", status: "active" });
    expect(identityCalls()).toHaveLength(2);
  });

  it("an outage after a success leaves the person named until their 60 s are up, and `unknown` after, never the old name", async () => {
    at(0);
    expect((await aliceThrough("list")).name).toBe("Alice Rossi");
    hosts.fail("auth.identities", { status: 503 });
    at(59_999);
    expect(await aliceThrough("list")).toEqual({ name: "Alice Rossi", status: "active", unavailable: [] });
    expect(identityCalls()).toHaveLength(1);
    at(60_000);
    expect(await aliceThrough("list")).toEqual({ name: null, status: "unknown", unavailable: ["identities"] });
  });
});

describe("a request asks only for the people the map does not hold (AC-4.5, plan § Sequences 'Names')", () => {
  const manyPeople = async (count: number) => {
    const ids = Array.from({ length: count }, (_, index) => `user-p-${String(index + 1).padStart(3, "0")}`);
    for (const id of ids) {
      hosts.auth.setIdentity(id, { name: `Person ${id.slice(-3)}` });
      await makeNoEntityEntry(TRAINING, { userId: id, day: "2026-11-06" });
    }
    return ids;
  };

  it("a cold list page of at most 100 authors records exactly one call, and the same page again none", async () => {
    const ids = await manyPeople(98); // with Alice and Bob: exactly 100 authors on the page
    const first = await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    expect(first.json.items).toHaveLength(100);
    expect(identityCalls()).toHaveLength(1);
    expect([...askedIds(0)].sort()).toEqual([...ids, ALICE, BOB].sort());
    expect(first.json.items.every((item: { person: { status: string } }) => item.person.status === "active")).toBe(true);

    const again = await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    expect(again.json.items).toEqual(first.json.items);
    expect(identityCalls()).toHaveLength(1);
  });

  it("`groupBy=person` after the list asks only for the people the list did not name", async () => {
    await manyPeople(148); // 150 people with hours: the page names 100 of them, the totals name all
    const page = await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    const named = new Set<string>(page.json.items.map((item: { person: { id: string } }) => item.person.id));
    expect(named.size).toBe(100);
    expect(identityCalls()).toHaveLength(1);

    const totals = await call("GET", `/time-entries/totals?${NOVEMBER}&whose=all&groupBy=person`, { as: "holder" });
    expect(totals.json.groups).toHaveLength(150);
    expect(totals.json.groups.every((group: { status: string; label: string | null }) => group.status === "active" && group.label !== null)).toBe(true);
    expect(totals.json.unavailable).toEqual([]);

    expect(identityCalls()).toHaveLength(2);
    const everyone = totals.json.groups.map((group: { key: string }) => group.key);
    expect([...askedIds(1)].sort()).toEqual(everyone.filter((id: string) => !named.has(id)).sort());
    expect(askedIds(1)).toHaveLength(50);
  });

  it("another viewer is served from the same map: Alice's My hours asks nothing for herself after the holder's read named her", async () => {
    await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    expect(identityCalls()).toHaveLength(1);
    const mine = await call("GET", `/time-entries?${NOVEMBER}`, { as: "alice" });
    expect(mine.json.items[0].person).toEqual({ id: ALICE, name: "Alice Rossi", status: "active" });
    expect(identityCalls()).toHaveLength(1);
  });

  it("a viewer is never told a name for a person their own scope does not show: Bob's My hours names Bob only", async () => {
    // The map holds Alice (the holder's read); Bob asks for his own hours and the answer names nobody else.
    await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    const mine = await call("GET", `/time-entries?${NOVEMBER}`, { as: "bob" });
    expect(mine.json.items.map((item: { person: { id: string } }) => item.person.id)).toEqual([BOB]);
    expect(JSON.stringify(mine.json)).not.toContain("Alice");
  });
});
