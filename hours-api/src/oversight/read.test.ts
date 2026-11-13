/**
 * Reading everyone's hours: `GET /time-entries?whose=all` and `GET /time-entries/totals?whose=all`, and the
 * `userId` filter (specs/029 T19; AC-4.2, AC-4.3, AC-4.4, AC-5.2, AC-5.4; plan § Sequences "Oversight", § Totals
 * "Person filter", ADR-0075, ADR-0088), through the ASSEMBLED app, against the real database and the fake hosts
 * of T11 (the fake `auth` answers `GET /authz/resolve` for each persona).
 *
 * `whose=all` and `userId` are the oversight path: the one place a read asks `auth` whether the caller holds
 * `time-entry:read-all`, live, as the caller. `whose=mine` never does.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, bearerOf, call, db, makeDealEntry, makeMeetingEntry, makeNoEntityEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "./oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const CAROL = PERSONAS.carol.sub;
const TRAINING = SEED.categories.training;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
  // By convention (test-support/world.ts) `holder` holds the permission and nobody else does.
  hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
});

const NOVEMBER = "from=2026-11-01&to=2026-11-30";

const list = (query: string, as: PersonaName | null = "alice", permEpoch?: number) =>
  call("GET", `/time-entries?${query}`, { as, ...(permEpoch !== undefined ? { permEpoch } : {}) });
const totals = (query: string, as: PersonaName | null = "alice", permEpoch?: number) =>
  call("GET", `/time-entries/totals?${query}`, { as, ...(permEpoch !== undefined ? { permEpoch } : {}) });

const idsOf = (res: { json: { items: Array<{ id: string }> } }): string[] => res.json.items.map((item) => item.id);

describe("whose=all or a userId without time-entry:read-all (AC-4.2)", () => {
  it("is 403 read_all_required on the list: no row of anyone's, and no owner is asked", async () => {
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-05" });

    for (const query of [`${NOVEMBER}&whose=all`, `${NOVEMBER}&whose=all&userId=${BOB}`, `${NOVEMBER}&whose=all&userId=${ALICE}`, `${NOVEMBER}&whose=all&dealId=d1`]) {
      const res = await list(query, "alice");
      expect({ query, status: res.status }).toEqual({ query, status: 403 });
      expect(res.json).toMatchObject({ status: 403, code: "read_all_required" });
      expect(res.json).not.toHaveProperty("items");
    }
    // A caller who may not read everyone's hours does not get to make hours-api ask meetings-api about a deal either.
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    expect(hosts.callsTo("auth.identities")).toEqual([]);
  });

  it("is 403 read_all_required on the totals, for every grouping: no group, no total, and no owner is asked", async () => {
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-05" });

    for (const groupBy of ["person", "project", "deal", "category", "month", "day"]) {
      for (const extra of ["&whose=all", `&whose=all&userId=${BOB}`, "&whose=all&dealId=d1"]) {
        const res = await totals(`groupBy=${groupBy}&${NOVEMBER}${extra}`, "alice");
        expect({ groupBy, extra, status: res.status }).toEqual({ groupBy, extra, status: 403 });
        expect(res.json).toMatchObject({ status: 403, code: "read_all_required" });
        expect(res.json).not.toHaveProperty("groups");
        expect(res.json).not.toHaveProperty("totalMinutes");
      }
    }
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    expect(hosts.callsTo("auth.identities")).toEqual([]);
  });

  it("does not take another permission for this one: time-list:manage is not time-entry:read-all", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");

    expect((await list(`${NOVEMBER}&whose=all`, "manager")).json).toMatchObject({ code: "read_all_required" });
    expect((await totals(`groupBy=day&${NOVEMBER}&whose=all`, "manager")).json).toMatchObject({ code: "read_all_required" });
  });
});

describe("whose=all as a holder of time-entry:read-all (AC-4.3, AC-4.4)", () => {
  it("lists the entries of every person: those of welld_ch and of welld_it users alike, newest day first", async () => {
    // hours-api knows no entity: a person's entity is `auth`'s, and the permission is unconditioned (AC-5.2).
    const ch = await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02", minutes: 60 });
    const it = await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-04", minutes: 90 });
    const own = await makeNoEntityEntry(TRAINING, { userId: PERSONAS.holder.sub, day: "2026-11-03", minutes: 30 });
    const outside = await makeNoEntityEntry(TRAINING, { userId: CAROL, day: "2026-12-01", minutes: 30 });

    const res = await list(`${NOVEMBER}&whose=all`, "holder");

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([it.id, own.id, ch.id]);
    expect(idsOf(res)).not.toContain(outside.id);
    expect(res.json.items.map((item: { person: unknown }) => item.person)).toEqual([
      { id: BOB, name: "Name of bob", status: "active" },
      { id: PERSONAS.holder.sub, name: "Name of holder", status: "active" },
      { id: ALICE, name: "Name of alice", status: "active" },
    ]);
  });

  it("narrows to one person with userId", async () => {
    const alices = await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02" });
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-04" });
    await makeNoEntityEntry(TRAINING, { userId: PERSONAS.holder.sub, day: "2026-11-03" });

    const res = await list(`${NOVEMBER}&whose=all&userId=${ALICE}`, "holder");

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([alices.id]);
    // A person nobody has entries for is an empty answer, not an error.
    expect((await list(`${NOVEMBER}&whose=all&userId=nobody`, "holder")).json).toEqual({ items: [], nextCursor: null, unavailable: [] });
  });

  it("pages with the cursor over everyone's entries, each exactly once", async () => {
    for (const [index, userId] of [ALICE, BOB, CAROL, ALICE, BOB].entries()) {
      await makeNoEntityEntry(TRAINING, { userId, day: `2026-11-0${index + 1}` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Awaited<ReturnType<typeof list>> = await list(`${NOVEMBER}&whose=all&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`, "holder");
      expect(res.status).toBe(200);
      seen.push(...idsOf(res));
      cursor = res.json.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("names projects, deals and meetings as the HOLDER reads them, whoever recorded the entry (AC-4.10)", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.projects.setReader(PERSONAS.holder.sub, false);
    hosts.crm.setDeal("d1", { label: "Deal one" });
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-03" });
    await makeDealEntry("d1", { userId: CAROL, day: "2026-11-02" });

    const res = await list(`${NOVEMBER}&whose=all`, "holder");

    expect(res.status).toBe(200);
    // D44: the id of a record the holder may not read is withheld on someone else's entry; one they may read keeps it.
    expect(res.json.items.map((item: { on: unknown }) => item.on)).toEqual([
      expect.objectContaining({ type: "project", id: null, label: null, visibility: "hidden" }),
      expect.objectContaining({ type: "deal", id: "d1", label: "Deal one", visibility: "visible" }),
    ]);
    const holderToken = await bearerOf("holder");
    for (const recorded of [...hosts.callsTo("projects.resolve"), ...hosts.callsTo("crm.resolve")]) {
      expect(recorded.authorization).toBe(holderToken);
    }
  });
});

/** What a 400 of the router says: `invalid_request`, and the member it names. */
const expectInvalid = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ code: "invalid_request", field });
};

describe("a userId outside the id rule (plan § Entries, 'The id rule')", () => {
  it("is 400 naming userId on the list and the totals, for a holder and a non-holder alike, and auth is never asked", async () => {
    for (const as of ["alice", "holder"] as const) {
      for (const userId of ["", "x".repeat(65), "%00", "a%2Cb", "%20a", "a%20"]) {
        expectInvalid(await list(`${NOVEMBER}&whose=all&userId=${userId}`, as), "userId");
        expectInvalid(await totals(`groupBy=person&${NOVEMBER}&whose=all&userId=${userId}`, as), "userId");
      }
      expectInvalid(await list(`${NOVEMBER}&whose=all&userId=a&userId=b`, as), "userId");
      expectInvalid(await totals(`groupBy=person&${NOVEMBER}&whose=all&userId=a&userId=a`, as), "userId");
    }
    expect(hosts.calls).toEqual([]);
  });

  it("takes an id of exactly 64 characters, and asks auth then (a holder: an empty answer; anyone else: 403)", async () => {
    const userId = "x".repeat(64);

    expect((await list(`${NOVEMBER}&whose=all&userId=${userId}`, "holder")).json).toEqual({ items: [], nextCursor: null, unavailable: [] });
    expect((await list(`${NOVEMBER}&whose=all&userId=${userId}`, "alice")).status).toBe(403);
  });

  it("is a 400 for whose=mine too, even for a holder, and before auth could be asked", async () => {
    expectInvalid(await list(`${NOVEMBER}&userId=${BOB}`, "holder"), "userId");
    expectInvalid(await totals(`groupBy=person&${NOVEMBER}&whose=mine&userId=${BOB}`, "holder"), "userId");
    expect(hosts.calls).toEqual([]);
  });
});

describe("the dealId filter under oversight (AC-2.6, AC-4.11)", () => {
  it("is asked of meetings-api only once the caller holds the permission, as a holder includes everyone's entries on the deal and on its meetings", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: "m1", creator: BOB });
    hosts.meetings.relink("m1", "d1");
    hosts.meetings.add({ id: "m2", creator: CAROL });
    const onDeal = await makeDealEntry("d1", { userId: ALICE, day: "2026-11-03" });
    const onMeeting = await makeMeetingEntry("m1", { userId: BOB, day: "2026-11-04" });
    await makeMeetingEntry("m2", { userId: CAROL, day: "2026-11-05" });

    const refused = await list(`${NOVEMBER}&whose=all&dealId=d1`, "alice");
    expect(refused.status).toBe(403);
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);

    const res = await list(`${NOVEMBER}&whose=all&dealId=d1`, "holder");
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([onMeeting.id, onDeal.id]);
    expect(hosts.callsTo("meetings.system-hosts").map((recorded) => recorded.query.get("dealId"))).toContain("d1");

    const sum = await totals(`groupBy=deal&${NOVEMBER}&whose=all&dealId=d1`, "holder");
    expect(sum.json.groups).toEqual([{ kind: "keyed", key: "d1", label: "Deal one", minutes: 120 }]);
  });

  it("is refused 503 host_unavailable for a holder while meetings-api cannot say which meetings are linked, with nothing partial — and not for the holder's own hours' sake", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    await makeDealEntry("d1", { userId: ALICE, day: "2026-11-03" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    for (const res of [await list(`${NOVEMBER}&whose=all&dealId=d1`, "holder"), await totals(`groupBy=day&${NOVEMBER}&whose=all&dealId=d1`, "holder")]) {
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "host_unavailable" });
      expect(res.json).not.toHaveProperty("items");
      expect(res.json).not.toHaveProperty("groups");
      // A read says what it could not say; it is not the write's "nothing was saved".
      expect(res.json.detail).not.toMatch(/saved|record hours/i);
    }
  });

  it("is a 503 authz_unavailable, not host_unavailable, when auth is the one that is down: the oversight answer comes first", async () => {
    hosts.fail("meetings.system-hosts", { status: 500 });
    hosts.sever("auth");

    const res = await list(`${NOVEMBER}&whose=all&dealId=d1`, "holder");

    expect(res.status).toBe(503);
    expect(res.json.code).toBe("authz_unavailable");
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
  });
});

describe("an auth that cannot answer (AC-5.4, ADR-0014 posture)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["a 500", () => hosts.fail("auth.resolve", { status: 500 })],
    ["a 502", () => hosts.fail("auth.resolve", { status: 502 })],
    ["a 401", () => hosts.fail("auth.resolve", { status: 401 })],
    ["a 200 that is not JSON", () => hosts.fail("auth.resolve", { rawBody: "<html>gateway</html>" })],
    ["a 200 whose permissions are not a list", () => hosts.fail("auth.resolve", { body: { permissions: "everything" } })],
    ["a 200 with no permissions member", () => hosts.fail("auth.resolve", { body: { sub: "user-holder" } })],
    ["a 200 listing something that is not a permission", () => hosts.fail("auth.resolve", { body: { permissions: [null, 3] } })],
    ["a redirect", () => hosts.fail("auth.resolve", { redirect: true })],
    ["an unreachable auth", () => hosts.sever("auth")],
  ];

  it("fails closed on an auth that does not answer within 2 s (R2): 503 authz_unavailable, not a hung request", async () => {
    hosts.fail("auth.resolve", { delayMs: 2_600 });

    // A call that waited for the 2.6 s answer would be a 200 (the holder is granted): only the timeout makes this a 503.
    const res = await list(`${NOVEMBER}&whose=all`, "holder");

    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
  });

  for (const [outage, cause] of OUTAGES) {
    it(`fails closed on ${outage}: whose=all and a userId are 503 authz_unavailable, even for a holder, with nothing returned`, async () => {
      await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-05" });
      cause();

      for (const res of [
        await list(`${NOVEMBER}&whose=all`, "holder"),
        await list(`${NOVEMBER}&whose=all&userId=${BOB}`, "holder"),
        await totals(`groupBy=person&${NOVEMBER}&whose=all`, "holder"),
        await totals(`groupBy=day&${NOVEMBER}&whose=all&userId=${BOB}`, "holder"),
      ]) {
        expect(res.status).toBe(503);
        expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
        expect(res.json).not.toHaveProperty("items");
        expect(res.json).not.toHaveProperty("groups");
      }
    });
  }

  it("is read as neither a grant nor a refusal: a redirect is not followed, and the next call is decided by what auth then says", async () => {
    hosts.fail("auth.resolve", { redirect: true, times: 1 });
    expect((await list(`${NOVEMBER}&whose=all`, "holder")).status).toBe(503);
    expect(hosts.elsewhere).toHaveLength(0);

    // Had the outage been remembered as a refusal, this would be a cached 403 with no call to auth.
    expect((await list(`${NOVEMBER}&whose=all`, "holder")).status).toBe(200);
  });

  it("does not touch whose=mine: the caller's own hours are listed and totalled with auth down, and auth is never asked", async () => {
    const mine = await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-05", minutes: 60 });
    hosts.sever("auth");

    for (const query of [NOVEMBER, `${NOVEMBER}&whose=mine`]) {
      const res = await list(query, "alice");
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([mine.id]);
    }
    const sum = await totals(`groupBy=day&${NOVEMBER}`, "alice");
    expect(sum.status).toBe(200);
    expect(sum.json.totalMinutes).toBe(60);
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });

  it("does not ask auth for whose=mine even once: the holder's own hours need no permission either", async () => {
    await list(NOVEMBER, "holder");
    await totals(`groupBy=day&${NOVEMBER}`, "holder");
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });
});

describe("the totals of whose=all as a holder (AC-4.3, AC-4.5; plan § Totals 'Person filter')", () => {
  /** What the person filter's options are: `groupBy=person` with the view's other filters and NO userId. */
  const people = async (extra = "") => (await totals(`groupBy=person&${NOVEMBER}&whose=all${extra}`, "holder")).json;

  it("adds up everyone's hours, and narrows to one person with userId", async () => {
    await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02", minutes: 60 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-02", minutes: 90 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-03", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { userId: CAROL, day: "2026-12-02", minutes: 480 });

    const everyone = await totals(`groupBy=day&${NOVEMBER}&whose=all`, "holder");
    expect(everyone.status).toBe(200);
    expect(everyone.json).toEqual({
      totalMinutes: 180,
      groups: [
        { kind: "keyed", key: "2026-11-03", label: null, minutes: 30 },
        { kind: "keyed", key: "2026-11-02", label: null, minutes: 150 },
      ],
      unavailable: [],
    });

    const bobs = await totals(`groupBy=day&${NOVEMBER}&whose=all&userId=${BOB}`, "holder");
    expect(bobs.json).toEqual({
      totalMinutes: 120,
      groups: [
        { kind: "keyed", key: "2026-11-03", label: null, minutes: 30 },
        { kind: "keyed", key: "2026-11-02", label: null, minutes: 90 },
      ],
      unavailable: [],
    });
  });

  it("lists every person with hours in the span as a `person` group, `key` a user id that works as userId, named as auth names them now", async () => {
    await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02", minutes: 60 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-02", minutes: 120 });
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-03", minutes: 30 });
    await makeNoEntityEntry(TRAINING, { userId: CAROL, day: "2026-12-02", minutes: 480 });
    hosts.auth.setIdentity(BOB, { name: "Bob Renamed" });

    const answer = await people();

    expect(answer).toEqual({
      totalMinutes: 210,
      // By label (the collator of plan § Totals), not by id: the renamed person sorts first.
      groups: [
        { kind: "keyed", key: BOB, label: "Bob Renamed", minutes: 150, status: "active" },
        { kind: "keyed", key: ALICE, label: "Name of alice", minutes: 60, status: "active" },
      ],
      unavailable: [],
    });
    // Each key is the value to send as `userId`, and gives that person's own figure.
    for (const group of answer.groups) {
      const own = await totals(`groupBy=person&${NOVEMBER}&whose=all&userId=${group.key}`, "holder");
      expect(own.json.groups).toEqual([group]);
    }
  });

  it("is complete: more people than one list page holds are all there, though the list is paged", async () => {
    const PEOPLE = 130;
    await db.timeEntry.createMany({
      data: Array.from({ length: PEOPLE }, (_, index) => ({
        userId: `user-bulk-${String(index).padStart(3, "0")}`,
        day: new Date("2026-11-02T00:00:00Z"),
        minutes: 30,
        target: "none" as const,
        categoryId: TRAINING,
      })),
    });

    const page = await list(`${NOVEMBER}&whose=all`, "holder");
    expect(page.json.items).toHaveLength(100);
    expect(page.json.nextCursor).not.toBeNull();

    const answer = await people();
    expect(answer.groups).toHaveLength(PEOPLE);
    expect(new Set(answer.groups.map((group: { key: string }) => group.key)).size).toBe(PEOPLE);
    expect(answer.totalMinutes).toBe(PEOPLE * 30);
    expect(answer.groups.every((group: { minutes: number }) => group.minutes === 30)).toBe(true);
  });

  it("keeps the people when identities fails: `label: null`, `status: \"unknown\"`, and `identities` named", async () => {
    await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02", minutes: 60 });
    await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-02", minutes: 30 });
    hosts.fail("auth.identities", { status: 500 });

    const res = await totals(`groupBy=person&${NOVEMBER}&whose=all`, "holder");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      totalMinutes: 90,
      groups: [
        { kind: "keyed", key: ALICE, label: null, minutes: 60, status: "unknown" },
        { kind: "keyed", key: BOB, label: null, minutes: 30, status: "unknown" },
      ],
      unavailable: ["identities"],
    });
  });

  it("applies the view's other filters to the people, and asks only the sources its grouping needs", async () => {
    await makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-02", minutes: 60 });
    await makeNoEntityEntry(SEED.categories.administration, { userId: BOB, day: "2026-11-02", minutes: 30 });

    const answer = await people(`&categoryId=${TRAINING}`);

    expect(answer.groups.map((group: { key: string }) => group.key)).toEqual([ALICE]);
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
    expect(hosts.callsTo("crm.resolve")).toEqual([]);
  });

  it("names projects and deals as the HOLDER reads them, whoever recorded the hours (AC-4.10)", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.projects.setReader(PERSONAS.holder.sub, false);
    hosts.projects.setReader(BOB, true);
    await makeProjectEntry("p1", { userId: BOB, minutes: 60 });
    await makeDealEntry("d1", { userId: BOB, minutes: 30 });

    const byProject = await totals(`groupBy=project&${NOVEMBER}&whose=all`, "holder");
    const byDeal = await totals(`groupBy=deal&${NOVEMBER}&whose=all`, "holder");

    expect(byProject.json.groups).toEqual([{ kind: "hidden", minutes: 60 }, { kind: "none", minutes: 30 }]);
    expect(byDeal.json.groups).toEqual([{ kind: "keyed", key: "d1", label: "Deal one", minutes: 30 }, { kind: "none", minutes: 60 }]);
    expect(JSON.stringify(byProject.json)).not.toContain("Alpha");
  });
});
