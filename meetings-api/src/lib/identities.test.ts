import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { __resetIdentityCacheForTests, requireIdentities, resolveIdentities, toPersonRef } from "./identities";
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
