/**
 * `resolveIdentities` (T9, specs/015-hardware-inventory; ADR-0039): live,
 * id-keyed, chunked at 100, cached briefly, and — above all — never throws.
 * `fetch` is stubbed; no `auth` is involved.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import "../test-support/testAuth"; // environment side effect only
import { __resetIdentityCacheForTests, isSystemActor, resolveIdentities } from "./identities";

type FetchSpy = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let fetchSpy: FetchSpy;

const AUTH = "Bearer caller.jwt.token";

const asked = (call: unknown[]): string[] =>
  (JSON.parse((call[1] as RequestInit).body as string) as { ids: string[] }).ids;

const answer = (users: unknown[]) => Response.json({ users });

/** `mockImplementation` for fetch, minus the `preconnect` member Bun's type demands. */
const stub = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  fetchSpy.mockImplementation(fn as unknown as typeof fetch);

/** A stub that answers every id in the request as an active user named `User <id>`. */
const answerAllActive = () =>
  stub(async (url, init) =>
    answer(asked([url, init]).map((id) => ({ id, status: "active", name: `User ${id}` }))),
  );

beforeEach(() => {
  __resetIdentityCacheForTests();
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe("resolveIdentities", () => {
  it("resolves ids through auth, forwarding the caller's Authorization header", async () => {
    fetchSpy.mockResolvedValue(
      answer([
        { id: "u1", status: "active", name: "Anna Rossi" },
        { id: "u2", status: "deleted", name: "Should Not Show" },
      ]),
    );
    const result = await resolveIdentities(AUTH, ["u1", "u2"]);

    expect(result.get("u1")).toEqual({ id: "u1", status: "active", name: "Anna Rossi" });
    // A deleted user's name is never surfaced, even if auth sent one.
    expect(result.get("u2")).toEqual({ id: "u2", status: "deleted", name: null });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/authz/users/identities");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(AUTH);
    expect(asked(fetchSpy.mock.calls[0]!)).toEqual(["u1", "u2"]);
  });

  it("returns unknown for every id when auth is down (network failure) and does not throw", async () => {
    fetchSpy.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await resolveIdentities(AUTH, ["u1", "u2"]);
    expect(result.get("u1")).toEqual({ id: "u1", status: "unknown", name: null });
    expect(result.get("u2")).toEqual({ id: "u2", status: "unknown", name: null });
  });

  it("returns unknown on a non-2xx answer, a non-JSON body and a body of the wrong shape", async () => {
    for (const response of [
      () => new Response("limit", { status: 429 }),
      () => new Response("boom", { status: 500 }),
      () => new Response("<html/>", { status: 200 }),
      () => Response.json({ nope: true }),
      () => Response.json(null),
    ]) {
      __resetIdentityCacheForTests();
      stub(async () => response());
      const result = await resolveIdentities(AUTH, ["u1"]);
      expect(result.get("u1")).toEqual({ id: "u1", status: "unknown", name: null });
    }
  });

  it("an id auth leaves out of its answer is unknown", async () => {
    fetchSpy.mockResolvedValue(answer([{ id: "u1", status: "active", name: "Anna" }]));
    const result = await resolveIdentities(AUTH, ["u1", "u2"]);
    expect(result.get("u2")).toEqual({ id: "u2", status: "unknown", name: null });
  });

  it("ignores entries it did not ask for and entries with an unreadable shape", async () => {
    fetchSpy.mockResolvedValue(
      answer([
        { id: "intruder", status: "active", name: "Eve" },
        { id: "u1", status: "wizard", name: "Anna" },
        "garbage",
        null,
        { status: "active", name: "No Id" },
      ]),
    );
    const result = await resolveIdentities(AUTH, ["u1"]);
    expect(result.has("intruder")).toBe(false);
    expect(result.size).toBe(1);
    expect(result.get("u1")).toEqual({ id: "u1", status: "unknown", name: null });
  });

  it("an active user with no usable name has a null name, not an empty string", async () => {
    fetchSpy.mockResolvedValue(answer([{ id: "u1", status: "active", name: "" }]));
    expect((await resolveIdentities(AUTH, ["u1"])).get("u1")).toEqual({
      id: "u1",
      status: "active",
      name: null,
    });
  });

  it("maps system:* ids to status system without any network call", async () => {
    const result = await resolveIdentities(AUTH, ["system:launch-seed", "system:legacy-import"]);
    expect(result.get("system:launch-seed")).toEqual({
      id: "system:launch-seed",
      status: "system",
      name: null,
    });
    expect(result.get("system:legacy-import")?.status).toBe("system");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends only the real ids when system ids are mixed in", async () => {
    answerAllActive();
    const result = await resolveIdentities(AUTH, ["u1", "system:launch-seed", "u2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(asked(fetchSpy.mock.calls[0]!)).toEqual(["u1", "u2"]);
    expect(result.get("system:launch-seed")?.status).toBe("system");
    expect(result.get("u1")?.status).toBe("active");
  });

  it("does not look like a system id unless it starts with the prefix", () => {
    expect(isSystemActor("system:x")).toBe(true);
    expect(isSystemActor("systemic")).toBe(false);
    expect(isSystemActor("my-system:x")).toBe(false);
  });

  it("deduplicates ids and asks nothing for an empty list", async () => {
    answerAllActive();
    const result = await resolveIdentities(AUTH, ["u1", "u1", "u1"]);
    expect(asked(fetchSpy.mock.calls[0]!)).toEqual(["u1"]);
    expect(result.size).toBe(1);

    fetchSpy.mockClear();
    expect((await resolveIdentities(AUTH, [])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("splits more than 100 ids into chunks of at most 100, one after the other", async () => {
    answerAllActive();
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const result = await resolveIdentities(AUTH, ids);

    expect(fetchSpy.mock.calls.map((call) => asked(call).length)).toEqual([100, 100, 50]);
    expect(result.size).toBe(250);
    expect(result.get("u249")?.name).toBe("User u249");
  });

  it("a failing chunk degrades only its own ids", async () => {
    let call = 0;
    stub(async (url, init) => {
      call++;
      if (call === 2) throw new Error("timeout");
      return answer(asked([url, init]).map((id) => ({ id, status: "active", name: id })));
    });
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const result = await resolveIdentities(AUTH, ids);

    expect(result.size).toBe(250);
    expect(result.get("u0")?.status).toBe("active"); // chunk 1
    expect(result.get("u150")?.status).toBe("unknown"); // chunk 2 failed
    expect(result.get("u249")?.status).toBe("active"); // chunk 3 still ran
  });

  it("never sends an id auth would reject; it is unknown instead and the rest still resolve", async () => {
    answerAllActive();
    const longId = "x".repeat(65);
    const result = await resolveIdentities(AUTH, ["u1", "", longId]);
    expect(asked(fetchSpy.mock.calls[0]!)).toEqual(["u1"]);
    expect(result.get("")?.status).toBe("unknown");
    expect(result.get(longId)?.status).toBe("unknown");
    expect(result.get("u1")?.status).toBe("active");
  });

  it("caches an answer for a minute: a second call makes no request", async () => {
    answerAllActive();
    await resolveIdentities(AUTH, ["u1"]);
    await resolveIdentities(AUTH, ["u1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure or an omission: the next call asks again", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("down"));
    expect((await resolveIdentities(AUTH, ["u1"])).get("u1")?.status).toBe("unknown");

    answerAllActive();
    expect((await resolveIdentities(AUTH, ["u1"])).get("u1")?.status).toBe("active");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an expired cache entry is fetched again", async () => {
    answerAllActive();
    const realNow = Date.now;
    let now = realNow();
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await resolveIdentities(AUTH, ["u1"]);
      now += 59_000;
      await resolveIdentities(AUTH, ["u1"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      now += 2_000;
      await resolveIdentities(AUTH, ["u1"]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("only the uncached ids of a mixed list are requested", async () => {
    answerAllActive();
    await resolveIdentities(AUTH, ["u1"]);
    fetchSpy.mockClear();
    const result = await resolveIdentities(AUTH, ["u1", "u2"]);
    expect(asked(fetchSpy.mock.calls[0]!)).toEqual(["u2"]);
    expect(result.get("u1")?.status).toBe("active");
  });
});
