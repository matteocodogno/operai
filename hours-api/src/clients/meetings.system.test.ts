/**
 * meetings-api's system route, read with hours-api's OWN service credential (specs/029 T11; plan
 * § Sequences "List / totals", § API contracts "meetings-api", ADR-0089, AC-2.6, AC-4.5, AC-4.7,
 * AC-4.11, risk R7; meetings-api T9):
 *
 *   GET /system/meetings/hosts?ids=a,b,c      (≤ 100)   the deal each meeting is linked to
 *   GET /system/meetings/hosts?dealId=<id>              the meetings currently linked to a deal
 *
 * Never the caller's token: a person who may book hours on a meeting has no right to the system route,
 * and the fact it carries (a meeting's deal) reaches a viewer only with the right to read that deal
 * (labels, T13). The credential is the 5-minute service JWT `auth POST /system/service-token` mints
 * (`aud` = SERVICE_AUDIENCE, scope `meetings.hosts.read`, `sub` `system:hours-api`), cached, and
 * refetched once after a 401. What every owner client shares is repeated here for these two: the
 * timeout, the redirect, and `unavailable` for anything but a clean 200.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "../lib/env";
import { TEST_SERVICE_AUDIENCE } from "../test-support/env";
import { claimsOf, startHosts } from "../test-support/hosts";
import { OWNER_TIMEOUT_MS, type CallOptions } from "./owner";
import { readMeetingHosts, readMeetingsLinkedToDeal } from "./meetings";

const hosts = startHosts();
afterAll(() => hosts.stop());

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  hosts.reset();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const hostsOf = async (ids: string[]) => {
  const answer = await readMeetingHosts(ids);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.items;
};

const linkedTo = async (dealId: string) => {
  const answer = await readMeetingsLinkedToDeal(dealId);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.meetingIds;
};

const SHORT = { timeoutMs: 60 } as const;

describe("readMeetingHosts", () => {
  it("answers the deal each meeting is linked to, none for an unlinked one, and nothing for an unknown id", async () => {
    hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
    hosts.meetings.add({ id: "m2", creator: "user-bob", dealId: null });
    const items = await hostsOf(["m1", "m2", "m3"]);
    expect(items.get("m1")).toEqual({ dealId: "d1" });
    expect(items.get("m2")).toEqual({ dealId: null });
    expect(items.has("m3")).toBe(false);
  });

  it("follows a relink: the next read says the new deal", async () => {
    hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
    expect((await hostsOf(["m1"])).get("m1")).toEqual({ dealId: "d1" });
    hosts.meetings.relink("m1", "d2");
    expect((await hostsOf(["m1"])).get("m1")).toEqual({ dealId: "d2" });
    hosts.meetings.relink("m1", null);
    expect((await hostsOf(["m1"])).get("m1")).toEqual({ dealId: null });
  });

  // ADR-0059: a host is data, never a branch. meetings-api stores and returns three strings, so this client
  // accepts any strings and decides per item: only exactly crm / deal is a deal. Any other host (production has
  // none, specs/021 AC-11.1) is "no deal", like null: it must not fail the batch, which would make every
  // meeting of a page read "unknown", and its entityId is never taken for a deal.
  describe("a host that is not a CRM deal (amended 2026-11-13)", () => {
    const row = (id: string, host: unknown) => ({ id, host });

    it("is no deal, and the other meetings of the batch are unaffected", async () => {
      hosts.fail("meetings.system-hosts", {
        body: {
          items: [
            row("m1", { app: "crm", entityType: "deal", entityId: "d1" }),
            row("m2", { app: "testhost", entityType: "widget", entityId: "w9" }),
            row("m3", null),
          ],
        },
      });
      const items = await hostsOf(["m1", "m2", "m3"]);
      expect(items.get("m1")).toEqual({ dealId: "d1" });
      expect(items.get("m2")).toEqual({ dealId: null });
      expect(items.get("m3")).toEqual({ dealId: null });
      expect(warn).not.toHaveBeenCalled();
    });

    it("is no deal when the fake meetings-api stores another host, in a batch with a real deal link", async () => {
      hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
      hosts.meetings.add({ id: "m2", creator: "user-bob", host: { app: "testhost", entityType: "widget", entityId: "d1" } });
      hosts.meetings.add({ id: "m3", creator: "user-bob" });
      const items = await hostsOf(["m1", "m2", "m3"]);
      expect([...items].map(([id, host]) => [id, host.dealId])).toEqual([["m1", "d1"], ["m2", null], ["m3", null]]);
      // The same deal asked the other way round: the other host's meeting is not one of this deal's, though its entityId says d1.
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "ok", meetingIds: ["m1"] });
    });

    it.each([
      ["another app and another type", { app: "testhost", entityType: "widget", entityId: "w9" }],
      ["a CRM host that is not a deal", { app: "crm", entityType: "company", entityId: "c1" }],
      ["another app's deal", { app: "testhost", entityType: "deal", entityId: "d1" }],
      ["a differently cased crm / deal", { app: "CRM", entityType: "Deal", entityId: "d1" }],
      ["crm / deal with padding", { app: "crm ", entityType: "deal", entityId: "d1" }],
      ["a crm / deal that names no deal", { app: "crm", entityType: "deal", entityId: "" }],
      ["the old projects host", { app: "projects", entityType: "project", entityId: "p1" }],
    ])("reads %s as no deal, never as a failed batch and never as the id it carries", async (_label, host) => {
      hosts.fail("meetings.system-hosts", { body: { items: [row("m1", host)] } });
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "ok", items: new Map([["m1", { dealId: null }]]) });
    });

    it("is no deal whatever the strings are: a stored host of unusual strings is data", async () => {
      hosts.fail("meetings.system-hosts", { body: { items: [row("m1", { app: "ünïcode ✓", entityType: "x".repeat(300), entityId: "a,b&c" })] } });
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "ok", items: new Map([["m1", { dealId: null }]]) });
    });
  });

  describe("the credential", () => {
    it("is hours-api's own service JWT from the token endpoint: `aud` the service audience, scope meetings.hosts.read, sub system:hours-api", async () => {
      hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
      await hostsOf(["m1"]);
      const [mint] = hosts.callsTo("auth.service-token");
      expect(mint?.body).toEqual({ clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET });
      const [call] = hosts.callsTo("meetings.system-hosts");
      expect(call?.authorization).toStartWith("Bearer ");
      expect(claimsOf(call?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", aud: TEST_SERVICE_AUDIENCE, scope: "meetings.hosts.read" });
      expect(env.SERVICE_AUDIENCE).toBe(TEST_SERVICE_AUDIENCE);
    });

    it("is minted once and reused: a second read does not ask `auth` again", async () => {
      hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
      await hostsOf(["m1"]);
      await readMeetingsLinkedToDeal("d1");
      expect(hosts.callsTo("auth.service-token")).toHaveLength(1);
      expect(hosts.callsTo("meetings.system-hosts")).toHaveLength(2);
    });

    it("is dropped after a 401 and a fresh one is used ONCE: a rotated key costs one retry, not an outage", async () => {
      hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
      hosts.fail("meetings.system-hosts", { status: 401, times: 1 });
      expect((await hostsOf(["m1"])).get("m1")).toEqual({ dealId: "d1" });
      expect(hosts.callsTo("auth.service-token")).toHaveLength(2);
      const [first, second] = hosts.callsTo("meetings.system-hosts");
      expect(first?.authorization).not.toBe(second?.authorization);
    });

    it("answers `unavailable` to a 401 that a fresh token does not cure, after exactly one retry", async () => {
      hosts.fail("meetings.system-hosts", { status: 401 });
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
      expect(hosts.callsTo("meetings.system-hosts")).toHaveLength(2);
      expect(hosts.callsTo("auth.service-token")).toHaveLength(2);
    });

    it("answers `unavailable` and calls meetings-api not at all when `auth` will not mint a token", async () => {
      hosts.fail("auth.service-token", { status: 500 });
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "unavailable" });
      expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    });

    it("answers `unavailable` when `auth` is unreachable", async () => {
      hosts.sever("auth");
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
      expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    });

    it("answers `unavailable` to a token endpoint that sends nonsense", async () => {
      hosts.fail("auth.service-token", { body: { token: 7 } });
      expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
    });

    it("never writes the token or the secret to the log", async () => {
      hosts.fail("meetings.system-hosts", { status: 500 });
      await readMeetingHosts(["m1"]);
      hosts.fail("auth.service-token", { status: 500 });
      await readMeetingHosts(["m2"]);
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toBe("");
      expect(logged).not.toContain("Bearer");
      expect(logged).not.toContain(env.SERVICE_CLIENT_SECRET);
      expect(logged).not.toMatch(/\bm[12]\b/);
    });
  });

  it("asks nothing, and asks `auth` for nothing, for no ids", async () => {
    expect(await readMeetingHosts([])).toEqual({ state: "ok", items: new Map() });
    expect(hosts.calls).toEqual([]);
  });

  it("sends ONE `ids` member and nothing else, a hundred to a call", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    for (const id of ids) hosts.meetings.add({ id, creator: "user-bob", dealId: "d1" });
    const items = await hostsOf(ids);
    expect(items.size).toBe(250);
    const calls = hosts.callsTo("meetings.system-hosts");
    expect(calls.map((call) => (call.query.get("ids") ?? "").split(",").length).sort((a, b) => b - a)).toEqual([100, 100, 50]);
    expect(calls.every((call) => [...call.query.keys()].join() === "ids")).toBe(true);
    expect(calls[0]?.path).toBe("/system/meetings/hosts");
  });

  it("builds the query with URLSearchParams: an id holding & # + % or a space reaches the owner exactly as sent", async () => {
    const odd = ["m&1", "m#2", "m+3", "m%4", "m 5"];
    odd.forEach((id) => hosts.meetings.add({ id, creator: "user-bob", dealId: "d1" }));
    const items = await hostsOf(odd);
    expect(hosts.callsTo("meetings.system-hosts").map((call) => call.query.get("ids"))).toEqual([odd.join(",")]);
    expect([...items.keys()].sort()).toEqual([...odd].sort());
  });

  it("answers `unavailable` when any one batch does not answer, never a shorter list", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
    hosts.fail("meetings.system-hosts", { status: 503, times: 1 });
    expect(await readMeetingHosts(ids)).toEqual({ state: "unavailable" });
  });

  it("drops a meeting it did not ask for, and answers `unavailable` when one asked is then missing", async () => {
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1", host: null }, { id: "smuggled", host: { app: "crm", entityType: "deal", entityId: "d9" } }] } });
    expect([...(await hostsOf(["m1"])).keys()]).toEqual(["m1"]);
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "smuggled", host: null }] } });
    expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
  });

  // Only an answer that is not the route's shape is `unavailable`: a `host` that is neither null nor an object of
  // three strings is a contract break, and it fails its batch (never "no deal": that would be a guess).
  it.each([
    ["a string", "d1"],
    ["a number", 7],
    ["an array", ["crm", "deal", "d1"]],
    ["an empty object", {}],
    ["an object missing its entityId", { app: "crm", entityType: "deal" }],
    ["an object missing its app", { entityType: "deal", entityId: "d1" }],
    ["a numeric entityId", { app: "crm", entityType: "deal", entityId: 7 }],
    ["a null entityType", { app: "crm", entityType: null, entityId: "d1" }],
    ["an object entityId", { app: "crm", entityType: "deal", entityId: { id: "d1" } }],
  ])("answers `unavailable` for a host that is %s", async (_label, host) => {
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1", host }] } });
    expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
  });

  it("answers `unavailable` for an item with no `host` member at all, and for one with no id", async () => {
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1" }] } });
    expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
    hosts.fail("meetings.system-hosts", { body: { items: [{ host: null }] } });
    expect(await readMeetingHosts(["m1"])).toEqual({ state: "unavailable" });
  });

  it("fails the whole answer when one batch holds a host of the wrong shape, though another batch is fine", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
    for (const id of ids) hosts.meetings.add({ id, creator: "user-bob", dealId: "d1" });
    hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m0", host: "d1" }] }, times: 1 });
    expect(await readMeetingHosts(ids)).toEqual({ state: "unavailable" });
  });
});

describe("readMeetingsLinkedToDeal", () => {
  it("answers the meetings linked to the deal now, and no others", async () => {
    hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
    hosts.meetings.add({ id: "m2", creator: "user-bob", dealId: "d1" });
    hosts.meetings.add({ id: "m3", creator: "user-bob", dealId: "d2" });
    hosts.meetings.add({ id: "m4", creator: "user-bob", dealId: null });
    expect([...(await linkedTo("d1"))].sort()).toEqual(["m1", "m2"]);
  });

  it("answers an empty list for a deal no meeting is linked to: a fact, not `unavailable`", async () => {
    expect(await linkedTo("d1")).toEqual([]);
  });

  it("follows a relink", async () => {
    hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" });
    hosts.meetings.relink("m1", "d2");
    expect(await linkedTo("d1")).toEqual([]);
    expect(await linkedTo("d2")).toEqual(["m1"]);
  });

  it("sends the deal as `dealId` and nothing else, as the service", async () => {
    await linkedTo("d1");
    const [call] = hosts.callsTo("meetings.system-hosts");
    expect(Object.fromEntries(call!.query)).toEqual({ dealId: "d1" });
    expect(claimsOf(call?.authorization ?? null)?.["sub"]).toBe("system:hours-api");
  });

  it("builds the query with URLSearchParams: a deal id holding & # + % or a space reaches the owner exactly as sent", async () => {
    for (const dealId of ["d&1", "d#2", "d+3", "d%4", "d 5"]) {
      hosts.meetings.add({ id: `m-${dealId}`, creator: "user-bob", dealId });
      expect(await linkedTo(dealId)).toEqual([`m-${dealId}`]);
    }
    expect(hosts.callsTo("meetings.system-hosts").map((call) => call.query.get("dealId"))).toEqual(["d&1", "d#2", "d+3", "d%4", "d 5"]);
  });

  // The route matches meetings whose stored host is EXACTLY { crm, deal, <dealId> } (amended 2026-11-13). From
  // its answer this client keeps only those: an item with any other host is not a meeting of this deal, and is
  // dropped, never counted for it and never a reason to refuse the answer.
  describe("what a `?dealId=` answer may hold (amended 2026-11-13)", () => {
    const deal = (entityId: string) => ({ app: "crm", entityType: "deal", entityId });

    it("keeps only the items whose host is exactly {crm, deal, <that dealId>}", async () => {
      hosts.fail("meetings.system-hosts", {
        body: {
          items: [
            { id: "m1", host: deal("d1") },
            { id: "m2", host: deal("other") },
            { id: "m3", host: null },
            { id: "m4", host: { app: "testhost", entityType: "widget", entityId: "d1" } },
            { id: "m5", host: { app: "crm", entityType: "company", entityId: "d1" } },
            { id: "m6", host: { app: "testhost", entityType: "deal", entityId: "d1" } },
            { id: "m7", host: deal("D1") },
            { id: "m8", host: deal("d1 ") },
            { id: "m9", host: deal("d1") },
          ],
        },
      });
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "ok", meetingIds: ["m1", "m9"] });
      expect(warn).not.toHaveBeenCalled();
    });

    it("answers an empty list when none of what it holds is linked to the deal: a fact, not `unavailable`", async () => {
      hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1", host: deal("other") }, { id: "m2", host: null }] } });
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "ok", meetingIds: [] });
    });

    it("lists a meeting once", async () => {
      hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1", host: deal("d1") }, { id: "m1", host: deal("d1") }] } });
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "ok", meetingIds: ["m1"] });
    });

    it.each([
      ["a string", "d1"],
      ["an array", []],
      ["an object missing its entityId", { app: "crm", entityType: "deal" }],
      ["a numeric entityId", { app: "crm", entityType: "deal", entityId: 7 }],
    ])("answers `unavailable` for an item whose host is %s: the wrong shape fails the batch, it is not dropped", async (_label, host) => {
      hosts.fail("meetings.system-hosts", { body: { items: [{ id: "m1", host: deal("d1") }, { id: "m2", host }] } });
      expect(await readMeetingsLinkedToDeal("d1")).toEqual({ state: "unavailable" });
    });
  });
});

// What every owner client shares, for the two system reads.
const SYSTEM = [
  { name: "hosts by ids", arrange: () => hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" }), call: (o?: CallOptions) => readMeetingHosts(["m1"], o) },
  { name: "meetings of a deal", arrange: () => hosts.meetings.add({ id: "m1", creator: "user-bob", dealId: "d1" }), call: (o?: CallOptions) => readMeetingsLinkedToDeal("d1", o) },
] as const;

describe.each(SYSTEM)("$name: what every owner client does", (subject) => {
  it("answers `ok` when the owner answers", async () => {
    subject.arrange();
    expect((await subject.call()).state).toBe("ok");
  });

  it("uses a 2 s timeout by default", async () => {
    subject.arrange();
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await subject.call();
      expect(timeout).toHaveBeenCalledWith(OWNER_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it("answers `unavailable` when the owner is too slow", async () => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", { delayMs: 400 });
    expect((await subject.call(SHORT)).state).toBe("unavailable");
  });

  it.each([500, 503])("answers `unavailable` to a %d", async (status) => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", { status });
    expect((await subject.call()).state).toBe("unavailable");
  });

  // R7: meetings-api before T9 has no such route: 404. A version gap, not "no meeting is linked".
  it.each([400, 403, 404, 405, 422, 429])("answers `unavailable` to a %d, never to \"not found\" or \"none\"", async (status) => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", { status });
    expect((await subject.call()).state).toBe("unavailable");
  });

  it.each([203, 206, 404, 422, 503])("answers `unavailable` to a perfectly good answer sent under a %d", async (withStatus) => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", { withStatus });
    expect((await subject.call()).state).toBe("unavailable");
  });

  it.each([
    ["text that is not JSON", { rawBody: "<html>bad gateway</html>" }],
    ["an empty body", { rawBody: "" }],
    ["JSON that breaks the contract", { malformed: true }],
    ["JSON null", { body: null }],
    ["an empty object", { body: {} }],
  ])("answers `unavailable` to %s", async (_label, mode) => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", mode);
    expect((await subject.call()).state).toBe("unavailable");
  });

  it("answers `unavailable` to a network error", async () => {
    subject.arrange();
    hosts.sever("meetings");
    expect((await subject.call()).state).toBe("unavailable");
  });

  it("follows no redirect: the service token never reaches the target", async () => {
    subject.arrange();
    hosts.fail("meetings.system-hosts", { redirect: true });
    expect((await subject.call()).state).toBe("unavailable");
    expect(hosts.elsewhere).toEqual([]);
  });
});
