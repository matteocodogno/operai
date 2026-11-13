/**
 * activities-api, asked as the caller (specs/029 T11; plan § API contracts "activities-api", § Sequences,
 * AC-2.3, AC-2.7, AC-2.9, AC-4.7, risks R6, R7, R9, ADR-0089; activities-api T6):
 *
 *   GET /activities?ids=a,b,c     the activities of those ids the caller may read, ALWAYS one page (≤ 50)
 *   GET /activities?dealId=<id>   the activities about a deal, paged (the scan for "is the caller involved")
 *
 * The shared failure rules are in `contract.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { startHosts, tokenShaped } from "../test-support/hosts";
import { listActivitiesByIds, listDealActivities } from "./activities";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = `Bearer ${tokenShaped({ sub: "user-alice" })}`;

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  hosts.reset();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const byIds = async (ids: string[]) => {
  const answer = await listActivitiesByIds(ALICE, ids);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.items;
};

const ofDeal = async (dealId: string) => {
  const answer = await listDealActivities(ALICE, dealId);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer;
};

const sizes = (route: "activities.list") => hosts.callsTo(route).map((call) => (call.query.get("ids") ?? "").split(",").length).sort((a, b) => b - a);

describe("listActivitiesByIds", () => {
  it("answers each activity with what hours-api needs: its subject, the project or deal it is about, its assignee and participants", async () => {
    hosts.activities.add({ id: "a1", subject: "Write the migration", project: "p1", assignee: "user-bob", participants: ["user-carol"] });
    hosts.activities.add({ id: "a2", subject: "Kick-off call", type: "call", deal: "d1", participants: ["user-alice"] });
    const items = await byIds(["a1", "a2"]);
    expect(items.get("a1")).toEqual({
      id: "a1",
      subject: "Write the migration",
      type: "task",
      projectId: "p1",
      dealId: null,
      assigneeId: "user-bob",
      participantIds: ["user-carol"],
    });
    expect(items.get("a2")).toEqual({
      id: "a2",
      subject: "Kick-off call",
      type: "call",
      projectId: null,
      dealId: "d1",
      assigneeId: null,
      participantIds: ["user-alice"],
    });
  });

  it("answers a task nobody is assigned to with no assignee", async () => {
    hosts.activities.add({ id: "a1", subject: "Orphan", project: "p1" });
    expect((await byIds(["a1"])).get("a1")).toMatchObject({ assigneeId: null });
  });

  it("sends ONE `ids` member, comma-separated, and no `page`, no `pageSize`, nothing else", async () => {
    await byIds(["a1", "a2", "a1"]);
    const [call] = hosts.callsTo("activities.list");
    expect([...call!.query.keys()]).toEqual(["ids"]);
    expect(call!.query.get("ids")).toBe("a1,a2");
    expect(call!.path).toBe("/activities");
  });

  it("asks nothing for no ids", async () => {
    expect(await listActivitiesByIds(ALICE, [])).toEqual({ state: "ok", items: new Map() });
    expect(hosts.calls).toEqual([]);
  });

  it("splits ids into batches of 50, each in one page, and never pages through the answer", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
    for (const id of ids) hosts.activities.add({ id, subject: `Task ${id}`, project: "p1" });
    const items = await byIds(ids);
    expect(items.size).toBe(120);
    expect(sizes("activities.list")).toEqual([50, 50, 20]);
    expect(hosts.callsTo("activities.list").every((call) => !call.query.has("page") && !call.query.has("pageSize"))).toBe(true);
  });

  it("builds the query with URLSearchParams: an id holding & # + % or a space reaches the owner exactly as sent", async () => {
    const odd = ["a&b", "c#d", "e+f", "g%h", "i j", "k%2Cl", "m=n"];
    odd.forEach((id) => hosts.activities.add({ id, subject: `Task ${id}`, project: "p1" }));
    const items = await byIds(odd);
    expect(hosts.callsTo("activities.list").map((call) => call.query.get("ids"))).toEqual([odd.join(",")]);
    expect([...items.keys()].sort()).toEqual([...odd].sort());
  });

  it("leaves out an id the owner leaves out: it does not exist, or the caller may not read it (one outcome)", async () => {
    hosts.activities.add({ id: "a1", subject: "Mine", project: "p1" });
    hosts.activities.add({ id: "a2", subject: "Secret", project: "p2", readableBy: ["user-bob"] });
    const items = await byIds(["a1", "a2", "a3"]);
    expect([...items.keys()]).toEqual(["a1"]);
  });

  it("answers an empty map, not `unavailable`, when nothing asked is readable", async () => {
    expect(await byIds(["a1"])).toEqual(new Map());
  });

  it("answers `unavailable` when any one batch does not answer, never a shorter list", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `a${i}`);
    hosts.fail("activities.list", { status: 503, times: 1 });
    expect(await listActivitiesByIds(ALICE, ids)).toEqual({ state: "unavailable" });
  });

  // R7: activities-api before T6 does not know `ids`: `ids` alone is its "exactly one filter" 422.
  it("answers `unavailable` to an activities-api that does not know `ids` yet", async () => {
    hosts.activities.add({ id: "a1", subject: "Mine", project: "p1" });
    hosts.activities.legacy = true;
    expect(await listActivitiesByIds(ALICE, ["a1"])).toEqual({ state: "unavailable" });
    expect(hosts.callsTo("activities.list")).toHaveLength(1);
  });

  it("drops an activity it did not ask for", async () => {
    const view = (id: string) => ({ id, type: "task", subject: id, project: { id: "p1", name: null }, deal: null, participants: [], task: { assignee: null } });
    hosts.fail("activities.list", { body: { items: [view("a1"), view("smuggled")], total: 2, page: 1, pageSize: 50 } });
    expect([...(await byIds(["a1"])).keys()]).toEqual(["a1"]);
  });

  // A filter the owner ignored proves nothing about what is absent: an asked id missing from such an answer is
  // not "does not exist", it is unanswered. Dropping the extras and calling the rest "absent" would tell the
  // creator of an old activity that it does not exist.
  it("answers `unavailable` when it was handed activities it did not ask for and an asked one is missing", async () => {
    const view = (id: string) => ({ id, type: "task", subject: id, project: { id: "p1", name: null }, deal: null, participants: [], task: { assignee: null } });
    hosts.fail("activities.list", { body: { items: [view("latest-1"), view("latest-2")], total: 2, page: 1, pageSize: 50 } });
    expect(await listActivitiesByIds(ALICE, ["a1"])).toEqual({ state: "unavailable" });
  });

  it("answers `unavailable` for an activity that breaks the contract", async () => {
    hosts.fail("activities.list", { body: { items: [{ id: "a1", type: "task", subject: 7 }], total: 1, page: 1, pageSize: 50 } });
    expect(await listActivitiesByIds(ALICE, ["a1"])).toEqual({ state: "unavailable" });
  });
});

describe("listDealActivities", () => {
  it("asks for the deal's activities, a hundred to a page, and answers them as facts", async () => {
    hosts.activities.add({ id: "a1", subject: "Call the client", type: "call", deal: "d1", participants: ["user-alice"] });
    hosts.activities.add({ id: "a2", subject: "Draft offer", deal: "d1", assignee: "user-bob" });
    hosts.activities.add({ id: "a3", subject: "Another deal", deal: "d2", assignee: "user-bob" });
    const result = await ofDeal("d1");
    expect(result.truncated).toBe(false);
    expect(result.items.map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(result.items[1]).toEqual({
      id: "a1",
      subject: "Call the client",
      type: "call",
      projectId: null,
      dealId: "d1",
      assigneeId: null,
      participantIds: ["user-alice"],
    });
    expect(result.items[0]).toMatchObject({ assigneeId: "user-bob" });
    const [call] = hosts.callsTo("activities.list");
    expect(Object.fromEntries(call!.query)).toEqual({ dealId: "d1", page: "1", pageSize: "100" });
  });

  it("answers an empty list for a deal without activities, in one call", async () => {
    expect(await ofDeal("d1")).toEqual({ state: "ok", items: [], truncated: false });
    expect(hosts.callsTo("activities.list")).toHaveLength(1);
  });

  it("follows the pages until the owner's total is read", async () => {
    for (let i = 0; i < 250; i++) hosts.activities.add({ id: `a${i}`, subject: `Activity ${i}`, deal: "d1" });
    const result = await ofDeal("d1");
    expect(result.items).toHaveLength(250);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(250);
    expect(result.truncated).toBe(false);
    expect(hosts.callsTo("activities.list").map((call) => call.query.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("reads at most 10 pages (1000 activities) and says it stopped there (R9)", async () => {
    for (let i = 0; i < 1100; i++) hosts.activities.add({ id: `a${i}`, subject: `Activity ${i}`, deal: "d1" });
    const result = await ofDeal("d1");
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(hosts.callsTo("activities.list")).toHaveLength(10);
  });

  it("does not call a 1000-activity deal truncated, nor ask for an 11th page", async () => {
    for (let i = 0; i < 1000; i++) hosts.activities.add({ id: `a${i}`, subject: `Activity ${i}`, deal: "d1" });
    const result = await ofDeal("d1");
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(false);
    expect(hosts.callsTo("activities.list")).toHaveLength(10);
  });

  it("answers `unavailable` when a later page does not answer, never the first pages alone", async () => {
    for (let i = 0; i < 250; i++) hosts.activities.add({ id: `a${i}`, subject: `Activity ${i}`, deal: "d1" });
    hosts.fail("activities.list", { status: 503, after: 1 });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
    expect(hosts.callsTo("activities.list")).toHaveLength(2);
  });

  it("answers `unavailable` for a caller the CRM does not let read (the owner's 404)", async () => {
    hosts.activities.add({ id: "a1", subject: "Call", type: "call", deal: "d1" });
    hosts.activities.setReader("user-alice", false);
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
  });

  it("leaves out an activity the caller may not read", async () => {
    hosts.activities.add({ id: "a1", subject: "Mine", deal: "d1" });
    hosts.activities.add({ id: "a2", subject: "Secret", deal: "d1", readableBy: ["user-bob"] });
    expect((await ofDeal("d1")).items.map((item) => item.id)).toEqual(["a1"]);
  });

  it("builds the query with URLSearchParams: a deal id holding & # + % or a space reaches the owner exactly as sent", async () => {
    for (const id of ["d&1", "d#1", "d+1", "d%1", "d 1"]) {
      hosts.activities.add({ id: `act-${id}`, subject: id, deal: id });
      expect((await ofDeal(id)).items.map((item) => item.dealId)).toEqual([id]);
    }
    expect(hosts.callsTo("activities.list").map((call) => call.query.get("dealId"))).toEqual(["d&1", "d#1", "d+1", "d%1", "d 1"]);
  });

  // An activity not about this deal would make a person "involved" in a deal they have nothing to do with.
  it("answers `unavailable` when the owner hands back an activity that is not about the deal", async () => {
    const view = (id: string, deal: string) => ({ id, type: "task", subject: id, project: null, deal: { id: deal, title: null }, participants: [{ id: "user-alice" }], task: { assignee: null } });
    hosts.fail("activities.list", { body: { items: [view("a1", "d1"), view("a2", "other-deal")], total: 2, page: 1, pageSize: 100 } });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
  });

  // A scan that cannot account for every activity of the owner's `total` must not pass for the whole list:
  // "not on any of them" would then be read as "not involved" (a 403) for someone who is.
  it("answers `unavailable` when the pages do not add up to the owner's total (an owner that ignores `page`)", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, type: "task", subject: "s", project: null, deal: { id: "d1", title: null }, participants: [], task: { assignee: null } }));
    hosts.fail("activities.list", { body: { items: page, total: 250, page: 1, pageSize: 100 } });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
  });

  it("answers `unavailable` when a page is empty while the owner's total says there is more", async () => {
    hosts.fail("activities.list", { body: { items: [], total: 5, page: 1, pageSize: 100 } });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
    expect(hosts.callsTo("activities.list")).toHaveLength(1);
  });

  it("answers `unavailable` when the first page is empty while the owner's total says there are hundreds more, without paging on", async () => {
    hosts.fail("activities.list", { body: { items: [], total: 250, page: 1, pageSize: 100 } });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
    expect(hosts.callsTo("activities.list")).toHaveLength(1);
  });

  it("answers `unavailable` for an owner that sends no total", async () => {
    hosts.fail("activities.list", { body: { items: [] } });
    expect(await listDealActivities(ALICE, "d1")).toEqual({ state: "unavailable" });
  });
});
