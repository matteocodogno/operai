/**
 * Display names of the people on entries (specs/20261112-time-tracking T10, T46; AC-4.8, AC-4.7, ADR 20260807-live-identity-resolution-by-id-fail-soft):
 * read from `auth POST /authz/users/identities` with the viewer's own Bearer, never stored in the database, kept in
 * process for 60 s from when the batch that read them was sent (a rename shows within that), and failing SOFT
 * (`unknown`, the entries stay listed and counted) with nothing of a failure ever kept.
 *
 * `setSystemTime` moves the clock; the cache is emptied before each test.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { env } from "./env";
import { __identityCacheSizeForTests, __resetIdentityCacheForTests, resolveIdentities, type Identity } from "./identities";

const BEARER = "Bearer viewer-token";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly ids: string[];
}

let calls: Call[];
let realFetch: typeof fetch;
/** What auth answers for a batch; a test replaces it. Default: every id is an active person named after it. */
let answer: (ids: string[], call: number) => Response | Promise<Response>;

const activeAll = (ids: string[]) => Response.json({ users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })) });

const T0 = Date.parse("2026-11-18T10:00:00Z");
/** Moves the clock to `ms` after the start of the test. */
const at = (ms: number) => setSystemTime(new Date(T0 + ms));

beforeEach(() => {
  at(0);
  __resetIdentityCacheForTests();
  calls = [];
  answer = activeAll;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body ?? "{}")) as { ids?: string[] }).ids ?? [];
    calls.push({ url: String(url), init: init ?? {}, ids });
    return answer(ids, calls.length);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
};

describe("resolveIdentities", () => {
  it("answers one identity per distinct id, a name only for an active person", async () => {
    answer = (ids) =>
      Response.json({
        users: ids.map((id) =>
          id === "gone"
            ? { id, status: "deleted", name: "Should Not Show" }
            : id === "ghost"
              ? { id, status: "unknown", name: null }
              : { id, status: "active", name: `Name of ${id}` },
        ),
      });
    const result = await resolveIdentities(BEARER, ["alice", "gone", "ghost", "alice"]);
    expect([...result.keys()].sort()).toEqual(["alice", "ghost", "gone"]);
    expect(result.get("alice")).toEqual({ id: "alice", status: "active", name: "Name of alice" });
    expect(result.get("gone")).toEqual({ id: "gone", status: "deleted", name: null });
    expect(result.get("ghost")).toEqual({ id: "ghost", status: "unknown", name: null });
  });

  it("asks auth once for the distinct ids, forwarding the viewer's Bearer and refusing redirects", async () => {
    await resolveIdentities(BEARER, ["alice", "bob", "alice"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${env.AUTH_BASE_URL}/authz/users/identities`);
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>)["Authorization"]).toBe(BEARER);
    expect(call?.ids).toEqual(["alice", "bob"]);
    // A redirect would replay the viewer's Bearer to another host.
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes no call for no ids", async () => {
    expect((await resolveIdentities(BEARER, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("splits more than 100 ids into sequential batches of at most 100 (auth's cap)", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `user-${i}`);
    const result = await resolveIdentities(BEARER, ids);
    expect(calls.map((c) => c.ids.length)).toEqual([100, 100, 50]);
    expect(result.size).toBe(250);
    expect(result.get("user-249")?.name).toBe("Name of user-249");
  });

  it("fails soft on an outage, a refusal, a network error and an unreadable body: everyone `unknown`, nothing thrown", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("down", { status: 503 }),
      () => new Response("slow down", { status: 429 }),
      () => new Response("no", { status: 401 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>", { status: 200 }),
      () => Response.json({ users: "not a list" }),
      () => Response.json(null),
    ];
    for (const failure of failures) {
      answer = failure;
      const result = await quietly(() => resolveIdentities(BEARER, ["alice", "bob"]));
      expect(result.get("alice")).toEqual({ id: "alice", status: "unknown", name: null });
      expect(result.get("bob")).toEqual({ id: "bob", status: "unknown", name: null });
    }
  });

  it("keeps the batches that answered when another batch fails", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `user-${i}`);
    answer = (batch, call) => (call === 1 ? new Response("down", { status: 503 }) : activeAll(batch));
    const result = await quietly(() => resolveIdentities(BEARER, ids));
    expect(result.get("user-0")).toEqual({ id: "user-0", status: "unknown", name: null });
    expect(result.get("user-149")?.name).toBe("Name of user-149");
    expect(result.size).toBe(150);
  });

  it("marks an id auth did not answer `unknown`, and ignores an entry for an id it was not asked about", async () => {
    answer = () =>
      Response.json({
        users: [
          { id: "alice", status: "active", name: "Alice" },
          { id: "mallory", status: "active", name: "Injected" },
        ],
      });
    const result = await resolveIdentities(BEARER, ["alice", "bob"]);
    expect(result.get("alice")?.name).toBe("Alice");
    expect(result.get("bob")).toEqual({ id: "bob", status: "unknown", name: null });
    expect(result.has("mallory")).toBe(false);
  });

  it("reads an odd entry as `unknown`, never as a name", async () => {
    answer = () =>
      Response.json({ users: [{ id: "alice", status: "active", name: "" }, { id: "bob", status: "sorcerer", name: "Bob" }, null, "x", { status: "active" }] });
    const result = await resolveIdentities(BEARER, ["alice", "bob"]);
    // An active person with no readable name is still active, with no name; a status nobody defined is unknown.
    expect(result.get("alice")).toEqual({ id: "alice", status: "active", name: null });
    expect(result.get("bob")).toEqual({ id: "bob", status: "unknown", name: null });
  });

  it("does not send an id auth would refuse the whole batch for (empty, or over 64 characters)", async () => {
    const long = "x".repeat(65);
    const result = await resolveIdentities(BEARER, ["alice", "", long]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(["alice"]);
    expect(result.get("")).toEqual({ id: "", status: "unknown", name: null });
    expect(result.get(long)).toEqual({ id: long, status: "unknown", name: null });
    expect(result.get("alice")?.name).toBe("Name of alice");
  });

  it("logs a failure without the viewer's token or any id", async () => {
    answer = () => new Response("down", { status: 503 });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await resolveIdentities("Bearer secret-viewer-token", ["user-private-id"]);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("503");
      expect(logged).not.toContain("secret-viewer-token");
      expect(logged).not.toContain("user-private-id");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the cache (T46: ADR 20260807 § 3, 60 s, keyed by user id, counted from the send)", () => {
  const ALICE: Identity = { id: "alice", status: "active", name: "Name of alice" };

  it("answers an id named by a 200 from memory until 60 000 ms after its batch was sent, and asks again at that instant", async () => {
    at(0);
    await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(1);
    at(59_999);
    expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual(ALICE);
    expect(calls).toHaveLength(1);
    at(60_000);
    expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual(ALICE);
    expect(calls).toHaveLength(2);
  });

  it("counts the 60 s from when the batch was sent: an answer that arrives 30 s later does not lengthen it", async () => {
    answer = (ids) => {
      at(30_000);
      return activeAll(ids);
    };
    await resolveIdentities(BEARER, ["alice"]);
    answer = activeAll;
    at(59_999);
    await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(1);
    // From the answer (t = 30 s) the entry would hold until 90 s.
    at(60_000);
    await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(2);
  });

  it("gives each batch its own send time: the second of two sequential batches lives 30 s longer when its call went out 30 s later", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `user-${i}`);
    answer = (batch, call) => {
      if (call === 1) at(30_000);
      return activeAll(batch);
    };
    await resolveIdentities(BEARER, ids);
    expect(calls.map((call) => call.ids.length)).toEqual([100, 50]);
    answer = activeAll;
    at(60_000);
    await resolveIdentities(BEARER, ids);
    // The 100 read by the first batch (sent at t = 0) are due; the 50 of the second (sent at t = 30 s) are held until 90 s.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.ids).toEqual(ids.slice(0, 100));
  });

  describe("two reads of one id in flight at once: what the later-sent batch said is kept, in whatever order they answer", () => {
    /** A promise whose answer the test gives when it chooses: the first call is held until `release`. */
    const held = () => {
      let release: (response: Response) => void = () => {};
      const promise = new Promise<Response>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const only = (status: "active" | "deleted", name: string | null) => () => Response.json({ users: [{ id: "alice", status, name }] });

    it("an answer to the batch sent EARLIER, arriving after the later one's, does not replace it", async () => {
      const first = held();
      answer = (_ids, call) => (call === 1 ? first.promise : only("deleted", null)());
      at(0);
      const a = resolveIdentities(BEARER, ["alice"]); // sent at t = 0, held
      at(10_000);
      const b = await resolveIdentities(BEARER, ["alice"]); // sent at t = 10 s, answers `deleted` at once
      expect(calls).toHaveLength(2);
      expect(b.get("alice")).toEqual({ id: "alice", status: "deleted", name: null });
      at(20_000);
      first.release(only("active", "Old")());
      // The read that was waiting shows what its own answer said ...
      expect((await a).get("alice")).toEqual({ id: "alice", status: "active", name: "Old" });
      // ... but memory holds the later question's answer (a person deleted must not read active again) ...
      expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual({ id: "alice", status: "deleted", name: null });
      expect(calls).toHaveLength(2);
      // ... for the 60 s counted from ITS send.
      at(69_999);
      expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual({ id: "alice", status: "deleted", name: null });
      expect(calls).toHaveLength(2);
      at(70_000);
      await resolveIdentities(BEARER, ["alice"]);
      expect(calls).toHaveLength(3);
    });

    it("an answer to the batch sent LATER replaces what an earlier-sent one's brought, when it answers second", async () => {
      const first = held();
      const second = held();
      answer = (_ids, call) => (call === 1 ? first.promise : second.promise);
      at(0);
      const a = resolveIdentities(BEARER, ["alice"]); // sent at t = 0, held
      at(10_000);
      const b = resolveIdentities(BEARER, ["alice"]); // sent at t = 10 s (A has not answered: nothing is held), held
      expect(calls).toHaveLength(2);
      at(20_000);
      first.release(only("active", "Old")());
      await a;
      second.release(only("deleted", null)());
      await b;
      expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual({ id: "alice", status: "deleted", name: null });
      expect(calls).toHaveLength(2);
    });

    it("equal send instants are not 'older': the answer that comes last is the one kept", async () => {
      const first = held();
      answer = (_ids, call) => (call === 1 ? first.promise : only("deleted", null)());
      at(0);
      const a = resolveIdentities(BEARER, ["alice"]); // sent at t = 0, held
      await resolveIdentities(BEARER, ["alice"]); // also sent at t = 0, `deleted`
      first.release(only("active", "Last")());
      await a;
      expect((await resolveIdentities(BEARER, ["alice"])).get("alice")).toEqual({ id: "alice", status: "active", name: "Last" });
      expect(calls).toHaveLength(2);
    });
  });

  it.each([["active"], ["deleted"], ["unknown"]] as const)("keeps a person `auth` answers %s with a 200", async (status) => {
    answer = (ids) => Response.json({ users: ids.map((id) => ({ id, status, name: status === "active" ? "Ada Rossi" : null })) });
    const first = await resolveIdentities(BEARER, ["p"]);
    const second = await resolveIdentities(BEARER, ["p"]);
    expect(calls).toHaveLength(1);
    expect(second.get("p")).toEqual(first.get("p"));
    expect(second.get("p")?.status).toBe(status);
    expect(second.get("p")?.name).toBe(status === "active" ? "Ada Rossi" : null);
  });

  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ["a 429", () => new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })],
    ["a 503", () => new Response("down", { status: 503 })],
    ["a 401", () => new Response("no", { status: 401 })],
    [
      "a thrown TypeError (a network error, or a redirect refused)",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["a 200 with an HTML body", () => new Response("<html>", { status: 200 })],
    ["a 200 whose `users` is a string", () => Response.json({ users: "x" })],
    ["a 200 `null`", () => Response.json(null)],
    ["an item with a status nobody defined", () => Response.json({ users: [{ id: "alice", status: "foo", name: "Alice" }] })],
    ["an item with no id", () => Response.json({ users: [{ status: "active", name: "Alice" }] })],
  ];

  it.each(failures)("never keeps what %s gave: the next call asks again and names the person", async (_label, failure) => {
    answer = failure;
    const first = await quietly(() => resolveIdentities(BEARER, ["alice"]));
    expect(first.get("alice")).toEqual({ id: "alice", status: "unknown", name: null });
    answer = activeAll;
    const second = await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(2);
    expect(second.get("alice")).toEqual(ALICE);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a number", { id: "alice", status: "active", name: 42 }],
    ["an object", { id: "alice", status: "active", name: { first: "Alice" } }],
    ["a list", { id: "alice", status: "active", name: ["Alice"] }],
    ["a boolean", { id: "alice", status: "active", name: true }],
    ["no name member at all", { id: "alice", status: "active" }],
  ])("never keeps an `active` item whose name is %s (an item of any other shape): the read names no one, the next asks again", async (_label, item) => {
    answer = () => Response.json({ users: [item] });
    const first = await resolveIdentities(BEARER, ["alice"]);
    // No readable name is no name; it is `auth`'s contract that is broken, and it is not remembered.
    expect(first.get("alice")).toEqual({ id: "alice", status: "active", name: null });
    expect(__identityCacheSizeForTests()).toBe(0);
    answer = activeAll;
    const second = await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(2);
    expect(second.get("alice")).toEqual(ALICE);
  });

  it.each<[string, string | null, string | null]>([
    ["a name", "Ada Rossi", "Ada Rossi"],
    ["an empty name", "", null],
    ["a null name", null, null],
  ])("keeps an `active` item with %s, the two shapes `auth` sends (z.string().nullable())", async (_label, sent, read) => {
    answer = () => Response.json({ users: [{ id: "alice", status: "active", name: sent }] });
    const first = await resolveIdentities(BEARER, ["alice"]);
    expect(first.get("alice")).toEqual({ id: "alice", status: "active", name: read });
    expect(__identityCacheSizeForTests()).toBe(1);
    await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(1);
  });

  it("never keeps an id the answer left out, and keeps the ones it named", async () => {
    answer = () => Response.json({ users: [{ id: "alice", status: "active", name: "Alice" }] });
    const first = await resolveIdentities(BEARER, ["alice", "bob"]);
    expect(first.get("bob")).toEqual({ id: "bob", status: "unknown", name: null });
    answer = activeAll;
    const second = await resolveIdentities(BEARER, ["alice", "bob"]);
    // Only the omitted one is asked again; the one that was named is not.
    expect(calls.map((call) => call.ids)).toEqual([["alice", "bob"], ["bob"]]);
    expect(second.get("alice")?.name).toBe("Alice");
    expect(second.get("bob")?.name).toBe("Name of bob");
  });

  it("neither returns nor keeps an entry for an id it was not asked about", async () => {
    answer = () =>
      Response.json({
        users: [
          { id: "alice", status: "active", name: "Alice" },
          { id: "mallory", status: "active", name: "Injected" },
        ],
      });
    const first = await resolveIdentities(BEARER, ["alice"]);
    expect(first.has("mallory")).toBe(false);
    answer = activeAll;
    expect((await resolveIdentities(BEARER, ["mallory"])).get("mallory")?.name).toBe("Name of mallory");
    expect(calls).toHaveLength(2);
  });

  it("never serves an entry past its 60 s, not even when the refresh fails: the person is `unknown` for that read, not the old name", async () => {
    at(0);
    await resolveIdentities(BEARER, ["alice"]);
    answer = () => new Response("slow down", { status: 429 });
    at(60_000);
    const result = await quietly(() => resolveIdentities(BEARER, ["alice"]));
    expect(result.get("alice")).toEqual({ id: "alice", status: "unknown", name: null });
    expect(calls).toHaveLength(2);
  });

  it("forgets an entry at the lookup that finds it past its 60 s, so a failing refresh leaves no name in memory (plan § Security: at most 60 s from the question)", async () => {
    at(0);
    await resolveIdentities(BEARER, ["alice"]);
    expect(__identityCacheSizeForTests()).toBe(1);
    // One millisecond short of the 60 s the entry is live: a read finds it, and must not forget it.
    at(59_999);
    await resolveIdentities(BEARER, ["alice"]);
    expect(__identityCacheSizeForTests()).toBe(1);
    expect(calls).toHaveLength(1);
    answer = () => new Response("down", { status: 503 });
    at(60_000);
    const result = await quietly(() => resolveIdentities(BEARER, ["alice"]));
    expect(result.get("alice")).toEqual({ id: "alice", status: "unknown", name: null });
    expect(calls).toHaveLength(2);
    // The refresh failed and nothing replaced the old name: it must not still be held, under the sweep's 5 000 or not.
    expect(__identityCacheSizeForTests()).toBe(0);
  });

  it("leaves what is cached alone when another batch of the same read fails", async () => {
    await resolveIdentities(BEARER, ["alice"]);
    answer = () => new Response("down", { status: 503 });
    const result = await quietly(() => resolveIdentities(BEARER, ["alice", "bob"]));
    expect(result.get("alice")).toEqual(ALICE);
    expect(result.get("bob")).toEqual({ id: "bob", status: "unknown", name: null });
    expect(calls.map((call) => call.ids)).toEqual([["alice"], ["bob"]]);
  });

  it("never sends an id outside 1..64 characters and never keeps it: `unknown` with no call, twice", async () => {
    const long = "x".repeat(65);
    for (let read = 0; read < 2; read++) {
      const result = await resolveIdentities(BEARER, [long, ""]);
      expect(result.get(long)).toEqual({ id: long, status: "unknown", name: null });
      expect(result.get("")).toEqual({ id: "", status: "unknown", name: null });
    }
    expect(calls).toHaveLength(0);
    expect(__identityCacheSizeForTests()).toBe(0);
  });

  it("asks only for the ids the cache does not hold: 150 ids of which 50 are cached are one call carrying the other 100", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `user-${i}`);
    await resolveIdentities(BEARER, ids.slice(0, 50));
    const result = await resolveIdentities(BEARER, ids);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.ids).toEqual(ids.slice(50));
    expect(result.size).toBe(150);
    expect(result.get("user-0")?.name).toBe("Name of user-0");
    expect(result.get("user-149")?.name).toBe("Name of user-149");
  });

  it("makes no call at all when every id is held", async () => {
    await resolveIdentities(BEARER, ["alice", "bob"]);
    const result = await resolveIdentities(BEARER, ["bob", "alice", "bob"]);
    expect(calls).toHaveLength(1);
    expect([...result.keys()].sort()).toEqual(["alice", "bob"]);
  });

  it("keys by user id alone: a second viewer is answered from what the first viewer's read brought", async () => {
    await resolveIdentities("Bearer first-viewer", ["alice"]);
    const result = await resolveIdentities("Bearer second-viewer", ["alice"]);
    expect(result.get("alice")).toEqual(ALICE);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer first-viewer");
  });

  it("forgets everything on `__resetIdentityCacheForTests`", async () => {
    await resolveIdentities(BEARER, ["alice"]);
    expect(__identityCacheSizeForTests()).toBe(1);
    __resetIdentityCacheForTests();
    expect(__identityCacheSizeForTests()).toBe(0);
    await resolveIdentities(BEARER, ["alice"]);
    expect(calls).toHaveLength(2);
  });

  describe("expired entries are swept once the map reaches 5 000", () => {
    const people = (count: number) => Array.from({ length: count }, (_, i) => `user-${i}`);

    it("5 000 expired entries are gone after the next fetch", async () => {
      at(0);
      await resolveIdentities(BEARER, people(5_000));
      expect(__identityCacheSizeForTests()).toBe(5_000);
      at(60_000);
      await resolveIdentities(BEARER, ["fresh"]);
      expect(__identityCacheSizeForTests()).toBe(1);
    });

    it("sweeps expired entries only, and not before the map has reached 5 000", async () => {
      at(0);
      await resolveIdentities(BEARER, people(4_999));
      at(60_000);
      // 4 999 expired entries: below the threshold nothing is swept (and none is served).
      await resolveIdentities(BEARER, ["fresh-1"]);
      expect(__identityCacheSizeForTests()).toBe(5_000);
      // At the threshold the next fetch sweeps the 4 999 expired ones, whose ids nobody asked about (an id that IS asked
      // about is forgotten by its own lookup, never reaching the sweep: "forgets an entry at the lookup").
      await resolveIdentities(BEARER, ["fresh-2"]);
      expect(calls.at(-1)?.ids).toEqual(["fresh-2"]);
      expect(__identityCacheSizeForTests()).toBe(2);
      // Live entries are never swept: both are still answered without a call.
      const before = calls.length;
      await resolveIdentities(BEARER, ["fresh-1", "fresh-2"]);
      expect(calls).toHaveLength(before);
    });
  });
});
