/**
 * crm-api's host resolve for `entityType: "deal"`, asked as the caller (specs/029 T11; plan § Sequences
 * "Record an entry on a deal", AC-2.3, AC-2.10, AC-2.11, AC-4.10, risk R7). The shared failure rules
 * are in `contract.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { startHosts, tokenShaped } from "../test-support/hosts";
import { resolveDeals } from "./crm";

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
  const answer = await resolveDeals(ALICE, ids);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.items;
};

describe("resolveDeals", () => {
  it("answers an open deal with its label, href and the people involved (owner, technical contact)", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: ["user-owner", "user-tech"] });
    expect((await ok(["d1"])).get("d1")).toEqual({
      state: "open",
      label: "Acme renewal",
      href: "/crm/deals/d1",
      involved: ["user-owner", "user-tech"],
    });
  });

  it("answers a deal nobody knows as `missing`", async () => {
    expect((await ok(["nope"])).get("nope")).toEqual({ state: "missing" });
  });

  it("answers `not_reader` for a caller without CRM access, and nothing else", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: ["user-alice"] });
    hosts.crm.setReader("user-alice", false);
    expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "not_reader" });
  });

  it("lets `reader: false` decide alone, whatever else the body holds", async () => {
    hosts.fail("crm.resolve", { body: { reader: false, items: "garbage" } });
    expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "not_reader" });
  });

  it("sends the strict deal body: `entityType: deal` and the distinct ids, no `related`", async () => {
    await resolveDeals(ALICE, ["d1", "d2", "d1"]);
    expect(hosts.callsTo("crm.resolve").map((call) => call.body)).toEqual([{ entityType: "deal", ids: ["d1", "d2"] }]);
  });

  it("asks nothing for no ids", async () => {
    expect(await resolveDeals(ALICE, [])).toEqual({ state: "ok", items: new Map() });
    expect(hosts.calls).toEqual([]);
  });

  it("splits ids into batches of 25 and answers them all", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `d${i}`);
    for (const id of ids) hosts.crm.setDeal(id, { label: `Deal ${id}`, involved: [] });
    const items = await ok(ids);
    expect(hosts.callsTo("crm.resolve").map((call) => (call.body as { ids: string[] }).ids.length).sort((a, b) => b - a)).toEqual([25, 25, 1]);
    expect(items.size).toBe(51);
  });

  it("answers `unavailable` when any one batch does not answer", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `d${i}`);
    hosts.fail("crm.resolve", { status: 503, times: 1 });
    expect(await resolveDeals(ALICE, ids)).toEqual({ state: "unavailable" });
  });

  // R7: a crm-api that predates T7 answers 422 to `entityType: "deal"`. That is a version gap, not "no such deal".
  it("answers `unavailable` to a crm-api that does not know deals yet", async () => {
    hosts.crm.setDeal("d1", { label: "Acme renewal", involved: ["user-alice"] });
    hosts.crm.legacy = true;
    expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "unavailable" });
    expect(hosts.callsTo("crm.resolve")).toHaveLength(1);
  });

  it("ignores an item about an id it did not ask for", async () => {
    hosts.fail("crm.resolve", {
      body: {
        reader: true,
        items: [
          { id: "d1", state: "missing" },
          { id: "smuggled", state: "open", writable: true, label: "Injected", href: "/crm/deals/smuggled", may: { write: true, manage: true }, involved: ["user-alice"] },
        ],
      },
    });
    expect([...(await ok(["d1"])).keys()]).toEqual(["d1"]);
  });

  it("answers `unavailable` when the owner leaves an asked id unanswered", async () => {
    hosts.fail("crm.resolve", { body: { reader: true, items: [] } });
    expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "unavailable" });
  });

  it("answers `unavailable` for an open deal that does not state who is involved: absent is not nobody", async () => {
    hosts.fail("crm.resolve", {
      body: { reader: true, items: [{ id: "d1", state: "open", writable: true, label: "Acme", href: "/crm/deals/d1", may: { write: true, manage: true } }] },
    });
    expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "unavailable" });
  });

  it.each(["https://evil.example/x", "//evil.example/x", "crm/deals/d1", "/with space", ""])(
    "answers `unavailable` when an href is not a path inside the suite: %p",
    async (href) => {
      hosts.crm.setDeal("d1", { label: "Acme renewal", href, involved: ["user-alice"] });
      expect(await resolveDeals(ALICE, ["d1"])).toEqual({ state: "unavailable" });
    },
  );

  it("sends an id holding & # + % a quote or a space inside the JSON body exactly as given", async () => {
    const odd = ["x&y=1", "h#sh", "pl+us", "per%cent", 'q"uote', "in ner"];
    await resolveDeals(ALICE, odd);
    expect(hosts.callsTo("crm.resolve").map((call) => (call.body as { ids: string[] }).ids)).toEqual([odd]);
  });

  it("lists a person once when the owner is also the technical contact", async () => {
    hosts.fail("crm.resolve", {
      body: {
        reader: true,
        items: [{ id: "d1", state: "open", writable: true, label: "Acme", href: "/crm/deals/d1", may: { write: true, manage: true }, involved: ["user-owner", "user-owner"] }],
      },
    });
    expect((await ok(["d1"])).get("d1")).toMatchObject({ involved: ["user-owner"] });
  });
});
