import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { LIST_NAMES_WAIT_MS } from "../lib/identities";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-10.1, AC-10.2, AC-10.3, AC-11.5 (specs/20261104-meetings T23): "My meetings", the list every signed-in
// user gets: creator or Operai participant only, filters, 25 a page, newest first, host labels.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  kit.grant("alice", "access");
  kit.grant("bob", "access");
  kit.grant("admin", "access", "erase", "template");
  kit.grant("guest"); // a participant with no grants at all (AC-10.1, AC-10.4)
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
let n = 0;
async function seed(over: Record<string, unknown> = {}) {
  n += 1;
  return kit.db.meeting.create({
    data: {
      title: `Meeting ${n}`,
      format: "online",
      startsAt: new Date(Date.UTC(2026, 10, 1, 9, 0, n)),
      language: "en",
      source: "recorded",
      status: "ready",
      creatorUserId: "alice",
      ...over,
    } as never,
  });
}
const list = (who: string | null, query = "") => kit.call(who, "GET", `/meetings${query}`);
const titles = (body: Record<string, any>) => body["items"].map((i: { title: string }) => i.title);
const W1 = { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1" };

describe("who sees what (AC-10.1)", () => {
  it("lists the caller's meetings as creator or Operai participant, newest first, with the role", async () => {
    await seed({ title: "Older mine", startsAt: new Date("2026-10-01T09:00:00Z") });
    await seed({ title: "Newer mine", startsAt: new Date("2026-10-03T09:00:00Z") });
    await seed({ title: "Invited", creatorUserId: "bob", startsAt: new Date("2026-10-02T09:00:00Z"), participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    await seed({ title: "Bob's private", creatorUserId: "bob" });
    // readable through a host, but a list is creator or participant only
    await seed({ title: "Bob's host-visible", creatorUserId: "bob", hostVisible: true, ...W1 });
    // an external participant is not an account
    await seed({ title: "External", creatorUserId: "bob", participants: { create: [{ externalName: "alice", addedBy: "bob" }] } });

    const res = await list("alice");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(titles(body)).toEqual(["Newer mine", "Invited", "Older mine"]);
    expect(body["items"].map((i: { role: string }) => i.role)).toEqual(["creator", "participant", "creator"]);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(Object.keys(body["items"][0]).sort()).toEqual(["creator", "folderId", "format", "host", "id", "role", "startsAt", "status", "summaryCount", "title"]);
    expect(body["items"][0]).toMatchObject({ format: "online", status: "ready", host: null, summaryCount: 0, creator: { id: "alice", name: "Name alice", status: "active" } });
  });

  it("an administrator and an erase holder see only their own meetings (AC-4.8)", async () => {
    await seed({ title: "Alice's" });
    expect(await json(await list("admin"))).toMatchObject({ items: [], total: 0 });
    await seed({ title: "Admin's own", creatorUserId: "admin" });
    expect(titles(await json(await list("admin")))).toEqual(["Admin's own"]);
  });

  it("a participant with no grants, or with auth down, still gets the list (AC-10.1, AC-10.6)", async () => {
    await seed({ title: "Invited", creatorUserId: "bob", participants: { create: [{ userId: "guest", addedBy: "bob" }] } });
    expect(titles(await json(await list("guest")))).toEqual(["Invited"]);
    kit.setAuthDown(true);
    const res = await list("guest");
    expect(res.status).toBe(200);
    expect(titles(await json(res))).toEqual(["Invited"]);
  });

  it("is 401 without a token", async () => {
    expect((await list(null)).status).toBe(401);
  });
});

describe("filters (AC-10.2)", () => {
  beforeEach(async () => {
    await seed({ title: "Budget Q4", status: "ready", ...W1 });
    await seed({ title: "Retro", status: "draft" });
    await seed({ title: "Budget sync", creatorUserId: "bob", status: "processing", participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    await seed({ title: "Hiring", creatorUserId: "bob", status: "ready", participants: { create: [{ userId: "alice", addedBy: "bob" }] }, hostApp: "quiethost", hostEntityType: "gadget", hostEntityId: "g1" });
  });
  const only = async (query: string) => titles(await json(await list("alice", query))).sort();

  it("q is a case-insensitive substring of the title", async () => {
    expect(await only("?q=bUdGeT")).toEqual(["Budget Q4", "Budget sync"]);
    expect(await only("?q=nothing")).toEqual([]);
  });

  it("q takes % and _ literally", async () => {
    await seed({ title: "100% done" });
    await seed({ title: "100x done" });
    expect(await only("?q=%25")).toEqual(["100% done"]);
    expect(await only("?q=0_%20")).toEqual([]);
  });

  it("role", async () => {
    expect(await only("?role=creator")).toEqual(["Budget Q4", "Retro"]);
    expect(await only("?role=participant")).toEqual(["Budget sync", "Hiring"]);
  });

  it("status", async () => {
    expect(await only("?status=ready")).toEqual(["Budget Q4", "Hiring"]);
    expect(await only("?status=draft")).toEqual(["Retro"]);
    expect(await only("?status=processing")).toEqual(["Budget sync"]);
    expect(await only("?status=failed")).toEqual([]);
  });

  it("hostApp", async () => {
    expect(await only("?hostApp=testhost")).toEqual(["Budget Q4"]);
    expect(await only("?hostApp=quiethost")).toEqual(["Hiring"]);
    expect(await only("?hostApp=nohost")).toEqual([]);
  });

  it("combined filters intersect, and total counts the filtered set", async () => {
    expect(await only("?q=budget&role=participant")).toEqual(["Budget sync"]);
    expect(await only("?q=budget&status=ready")).toEqual(["Budget Q4"]);
    expect(await only("?status=ready&role=participant&hostApp=quiethost")).toEqual(["Hiring"]);
    expect((await json(await list("alice", "?status=ready")))["total"]).toBe(2);
  });

  it("422 for a value outside the set, and for a page that is not one", async () => {
    for (const query of ["?role=admin", "?status=done", "?page=0", "?page=x"]) expect((await list("alice", query)).status).toBe(422);
  });
});

describe("derived status", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  async function recording(title: string, session: { lastBeatAt: Date; lastChunkAt?: Date; endedAt?: Date } | null) {
    const m = await seed({ title, status: "recording" });
    if (session) await kit.db.recordingSession.create({ data: { meetingId: m.id, ...session } });
    return m;
  }

  it("status=interrupted and status=recording partition the stored recordings by the 2 minute rule (AC-2.8)", async () => {
    await recording("Live beat", { lastBeatAt: minutesAgo(0.5) });
    await recording("Live chunk", { lastBeatAt: minutesAgo(5), lastChunkAt: minutesAgo(1) });
    await recording("Silent", { lastBeatAt: minutesAgo(3) });
    await recording("Ended", { lastBeatAt: minutesAgo(0.1), endedAt: minutesAgo(0.1) });
    await recording("No session", null);
    await seed({ title: "Ready one" });

    const titlesFor = async (status: string) => titles(await json(await list("alice", `?status=${status}`))).sort();
    expect(await titlesFor("recording")).toEqual(["Live beat", "Live chunk"]);
    expect(await titlesFor("interrupted")).toEqual(["Ended", "No session", "Silent"]);
    // and each row reports what the filter matched
    const all = await json(await list("alice"));
    const status = (t: string) => all["items"].find((i: { title: string }) => i.title === t).status;
    expect([status("Live beat"), status("Silent"), status("Ready one")]).toEqual(["recording", "interrupted", "ready"]);
    expect(all["total"]).toBe(6);
  });

  it("counts summaries per row", async () => {
    const m = await seed({ title: "With summaries" });
    for (let i = 0; i < 2; i++) await kit.db.summary.create({ data: { meetingId: m.id, authorUserId: "alice", template: {}, language: "en", status: "ready", attemptId: `a${i}`, transcriptVersion: 0 } });
    expect((await json(await list("alice")))["items"][0].summaryCount).toBe(2);
  });
});

describe("paging", () => {
  it("25 a page, newest first, nothing repeated", async () => {
    let last = "";
    for (let i = 0; i < 27; i++) last = (await seed()).title;
    const first = await json(await list("alice"));
    const second = await json(await list("alice", "?page=2"));
    const third = await json(await list("alice", "?page=3"));
    expect([first["items"].length, second["items"].length, third["items"].length, first["total"]]).toEqual([25, 2, 0, 27]);
    expect(new Set([...first["items"], ...second["items"]].map((i: { id: string }) => i.id)).size).toBe(27);
    expect(first["items"][0].title).toBe(last);
  });
});

describe("host labels (AC-10.3, AC-11.5)", () => {
  async function arrange() {
    kit.fake.setEntity("widget", "shut", { title: "Secret", href: "/x", state: "closed" });
    kit.fake.setEntity("gadget", "g1", { title: "Gadget one", href: "/q/g1" });
    await seed({ title: "open", ...W1 });
    await seed({ title: "open again", ...W1 });
    await seed({ title: "closed", hostApp: "testhost", hostEntityType: "widget", hostEntityId: "shut" });
    await seed({ title: "missing", hostApp: "testhost", hostEntityType: "widget", hostEntityId: "ghost" });
    await seed({ title: "quiet", hostApp: "quiethost", hostEntityType: "gadget", hostEntityId: "g1" });
    await seed({ title: "unregistered", hostApp: "oldhost", hostEntityType: "thing", hostEntityId: "t1" });
    await seed({ title: "standalone" });
  }
  const hostOf = (body: Record<string, any>, title: string) => body["items"].find((i: { title: string }) => i.title === title).host;

  it("open, closed, missing and unavailable come out right, with one resolve call per host per page", async () => {
    await arrange();
    const body = await json(await list("alice"));
    expect(hostOf(body, "open")).toEqual({ app: "testhost", entityType: "widget", entityId: "w1", state: "open", title: "Widget one", href: "/testhost/widgets/w1" });
    expect(hostOf(body, "open again").state).toBe("open");
    expect(hostOf(body, "closed")).toMatchObject({ state: "closed", title: null, href: null });
    expect(hostOf(body, "missing")).toMatchObject({ state: "missing", title: null, href: null });
    expect(hostOf(body, "quiet")).toMatchObject({ state: "open", title: "Gadget one" });
    expect(hostOf(body, "unregistered")).toMatchObject({ state: "unavailable", title: null });
    expect(hostOf(body, "standalone")).toBeNull();

    // testhost/widget: one call for w1, shut and ghost together; quiethost/gadget: one call
    const calls = kit.fake.resolves.map((r) => `${r.path} ${[...r.body.ids].sort().join(",")}`).sort();
    expect(calls).toEqual(["/quiethost/meeting-host/v1/resolve g1", "/testhost/meeting-host/v1/resolve ghost,shut,w1"]);
  });

  it("resolves as the caller, so a closed-for-me entity reads closed", async () => {
    kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/x", stateFor: { alice: "closed" } });
    await seed({ title: "open", ...W1 });
    expect(hostOf(await json(await list("alice")), "open")).toMatchObject({ state: "closed", title: null });
  });

  it("a host that cannot answer fails soft: the list still comes, labels read unavailable", async () => {
    await arrange();
    kit.fake.mode.resolve = { status: 503 };
    const res = await list("alice");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["items"].length).toBe(7);
    expect(hostOf(body, "open")).toMatchObject({ state: "unavailable", title: null });
  });

  it("makes no host call for a page of standalone meetings", async () => {
    await seed();
    await list("alice");
    expect(kit.fake.resolves).toHaveLength(0);
  });
});

// AC-2.5, AC-2.10 (specs/20261112-time-tracking T8): `ids` is one more filter on the caller's OWN list. hours-api asks
// "may this person record hours on this meeting?" with it (and reads the title with it), so a meeting the
// caller may only read through its host, and one that does not exist, must come back the same: absent.
describe("ids filter (specs/20261112-time-tracking AC-2.5, AC-2.10)", () => {
  const ids = (...asked: string[]) => `?ids=${asked.join(",")}`;
  const idsOf = (body: Record<string, any>) => body["items"].map((i: { id: string }) => i.id).sort();

  it("returns only the asked-for meetings the caller created or is an Operai participant of, as unchanged rows", async () => {
    const mine = await seed({ title: "Mine" });
    const invited = await seed({ title: "Invited", creatorUserId: "bob", participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    const notAsked = await seed({ title: "Mine, not asked for" });
    const bobs = await seed({ title: "Bob's private", creatorUserId: "bob" });
    const external = await seed({ title: "External", creatorUserId: "bob", participants: { create: [{ externalName: "alice", addedBy: "bob" }] } });

    const res = await list("alice", ids(mine.id, invited.id, bobs.id, external.id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(idsOf(body)).toEqual([invited.id, mine.id].sort());
    expect(idsOf(body)).not.toContain(notAsked.id);
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    // the very same row the unfiltered list gives, not a slimmer one
    expect(Object.keys(body["items"][0]).sort()).toEqual(["creator", "folderId", "format", "host", "id", "role", "startsAt", "status", "summaryCount", "title"]);
    const unfiltered = await json(await list("alice"));
    for (const row of body["items"]) expect(row).toEqual(unfiltered["items"].find((i: { id: string }) => i.id === row.id));
    expect(body["items"].find((i: { id: string }) => i.id === mine.id)).toMatchObject({ role: "creator" });
    expect(body["items"].find((i: { id: string }) => i.id === invited.id)).toMatchObject({ role: "participant" });
  });

  it("a meeting the caller reads only as a host reader, someone else's private one and an unknown id are absent alike (AC-2.10)", async () => {
    const hostOnly = await seed({ title: "Host-visible", creatorUserId: "bob", hostVisible: true, ...W1 });
    const bobs = await seed({ title: "Private", creatorUserId: "bob" });
    const mine = await seed({ title: "Mine" });
    // the premise: she opens the first one, through its host, and the second not at all
    const opened = await kit.call("alice", "GET", `/meetings/${hostOnly.id}`);
    expect(opened.status).toBe(200);
    expect(await json(opened)).toMatchObject({ id: hostOnly.id, role: "host_reader" });
    expect((await kit.call("alice", "GET", `/meetings/${bobs.id}`)).status).toBe(404);

    const unknown = await list("alice", ids("no-such-meeting"));
    expect(unknown.status).toBe(200);
    const nothing = await json(unknown);
    expect(nothing).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    for (const id of [hostOnly.id, bobs.id]) {
      const res = await list("alice", ids(id));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual(nothing);
    }
    // asked together with her own, still only her own comes back
    expect(idsOf(await json(await list("alice", ids(hostOnly.id, bobs.id, "no-such-meeting", mine.id))))).toEqual([mine.id]);
  });

  it("25 ids are fine, 26 are a 422 whatever they are (a duplicate counts)", async () => {
    const mine = await seed({ title: "Mine" });
    const unknown = (n: number) => Array.from({ length: n }, (_, i) => `ghost${i}`);
    const ok = await list("alice", ids(mine.id, ...unknown(24)));
    expect(ok.status).toBe(200);
    expect(idsOf(await json(ok))).toEqual([mine.id]);
    const tooMany = await list("alice", ids(mine.id, ...unknown(25)));
    expect(tooMany.status).toBe(422);
    expect(((await json(tooMany)) as { status: number }).status).toBe(422);
    expect((await list("alice", ids(...Array.from({ length: 26 }, () => mine.id)))).status).toBe(422);
  });

  it("answers with auth down, and for a participant who holds no grant at all (AC-10.6, selfScoped)", async () => {
    const invited = await seed({ title: "Invited", creatorUserId: "bob", participants: { create: [{ userId: "guest", addedBy: "bob" }] } });
    const other = await seed({ title: "Bob's", creatorUserId: "bob" });
    kit.setAuthDown(true);
    const res = await list("guest", ids(invited.id, other.id));
    expect(res.status).toBe(200);
    expect(idsOf(await json(res))).toEqual([invited.id]);
  });

  it("names each meeting once however often it is asked for, and trims the ids", async () => {
    const a = await seed({ title: "A" });
    const b = await seed({ title: "B" });
    const body = await json(await list("alice", `?ids=${a.id},${a.id},%20${b.id}%20,${a.id}`));
    expect(idsOf(body)).toEqual([a.id, b.id].sort());
    expect(body["total"]).toBe(2);
  });

  it("is one more filter: it intersects with the others, newest first, and total counts the intersection", async () => {
    const draft = await seed({ title: "Mine, draft", status: "draft", startsAt: new Date("2026-10-01T09:00:00Z") });
    const ready = await seed({ title: "Mine, ready", status: "ready", startsAt: new Date("2026-10-02T09:00:00Z") });
    const invited = await seed({ title: "Invited, ready", creatorUserId: "bob", status: "ready", startsAt: new Date("2026-10-03T09:00:00Z"), participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    const all = ids(draft.id, ready.id, invited.id);
    expect(titles(await json(await list("alice", all)))).toEqual(["Invited, ready", "Mine, ready", "Mine, draft"]);
    expect(titles(await json(await list("alice", `${all}&status=ready`)))).toEqual(["Invited, ready", "Mine, ready"]);
    const narrow = await json(await list("alice", `${all}&status=ready&role=participant`));
    expect(titles(narrow)).toEqual(["Invited, ready"]);
    expect(narrow["total"]).toBe(1);
    expect(await json(await list("alice", `${all}&q=nothing`))).toMatchObject({ items: [], total: 0 });
    // a second page of at most 25 ids is empty, with the total still the answer's size
    expect(await json(await list("alice", `${all}&page=2`))).toMatchObject({ items: [], total: 3, page: 2 });
  });

  it("an id that cannot be stored, a NUL byte, is no meeting and no server error", async () => {
    const mine = await seed({ title: "Mine" });
    const res = await list("alice", `?ids=${mine.id},a%00b`);
    expect(res.status).toBe(200);
    expect(idsOf(await json(res))).toEqual([mine.id]);
  });

  it("an empty list, an empty member, an id over 64 characters and a repeated parameter are a 422, never 'no filter'", async () => {
    await seed({ title: "Mine" });
    expect((await list("alice", ids("x".repeat(64)))).status).toBe(200);
    for (const query of ["?ids=", "?ids=a,,b", "?ids=a,", "?ids=,a", "?ids=%20", `?ids=${"x".repeat(65)}`, "?ids=a&ids=b"]) {
      expect([query, (await list("alice", query)).status]).toEqual([query, 422]);
    }
  });
});

// specs/20261126-teams R13 b (ADR 20261119-on-demand-outbound-work-..., rule 7): hours-api asks `GET /meetings?ids=` inside 6 s. The list reads no
// permission, so it makes no permission call (`jwtOnly`), and it waits at most `LIST_NAMES_WAIT_MS` for its creators' names.
describe("the list inside another service's deadline (R13 b)", () => {
  const settle = () => new Promise<void>((done) => setTimeout(done, 30));

  it("makes no /authz/resolve call, and answers normally while auth holds every resolve", async () => {
    const mine = await seed({ title: "Mine" });
    kit.holdResolve(new Promise<void>(() => {})); // never answers: a resolve made here would hang
    const started = Date.now();
    const res = await list("alice", `?ids=${mine.id}`);
    expect(res.status).toBe(200);
    expect(titles(await json(res))).toEqual(["Mine"]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(kit.resolveCalls()).toBe(0);
    // the unfiltered list too: the same guard
    expect((await list("alice")).status).toBe(200);
    expect(kit.resolveCalls()).toBe(0);
  });

  it("still returns only the caller's own meetings, whatever else they hold: a non-participant gets nothing (ADR 20261104-meetings-tool-shape-visibility-by-participation)", async () => {
    const bobs = await seed({ title: "Bob's private", creatorUserId: "bob" });
    const hostVisible = await seed({ title: "Bob's host-visible", creatorUserId: "bob", hostVisible: true, ...W1 });
    const external = await seed({ title: "External", creatorUserId: "bob", participants: { create: [{ externalName: "carol", addedBy: "bob" }] } });
    const invited = await seed({ title: "Invited", creatorUserId: "bob", participants: { create: [{ userId: "guest", addedBy: "bob" }] } });
    const asked = `?ids=${[bobs.id, hostVisible.id, external.id, invited.id].join(",")}`;

    // everyone with every grant, an administrator and an erase holder among them, a stranger and a host reader: nothing of Bob's
    for (const who of ["alice", "admin"]) {
      expect(await json(await list(who, asked))).toMatchObject({ items: [], total: 0 });
      expect(await json(await list(who))).toMatchObject({ items: [], total: 0 });
    }
    // the participant sees exactly the meeting they were added to
    expect(titles(await json(await list("guest", asked)))).toEqual(["Invited"]);
    // and a caller with no grant at all, auth held, the same
    kit.holdResolve(new Promise<void>(() => {}));
    expect(titles(await json(await list("guest", asked)))).toEqual(["Invited"]);
    expect(kit.resolveCalls()).toBe(0);
  });

  it("waits at most 800 ms for the creators' names: a slow auth gives status unknown and the next call names them with no call", async () => {
    const mine = await seed({ title: "Mine", creatorUserId: "bob", participants: { create: [{ userId: "alice", addedBy: "bob" }] } });
    let release!: () => void;
    kit.holdIdentities(new Promise<void>((done) => (release = done))); // auth answers when the test says so (about 3 s in a real outage)
    try {
      const started = Date.now();
      const res = await list("alice", `?ids=${mine.id}`);
      const took = Date.now() - started;
      expect(res.status).toBe(200);
      expect(took).toBeGreaterThanOrEqual(LIST_NAMES_WAIT_MS - 20);
      expect(took).toBeLessThan(1_500);
      expect((await json(res))["items"][0].creator).toEqual({ id: "bob", name: null, status: "unknown" });
      expect(kit.identityCalls).toHaveLength(1);
    } finally {
      release();
    }
    await settle(); // the lookup, not aborted, fills the cache
    const next = await list("alice", `?ids=${mine.id}`);
    expect((await json(next))["items"][0].creator).toEqual({ id: "bob", name: "Name bob", status: "active" });
    expect(kit.identityCalls).toHaveLength(1);
  });

  it("answers at once when auth is fast", async () => {
    const mine = await seed({ title: "Mine" });
    const started = Date.now();
    const res = await list("alice", `?ids=${mine.id}`);
    expect(Date.now() - started).toBeLessThan(LIST_NAMES_WAIT_MS / 2);
    expect((await json(res))["items"][0].creator.name).toBe("Name alice");
  });
});

// A control on the list would need the permissions it no longer resolves: the day one is added, the route moves back to `selfScoped`.
describe("the list reads no permission (static)", () => {
  const FORBIDDEN = ["holds(", 'c.get("authz")', "capabilities", "callerOf", "selfScoped"];
  const problemsOf = (source: string) => FORBIDDEN.filter((word) => source.includes(word));
  const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

  it("list.routes.ts and rows.ts name none of holds(, c.get(\"authz\"), capabilities, callerOf, selfScoped", () => {
    expect({ file: "list.routes.ts", problems: problemsOf(read("list.routes.ts")) }).toEqual({ file: "list.routes.ts", problems: [] });
    expect({ file: "rows.ts", problems: problemsOf(read("rows.ts")) }).toEqual({ file: "rows.ts", problems: [] });
  });

  it("the check can fail", () => {
    expect(problemsOf("if (holds(c, X)) {}")).toEqual(["holds("]);
    expect(problemsOf('c.get("authz"); const caller = callerOf(c); middleware: selfScoped')).toEqual(['c.get("authz")', "callerOf", "selfScoped"]);
    expect(problemsOf("middleware: jwtOnly")).toEqual([]);
  });

  it("the route is on jwtOnly", () => {
    expect(read("list.routes.ts")).toContain("middleware: jwtOnly,");
  });
});
