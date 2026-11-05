import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-4.7, AC-4.8 (specs/021 T25): the erase screen's search, which shows title, date and
// creator and nothing else.

const kit: Kit = await createKit();

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  kit.grant("eraser", "erase");
  kit.grant("admin", "access", "template"); // an administrator without the erase right
  kit.grant("alice", "access");
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
async function seed(title: string, startsAt: string, over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: { title, format: "online", startsAt: new Date(startsAt), language: "en", source: "recorded", status: "ready", creatorUserId: "alice", ...over },
  });
}
const search = (query = "", who = "eraser") => kit.call(who, "GET", `/erase/meetings${query}`);
const titles = (body: Record<string, any>) => body["items"].map((i: { title: string }) => i.title);

describe("access", () => {
  it("needs meeting:erase: 403 for tool access, template management or administration alone; 401; 503 when auth is down", async () => {
    expect((await search("", "alice")).status).toBe(403);
    expect((await search("", "admin")).status).toBe(403);
    expect((await search("", "nobody")).status).toBe(403);
    expect((await kit.call(null, "GET", "/erase/meetings")).status).toBe(401);
    kit.setAuthDown(true);
    expect((await search()).status).toBe(503);
  });
});

describe("what it shows (AC-4.7)", () => {
  it("every person's meetings, newest first, as exactly { id, title, startsAt, creator }", async () => {
    const a = await seed("Older", "2026-10-01T09:00:00.000Z");
    const b = await seed("Newer", "2026-10-02T09:00:00.000Z", { creatorUserId: "bob", hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: true });
    await kit.db.transcriptSegment.create({ data: { meetingId: b.id, ordinal: 0, text: "never shown" } });

    const res = await search();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["items", "page", "pageSize", "total"]);
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(body["items"]).toEqual([
      { id: b.id, title: "Newer", startsAt: "2026-10-02T09:00:00.000Z", creator: { id: "bob", name: "Name bob", status: "active" } },
      { id: a.id, title: "Older", startsAt: "2026-10-01T09:00:00.000Z", creator: { id: "alice", name: "Name alice", status: "active" } },
    ]);
    for (const item of body["items"]) expect(Object.keys(item).sort()).toEqual(["creator", "id", "startsAt", "title"]);
    expect(JSON.stringify(body)).not.toContain("never shown");
  });

  it("shows a deactivated creator as deleted, never by a stale name", async () => {
    await seed("Orphan", "2026-10-01T09:00:00.000Z", { creatorUserId: "gone-zed" });
    expect((await json(await search()))["items"][0].creator).toEqual({ id: "gone-zed", name: null, status: "deleted" });
  });

  it("finding a meeting here opens nothing: the erase holder still gets 404 on it (AC-4.8)", async () => {
    const m = await seed("Private", "2026-10-01T09:00:00.000Z");
    expect(titles(await json(await search()))).toEqual(["Private"]);
    expect((await kit.call("eraser", "GET", `/meetings/${m.id}`)).status).toBe(404);
  });
});

describe("finding one", () => {
  beforeEach(async () => {
    await seed("Budget Q4", "2026-10-01T09:00:00.000Z");
    await seed("Retro", "2026-10-15T23:30:00.000Z", { creatorUserId: "bob" });
    await seed("100% done", "2026-11-01T09:00:00.000Z", { creatorUserId: "bob" });
    await seed("Budget sync", "2026-11-20T09:00:00.000Z", { creatorUserId: "bob" });
  });
  const found = async (query: string) => titles(await json(await search(query))).sort();

  it("by title: a case-insensitive substring, taken literally", async () => {
    expect(await found("?q=BUDGET")).toEqual(["Budget Q4", "Budget sync"]);
    expect(await found("?q=%25")).toEqual(["100% done"]);
    expect(await found("?q=zzz")).toEqual([]);
  });

  it("by creator", async () => {
    expect(await found("?creatorId=alice")).toEqual(["Budget Q4"]);
    expect(await found("?creatorId=bob")).toEqual(["100% done", "Budget sync", "Retro"]);
  });

  it("by date: from and to are inclusive, and a bare date means the whole day", async () => {
    expect(await found("?from=2026-10-15")).toEqual(["100% done", "Budget sync", "Retro"]);
    expect(await found("?to=2026-10-15")).toEqual(["Budget Q4", "Retro"]);
    expect(await found("?from=2026-10-15&to=2026-10-15")).toEqual(["Retro"]);
    expect(await found("?from=2026-10-15T23:31:00.000Z&to=2026-11-01T09:00:00.000Z")).toEqual(["100% done"]);
    expect(await found("?from=2026-12-01&to=2026-01-01")).toEqual([]);
  });

  it("the filters combine", async () => {
    expect(await found("?q=budget&creatorId=bob&from=2026-11-01")).toEqual(["Budget sync"]);
    expect((await json(await search("?q=budget")))["total"]).toBe(2);
  });

  it("422 naming a date that is not one, and a page that is not one", async () => {
    for (const [query, field] of [["?from=yesterday", "from"], ["?to=2026-13-40", "to"], ["?page=0", "page"]] as const) {
      const res = await search(query);
      expect(res.status).toBe(422);
      expect((await json(res))["field"]).toBe(field);
    }
  });

  it("25 a page", async () => {
    for (let i = 0; i < 24; i++) await seed(`Filler ${i}`, "2026-09-01T09:00:00.000Z");
    const first = await json(await search());
    const second = await json(await search("?page=2"));
    expect([first["items"].length, second["items"].length, first["total"]]).toEqual([25, 3, 28]);
  });
});
