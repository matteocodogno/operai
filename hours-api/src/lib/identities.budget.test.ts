/**
 * The name lookups of an ordinary session stay inside `auth`'s per-person budget (specs/20261112-time-tracking T46; AC-4.8,
 * AC-4.7, AC-4.5; plan § Sequences "Names", R12; qe-report.md D-1).
 *
 * `auth` counts `POST /authz/users/identities` per caller `sub`: 120 calls in any 10 minutes, then 429, shared with every
 * service that names people with that person's Bearer. QE measured that hours-api, one call per read, spent it in
 * ordinary use: a holder changing Everyone's hours filters lost every name after about 40 changes, and a person using My
 * hours after about 120 actions. This is that session, simulated: the fake `auth` of test-support/hosts.ts answers a
 * person's 121st call in a sliding 10 minutes with a 429, exactly as `auth` does, and `setSystemTime` makes the ten minutes
 * pass in the time the test takes.
 *
 * Two people use the service for ten simulated minutes, over the real app, database and fake hosts:
 *   - the HOLDER of `time-entry:read-all` changes a filter of Everyone's hours 40 times, every 15 s; each change sends three
 *     reads at once (the page, the chosen `groupBy=person` totals and the Person filter's options, the same query),
 *     over 150 people who have hours in the period;
 *   - an EMPLOYEE acts in My hours 120 times, every 5 s: a list read each time, and every fourth after recording an
 *     entry (the written entry's view names its author).
 * The employee's hours are in another month than the 150 people's, so her names are her own and the 10-call bound below
 * measures her budget, not what the holder's reads happened to leave in the cache for her.
 *
 * Expected: no identities call answered 429, every person in every answer `active` and named, `identities` never in
 * `unavailable`, at most 50 calls for the holder's `sub` (10 refills of 60 s, each at most 1 + 2 * 2 calls for 150
 * people) and at most 10 for the employee's.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { PERSONAS, SEED, call, makeNoEntityEntry, resetWorld } from "../test-support/world";
import { claimsOf, startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const HOLDER = PERSONAS.holder.sub;
const ALICE = PERSONAS.alice.sub;
const TRAINING = SEED.categories.training;

/** `IDENTITIES_RATE_LIMIT` and `IDENTITIES_RATE_WINDOW_MS`: auth's defaults. */
const LIMIT = 120;
const WINDOW_MS = 600_000;

const NOVEMBER = "from=2026-11-01&to=2026-11-30";
const OCTOBER = "from=2026-10-01&to=2026-10-31";
/** Every one of the 150 has an entry on 2026-11-05 in Training, so each of these filter sets keeps all of them. */
const HOLDER_FILTERS = [NOVEMBER, `${NOVEMBER}&categoryId=${TRAINING}`, "from=2026-11-05&to=2026-11-05"] as const;

const PEOPLE = Array.from({ length: 150 }, (_, index) => `user-p-${String(index + 1).padStart(3, "0")}`);
const nameOf = (id: string): string => (id === ALICE ? "Alice Rossi" : `Person ${id.slice(-3)}`);

let realFetch: typeof fetch;
/** What `auth` answered each identities call, read where hours-api's client receives it. */
let answers: { sub: string | null; nth: number; status: number; at: number }[];

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  hosts.auth.grant(HOLDER, "time-entry", "read-all");
  hosts.auth.setIdentity(ALICE, { name: nameOf(ALICE) });
  hosts.auth.setIdentity(HOLDER, { name: "Holder" });
  for (const id of PEOPLE) hosts.auth.setIdentity(id, { name: nameOf(id) });
  for (const id of PEOPLE) await makeNoEntityEntry(TRAINING, { userId: id, day: "2026-11-05" });
  for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) await makeNoEntityEntry(TRAINING, { userId: ALICE, day });
  hosts.auth.limitIdentities(LIMIT, WINDOW_MS);

  answers = [];
  const perSub = new Map<string | null, number>();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await realFetch(input, init);
    if (String(input).endsWith("/authz/users/identities")) {
      const header = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null;
      const sub = claimsOf(header)?.["sub"];
      const key = typeof sub === "string" ? sub : null;
      const nth = (perSub.get(key) ?? 0) + 1;
      perSub.set(key, nth);
      answers.push({ sub: key, nth, status: response.status, at: Date.now() });
    }
    return response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

/** Something a person would see as "Unknown user", or a notice that names could not be loaded. */
interface Degraded {
  readonly at: number;
  readonly viewer: string;
  readonly read: string;
  readonly unavailable: unknown;
  readonly unnamed: string[];
}

const SECOND = 1_000;

describe("an ordinary ten minutes stay inside auth's identities budget (AC-4.8, AC-4.7)", () => {
  it("names everyone, and no call is answered 429, for a holder changing filters and an employee using My hours", async () => {
    const start = Date.now();
    const degraded: Degraded[] = [];
    let holderChanges = 0;
    let employeeActions = 0;

    /** Checks the people an answer names: all `active`, with the name `auth` has. */
    const check = (viewer: string, read: string, at: number, body: any) => {
      const people: { id: string; name: string | null; status: string }[] =
        body.items !== undefined
          ? body.items.map((item: any) => item.person)
          : body.groups.filter((group: any) => group.kind === "keyed").map((group: any) => ({ id: group.key, name: group.label, status: group.status }));
      const unnamed = people.filter((person) => person.status !== "active" || person.name !== nameOf(person.id)).map((person) => person.id);
      if ((body.unavailable as string[]).includes("identities") || unnamed.length > 0 || people.length === 0) {
        degraded.push({ at, viewer, read, unavailable: body.unavailable, unnamed: unnamed.slice(0, 3) });
      }
    };

    // One filter change of Everyone's hours: the page, the chosen totals and the Person options, sent at once.
    const holderChange = async (index: number, at: number) => {
      const filters = HOLDER_FILTERS[index % HOLDER_FILTERS.length];
      const [page, chosen, options] = await Promise.all([
        call("GET", `/time-entries?${filters}&whose=all`, { as: "holder" }),
        call("GET", `/time-entries/totals?${filters}&whose=all&groupBy=person`, { as: "holder" }),
        call("GET", `/time-entries/totals?${filters}&whose=all&groupBy=person`, { as: "holder" }),
      ]);
      for (const [read, res] of [["list", page], ["totals", chosen], ["options", options]] as const) {
        expect({ read, status: res.status }).toEqual({ read, status: 200 });
        check("holder", read, at, res.json);
      }
      holderChanges += 1;
    };

    // One action of My hours: every fourth records an entry first (its view names the author, then the list is read again).
    const employeeAction = async (index: number, at: number) => {
      if (index % 4 === 3) {
        const recorded = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-10-08", minutes: 30, on: { type: "none", categoryId: TRAINING } } });
        expect({ read: "record", status: recorded.status }).toEqual({ read: "record", status: 201 });
        const person = recorded.json.person;
        if (person.status !== "active" || person.name !== nameOf(ALICE)) degraded.push({ at, viewer: "alice", read: "record", unavailable: recorded.json.unavailable, unnamed: [person.id] });
      }
      const page = await call("GET", `/time-entries?${OCTOBER}`, { as: "alice" });
      expect({ read: "my list", status: page.status }).toEqual({ read: "my list", status: 200 });
      check("alice", "my list", at, page.json);
      employeeActions += 1;
    };

    // The two timetables merged by simulated time; at the same instant the holder goes first.
    const events = [
      ...Array.from({ length: 40 }, (_, index) => ({ t: index * 15 * SECOND, run: holderChange, index })),
      ...Array.from({ length: 120 }, (_, index) => ({ t: index * 5 * SECOND, run: employeeAction, index })),
    ].sort((a, b) => a.t - b.t || (a.run === holderChange ? -1 : 1));

    for (const event of events) {
      setSystemTime(new Date(start + event.t));
      await event.run(event.index, event.t);
    }

    expect({ holderChanges, employeeActions }).toEqual({ holderChanges: 40, employeeActions: 120 });

    const refused = answers.filter((answer) => answer.status === 429);
    expect({ refusals: refused.length, first: refused[0] === undefined ? null : { sub: refused[0].sub, nth: refused[0].nth, atSeconds: (refused[0].at - start) / SECOND } }).toEqual({
      refusals: 0,
      first: null,
    });
    expect({ degradedReads: degraded.length, first: degraded[0] ?? null }).toEqual({ degradedReads: 0, first: null });

    const calls = (sub: string) => hosts.callsTo("auth.identities").filter((recorded) => claimsOf(recorded.authorization)?.["sub"] === sub);
    // The holder: at most 5 calls to fill the cache (the page's 100 people, and each of the two totals' 150 as 100 + 50)
    // once in each of the ten minutes of 60 s ...
    expect(calls(HOLDER).length).toBeLessThanOrEqual(50);
    // ... and a cache that never forgot would spend only the first minute's: a name is asked again every 60 s.
    expect(calls(HOLDER).length).toBeGreaterThanOrEqual(10);
    // The employee: only herself, one call in each of the ten minutes.
    expect(calls(ALICE).length).toBeLessThanOrEqual(10);
    expect(calls(ALICE).length).toBeGreaterThanOrEqual(10);
    // Every call recorded is a call the clock of the test timed: the last one is inside the ten minutes.
    expect(Math.max(...hosts.calls.map((recorded) => recorded.at)) - start).toBeLessThan(10 * 60 * SECOND);
    // Nothing but the two people's own calls reached the route.
    expect(hosts.callsTo("auth.identities").length).toBe(calls(HOLDER).length + calls(ALICE).length);
  });
});
