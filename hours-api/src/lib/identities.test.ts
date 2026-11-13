/**
 * Display names of the people on entries (specs/029 T10; AC-4.8, ADR-0039): resolved LIVE from
 * `auth POST /authz/users/identities` with the viewer's own Bearer, never stored and never cached
 * here, failing SOFT (`unknown`, the entries stay listed and counted, AC-4.7).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "./env";
import { resolveIdentities } from "./identities";

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

beforeEach(() => {
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

  it("has no cache: a person renamed between two reads shows the new name on the second (AC-4.8)", async () => {
    answer = (ids) => Response.json({ users: ids.map((id) => ({ id, status: "active", name: "Ada Rossi" })) });
    expect((await resolveIdentities(BEARER, ["alice"])).get("alice")?.name).toBe("Ada Rossi");
    answer = (ids) => Response.json({ users: ids.map((id) => ({ id, status: "active", name: "Ada Bianchi" })) });
    expect((await resolveIdentities(BEARER, ["alice"])).get("alice")?.name).toBe("Ada Bianchi");
    expect(calls).toHaveLength(2);
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
