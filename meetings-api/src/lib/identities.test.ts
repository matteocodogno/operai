import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { __resetIdentityCacheForTests, LIST_NAMES_WAIT_MS, REQUEST_TIMEOUT_MS, requireIdentities, resolveIdentities, toPersonRef } from "./identities";
import { ProblemError } from "./problem";

// AC-5.10 / AC-5.12: names are DISPLAY and fail soft; a decision about a person
// (is the creator frozen? is a participant active?) fails closed.

type Answer = { status: number; body?: unknown } | "network-error";
let answers: Answer[];
let requests: { ids: string[]; authorization: string | null }[];
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  __resetIdentityCacheForTests();
  answers = [];
  requests = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe("http://localhost:3001/authz/users/identities");
    const body = JSON.parse(String(init?.body)) as { ids: string[] };
    requests.push({ ids: body.ids, authorization: new Headers(init?.headers).get("Authorization") });
    const next = answers.shift() ?? { status: 200, body: { users: [] } };
    if (next === "network-error") throw new Error("connect ECONNREFUSED");
    return Response.json(next.body ?? {}, { status: next.status });
  }) as unknown as typeof fetch);
  // the outage path logs; keep the test output readable
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fetchSpy.mockRestore();
});

const users = (...u: { id: string; status: string; name?: string }[]) => ({ status: 200, body: { users: u } });

describe("resolveIdentities (display: fails soft)", () => {
  it("maps an active user to a name and forwards the caller's own Authorization header", async () => {
    answers.push(users({ id: "u1", status: "active", name: "Ada Lovelace" }));
    const out = await resolveIdentities("Bearer abc", ["u1"]);
    expect(out.get("u1")).toEqual({ id: "u1", name: "Ada Lovelace", status: "active" });
    expect(requests[0]).toEqual({ ids: ["u1"], authorization: "Bearer abc" });
  });

  it("maps deleted to name null, even if auth sent a name (AC-5.12)", async () => {
    answers.push(users({ id: "u1", status: "deleted", name: "Ada Lovelace" }));
    expect((await resolveIdentities("Bearer abc", ["u1"])).get("u1")).toEqual({ id: "u1", name: null, status: "deleted" });
  });

  it("an identities outage gives status unknown and a null name, for every id asked", async () => {
    answers.push({ status: 503 });
    const out = await resolveIdentities("Bearer abc", ["u1", "u2"]);
    expect(out.get("u1")).toEqual({ id: "u1", name: null, status: "unknown" });
    expect(out.get("u2")).toEqual({ id: "u2", name: null, status: "unknown" });
  });

  it("a network error and a malformed body also degrade to unknown", async () => {
    answers.push("network-error");
    expect((await resolveIdentities("Bearer abc", ["u1"])).get("u1")?.status).toBe("unknown");
    answers.push({ status: 200, body: { users: "nope" } });
    expect((await resolveIdentities("Bearer abc", ["u2"])).get("u2")?.status).toBe("unknown");
  });

  it("ignores an entry for an id it did not ask about", async () => {
    answers.push(users({ id: "u1", status: "active", name: "A" }, { id: "intruder", status: "active", name: "X" }));
    const out = await resolveIdentities("Bearer abc", ["u1"]);
    expect(out.has("intruder")).toBe(false);
  });

  it("answers an id that auth did not return as unknown, and does not cache it", async () => {
    answers.push(users());
    expect((await resolveIdentities("Bearer abc", ["u1"])).get("u1")?.status).toBe("unknown");
    answers.push(users({ id: "u1", status: "active", name: "Back" }));
    expect((await resolveIdentities("Bearer abc", ["u1"])).get("u1")?.name).toBe("Back");
  });

  it("asks once per distinct id and batches by 100", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `u${i}`);
    await resolveIdentities("Bearer abc", [...ids, "u0", "u1"]);
    expect(requests.map((r) => r.ids.length)).toEqual([100, 20]);
  });

  it("caches a definitive answer for display", async () => {
    answers.push(users({ id: "u1", status: "active", name: "Ada" }));
    await resolveIdentities("Bearer abc", ["u1"]);
    await resolveIdentities("Bearer abc", ["u1"]);
    expect(requests).toHaveLength(1);
  });

  it("treats an over-long or empty id as unknown without asking auth", async () => {
    const out = await resolveIdentities("Bearer abc", ["", "x".repeat(65)]);
    expect(out.get("")?.status).toBe("unknown");
    expect(out.get("x".repeat(65))?.status).toBe("unknown");
    expect(requests).toHaveLength(0);
  });
});

// specs/20261126-teams R13 b: a list inside another service's deadline waits at most `waitMs` for the names; everything else
// (`promptSegments`, `view.ts`, the summaries) keeps the whole wait, because a shorter one would put "unknown" speakers into a summary.
describe("resolveIdentities with a bounded wait (R13 b)", () => {
  /** `auth` answers the next call only when the test lets it. */
  function gateAuth() {
    let open!: () => void;
    const gate = new Promise<void>((done) => (open = done));
    fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      requests.push({ ids: body.ids, authorization: new Headers(init?.headers).get("Authorization") });
      await gate;
      return Response.json({ users: body.ids.map((id) => ({ id, status: "active", name: `Name ${id}` })) });
    }) as unknown as typeof fetch);
    return open;
  }
  const settle = () => new Promise<void>((done) => setTimeout(done, 20));

  it("pins the figures: the list wait 800 ms, shorter than the lookup's own 5 000 ms", () => {
    expect(LIST_NAMES_WAIT_MS).toBe(800);
    expect(REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(LIST_NAMES_WAIT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
  });

  it("answers `unknown` for what is not answered in time, names the cached ones, and returns at the wait, not at the answer", async () => {
    answers.push(users({ id: "cached", status: "active", name: "Cached" }));
    await resolveIdentities("Bearer abc", ["cached"]);
    const open = gateAuth();
    const started = Date.now();
    const out = await resolveIdentities("Bearer abc", ["cached", "late"], { waitMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.get("cached")).toEqual({ id: "cached", name: "Cached", status: "active" });
    expect(out.get("late")).toEqual({ id: "late", name: null, status: "unknown" });
    open();
    await settle();
  });

  it("does not abort the lookup: its answer fills the cache, and the snapshot already returned does not change", async () => {
    const open = gateAuth();
    const out = await resolveIdentities("Bearer abc", ["late"], { waitMs: 30 });
    expect(out.get("late")?.status).toBe("unknown");
    open();
    await settle();
    expect(out.get("late")?.status).toBe("unknown"); // the snapshot
    const before = requests.length;
    const again = await resolveIdentities("Bearer abc", ["late"], { waitMs: 30 });
    expect(again.get("late")).toEqual({ id: "late", name: "Name late", status: "active" });
    expect(requests).toHaveLength(before); // no new call
  });

  it("answers at once, with everything, when auth is fast", async () => {
    answers.push(users({ id: "u1", status: "active", name: "Ada" }, { id: "u2", status: "deleted" }));
    const started = Date.now();
    const out = await resolveIdentities("Bearer abc", ["u1", "u2", "", "system:x"], { waitMs: 800 });
    expect(Date.now() - started).toBeLessThan(400);
    expect(out.get("u1")?.name).toBe("Ada");
    expect(out.get("u2")?.status).toBe("deleted");
    expect(out.get("")?.status).toBe("unknown");
    expect(out.get("system:x")?.status).toBe("unknown");
    expect(requests).toHaveLength(1);
  });

  it("caches nothing from a failed lookup, and a failure inside the wait is `unknown` too", async () => {
    answers.push({ status: 503 });
    expect((await resolveIdentities("Bearer abc", ["u1"], { waitMs: 800 })).get("u1")?.status).toBe("unknown");
    answers.push(users({ id: "u1", status: "active", name: "Back" }));
    expect((await resolveIdentities("Bearer abc", ["u1"], { waitMs: 800 })).get("u1")?.name).toBe("Back");
  });

  it("without `waitMs` waits for the whole lookup (unchanged: promptSegments and view.ts rely on it)", async () => {
    const open = gateAuth();
    let done = false;
    const pending = resolveIdentities("Bearer abc", ["u1"]).then((out) => {
      done = true;
      return out;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    open();
    expect((await pending).get("u1")?.name).toBe("Name u1");
  });
});

describe("requireIdentities (decisions: fail closed)", () => {
  it("returns active and deleted users", async () => {
    answers.push(users({ id: "u1", status: "active", name: "Ada" }, { id: "u2", status: "deleted" }));
    const out = await requireIdentities("Bearer abc", ["u1", "u2"]);
    expect(out.get("u1")?.status).toBe("active");
    expect(out.get("u2")).toEqual({ id: "u2", name: null, status: "deleted" });
  });

  it("an identities outage is a 503 identity_unavailable, not an 'unknown' to decide on", async () => {
    answers.push({ status: 503 });
    const error = await requireIdentities("Bearer abc", ["u1"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(503);
    expect((error as ProblemError).code).toBe("identity_unavailable");
  });

  it("a network error is a 503 too", async () => {
    answers.push("network-error");
    expect(((await requireIdentities("Bearer abc", ["u1"]).catch((e: unknown) => e)) as ProblemError).status).toBe(503);
  });

  it("an id auth did not answer is a 503, never silently active or deleted", async () => {
    answers.push(users());
    expect(((await requireIdentities("Bearer abc", ["u1"]).catch((e: unknown) => e)) as ProblemError).status).toBe(503);
  });

  it("an entry with an unreadable status is a 503", async () => {
    answers.push(users({ id: "u1", status: "mystery" }));
    expect(((await requireIdentities("Bearer abc", ["u1"]).catch((e: unknown) => e)) as ProblemError).status).toBe(503);
  });

  it("never serves the display cache: a reactivation shows on the next call (AC-5.11)", async () => {
    answers.push(users({ id: "u1", status: "deleted" }));
    expect((await requireIdentities("Bearer abc", ["u1"])).get("u1")?.status).toBe("deleted");
    answers.push(users({ id: "u1", status: "active", name: "Ada" }));
    expect((await requireIdentities("Bearer abc", ["u1"])).get("u1")?.status).toBe("active");
    expect(requests).toHaveLength(2);
  });

  it("does not let a cached display answer stand in for a gate", async () => {
    answers.push(users({ id: "u1", status: "active", name: "Ada" }));
    await resolveIdentities("Bearer abc", ["u1"]);
    answers.push(users({ id: "u1", status: "deleted" }));
    expect((await requireIdentities("Bearer abc", ["u1"])).get("u1")?.status).toBe("deleted");
  });

  it("an id that can never be an active user comes back deleted without asking auth", async () => {
    const out = await requireIdentities("Bearer abc", ["", "system:crm-api"]);
    expect(out.get("")?.status).toBe("deleted");
    expect(out.get("system:crm-api")?.status).toBe("deleted");
    expect(requests).toHaveLength(0);
  });
});

describe("toPersonRef", () => {
  it("carries id, name and status and nothing else", () => {
    expect(toPersonRef({ id: "u1", name: "Ada", status: "active" })).toEqual({ id: "u1", name: "Ada", status: "active" });
    expect(toPersonRef({ id: "u1", name: null, status: "deleted" })).toEqual({ id: "u1", name: null, status: "deleted" });
  });
});
