/**
 * meetings-api's own list, asked as the caller (specs/029 T11; plan § Sequences "On a meeting",
 * § API contracts "meetings-api", AC-2.5, AC-2.10, AC-4.7, risk R7; meetings-api T8):
 *
 *   GET /meetings?ids=a,b,c    the caller's OWN meetings (creator or Operai participant) among those ids
 *
 * One call is both the booking check and the label: a meeting is there only for someone who took part
 * in it, and a host-only reader, someone else's meeting and an unknown id are absent alike. The shared
 * failure rules are in `contract.test.ts`. The system route is in `meetings.system.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { startHosts, tokenShaped } from "../test-support/hosts";
import { listMeetingsByIds } from "./meetings";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = `Bearer ${tokenShaped({ sub: "user-alice" })}`;

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  hosts.reset();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const ok = async (ids: string[]) => {
  const answer = await listMeetingsByIds(ALICE, ids);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.items;
};

describe("listMeetingsByIds", () => {
  it("answers a meeting the caller created or takes part in, with its title and the caller's role", async () => {
    hosts.meetings.add({ id: "m1", title: "Sprint review", creator: "user-alice" });
    hosts.meetings.add({ id: "m2", title: "Client workshop", creator: "user-bob", participants: ["user-alice"] });
    const items = await ok(["m1", "m2"]);
    expect(items.get("m1")).toEqual({ id: "m1", title: "Sprint review", role: "creator" });
    expect(items.get("m2")).toEqual({ id: "m2", title: "Client workshop", role: "participant" });
  });

  it("leaves out a meeting the caller did not take part in, and one nobody knows: absent alike (AC-2.10)", async () => {
    hosts.meetings.add({ id: "m1", title: "Mine", creator: "user-alice" });
    // A host-only reader is neither creator nor participant: the owner's list never has the meeting for them.
    hosts.meetings.add({ id: "m2", title: "Someone else's", creator: "user-bob", participants: ["user-carol"] });
    expect([...(await ok(["m1", "m2", "m3"])).keys()]).toEqual(["m1"]);
  });

  it("sends ONE `ids` member, comma-separated, and no `page`, nothing else", async () => {
    await ok(["m1", "m2", "m1"]);
    const [call] = hosts.callsTo("meetings.list");
    expect([...call!.query.keys()]).toEqual(["ids"]);
    expect(call!.query.get("ids")).toBe("m1,m2");
    expect(call!.path).toBe("/meetings");
  });

  it("asks nothing for no ids", async () => {
    expect(await listMeetingsByIds(ALICE, [])).toEqual({ state: "ok", items: new Map() });
    expect(hosts.calls).toEqual([]);
  });

  it("splits ids into batches of 25 and never pages through the answer", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
    for (const id of ids) hosts.meetings.add({ id, creator: "user-alice" });
    const items = await ok(ids);
    expect(items.size).toBe(60);
    expect(hosts.callsTo("meetings.list").map((call) => (call.query.get("ids") ?? "").split(",").length).sort((a, b) => b - a)).toEqual([25, 25, 10]);
    expect(hosts.callsTo("meetings.list").every((call) => !call.query.has("page"))).toBe(true);
  });

  it("builds the query with URLSearchParams: an id holding & # + % or an inner space reaches the owner exactly as sent", async () => {
    const odd = ["m&1", "m#2", "m+3", "m%4", "m 5", "m=6"];
    odd.forEach((id) => hosts.meetings.add({ id, creator: "user-alice" }));
    const items = await ok(odd);
    expect(hosts.callsTo("meetings.list").map((call) => call.query.get("ids"))).toEqual([odd.join(",")]);
    expect([...items.keys()].sort()).toEqual([...odd].sort());
  });

  it("answers `unavailable` when any one batch does not answer, never a shorter list", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}`);
    hosts.fail("meetings.list", { status: 503, times: 1 });
    expect(await listMeetingsByIds(ALICE, ids)).toEqual({ state: "unavailable" });
  });

  // R7: meetings-api before T8 ignores `ids` and returns the caller's latest page. The meetings it was
  // not asked about are dropped; and a meeting that is missing from such an answer is not "not yours" —
  // it may simply be older than the page — so the answer is `unavailable`, never a false 404.
  describe("a meetings-api that does not know `ids` yet", () => {
    beforeEach(() => {
      hosts.meetings.legacy = true;
      for (let i = 1; i <= 30; i++) hosts.meetings.add({ id: `m${i}`, title: `Meeting ${i}`, creator: "user-alice" });
    });

    it("keeps what was asked and drops the rest of the latest page, when what was asked is on it", async () => {
      const items = await ok(["m30"]);
      expect([...items.keys()]).toEqual(["m30"]);
    });

    it("answers `unavailable` when an asked meeting is not on that page: it cannot be told from one that is not the caller's", async () => {
      expect(await listMeetingsByIds(ALICE, ["m1"])).toEqual({ state: "unavailable" });
    });
  });

  it("answers `unavailable` when it is handed a meeting it did not ask for and an asked one is missing", async () => {
    const row = (id: string) => ({ id, title: id, role: "creator" });
    hosts.fail("meetings.list", { body: { items: [row("other-1"), row("other-2")], total: 2, page: 1, pageSize: 25 } });
    expect(await listMeetingsByIds(ALICE, ["m1"])).toEqual({ state: "unavailable" });
  });

  it("treats a row whose role is not creator or participant as absent: only someone who took part books or sees a title", async () => {
    hosts.fail("meetings.list", { body: { items: [{ id: "m1", title: "Host-only", role: "host_reader" }], total: 1, page: 1, pageSize: 25 } });
    expect(await ok(["m1"])).toEqual(new Map());
  });

  it("answers `unavailable` for a row that breaks the contract", async () => {
    hosts.fail("meetings.list", { body: { items: [{ id: "m1", role: "creator" }], total: 1, page: 1, pageSize: 25 } });
    expect(await listMeetingsByIds(ALICE, ["m1"])).toEqual({ state: "unavailable" });
  });
});
