/**
 * projects-api's client of auth's `GET /system/teams` (specs/20261126-teams T11; decisions D1, D2, D13; AC-4.6, AC-5.4).
 * Auth is a stub `fetch` on a fake monotonic clock: no network, no database. The cases are those of crm-api's legal
 * entities client (29 / 31 / 59 / 61 s, the sent-time property, single flight, 401 retry), per team.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ProblemError } from "./problem";
import type { ServiceTokenProvider } from "./serviceToken";
import {
  createTeamReader,
  factsOrUnavailable,
  teamsUnavailable,
  TEAMS_FRESH_MS,
  TEAMS_HOST_MARGIN_MS,
  TEAMS_HOST_WAIT_MS,
  TEAMS_MAX_BODY_BYTES,
  TEAMS_MAX_IDS_PER_REQUEST,
  TEAMS_PIGGYBACK_MS,
  TEAMS_TIMEOUT_MS,
  TEAMS_USABLE_MS,
  type TeamFact,
  type TeamReader,
} from "./teams";

const SECOND = 1_000;
const BASE = "http://auth.test";

// ─── the world of one test ────────────────────────────────────────────────────────────────────────────────────────

const fact = (id: string, over: Partial<TeamFact> = {}): TeamFact => ({
  id,
  name: `Team ${id}`,
  archived: false,
  members: [{ id: `${id}-m1`, name: "Ada", active: true, appAccess: true }],
  ...over,
});

interface Call {
  readonly url: URL;
  readonly authorization: string;
  readonly redirect: string | undefined;
  /** The clock when the request went out. */
  readonly at: number;
}

/** A fake auth: `teams` is what it knows; `script` decides each call's fate (a queue, in order; empty = answer). */
function world() {
  let clock = 0;
  const teams = new Map<string, TeamFact>();
  const calls: Call[] = [];
  /** Per call, in order: what happens. After the queue is empty every call answers. */
  const script: Array<"answer" | "fail" | "401" | "garbage" | "hang" | "hold" | { delayMs: number }> = [];
  /** Releases of the calls the `hold` fate is holding, in call order. A held call answers (as an ordinary one) once released. */
  const holds: Array<() => void> = [];
  let tokenSeq = 1;
  const invalidated: string[] = [];
  const tokens: ServiceTokenProvider = {
    getToken: async () => `token-${tokenSeq}`,
    invalidate: (token) => {
      invalidated.push(token);
      tokenSeq++;
    },
  };

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("Authorization") ?? "", redirect: init?.redirect, at: clock });
    const fate = script.shift() ?? "answer";
    if (fate === "fail") return new Response("down", { status: 503 });
    if (fate === "401") return new Response("no", { status: 401 });
    if (fate === "garbage") return new Response("{ not json", { status: 200 });
    if (fate === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (fate === "hold") {
      await new Promise<void>((release, reject) => {
        holds.push(release);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (typeof fate === "object") clock += fate.delayMs;
    const ids = url.searchParams.get("ids")?.split(",");
    if (ids) {
      return Response.json({ items: ids.flatMap((id) => (teams.has(id) ? [teams.get(id)!] : [])) });
    }
    const q = url.searchParams.get("q")?.toLowerCase();
    const active = [...teams.values()].filter((t) => !t.archived && (q === undefined || t.name.toLowerCase().includes(q)));
    return Response.json({ items: active.slice(0, 50).map(({ id, name }) => ({ id, name })), truncated: active.length > 50 });
  }) as unknown as typeof fetch;

  return {
    teams,
    calls,
    script,
    holds,
    release: (index = 0) => holds[index]!(),
    invalidated,
    tokens,
    fetchImpl,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    idsOf: (call: Call): string[] => call.url.searchParams.get("ids")?.split(",") ?? [],
    reader: (over: Partial<Parameters<typeof createTeamReader>[0]> = {}): TeamReader =>
      createTeamReader({ baseUrl: BASE, tokens, fetchImpl, now: () => clock, ...over }),
  };
}

let logged: string[] = [];
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = [];
  const keep = (...args: unknown[]) => void logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  warnSpy = spyOn(console, "warn").mockImplementation(keep);
  errorSpy = spyOn(console, "error").mockImplementation(keep);
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("the constants of the cache rule (D2)", () => {
  it("30 s fresh, 60 s usable, a piggyback from 15 s, ids in chunks of 50, a body of at most 1 MiB", () => {
    expect(TEAMS_FRESH_MS).toBe(30_000);
    expect(TEAMS_USABLE_MS).toBe(60_000);
    expect(TEAMS_PIGGYBACK_MS).toBe(15_000);
    expect(TEAMS_MAX_IDS_PER_REQUEST).toBe(50);
    expect(TEAMS_MAX_BODY_BYTES).toBe(1024 * 1024);
  });
});

describe("the cached read: used to t + 30 s, refreshed after (AC-4.6)", () => {
  it("asks auth as the service (Bearer, no redirects, ids mode) and gets the team's facts", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const read = await w.reader().cached(["t1"]);
    expect(read.teams.get("t1")).toEqual(fact("t1"));
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url.pathname).toBe("/system/teams");
    expect(w.calls[0]!.url.searchParams.get("ids")).toBe("t1");
    expect(w.calls[0]!.url.searchParams.get("state")).toBeNull();
    expect(w.calls[0]!.authorization).toBe("Bearer token-1");
    expect(w.calls[0]!.redirect).toBe("error");
  });

  it("uses an entry younger than 30 s without a call, and refreshes it from 30 s", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(29 * SECOND);
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(1);
    w.advance(1 * SECOND); // exactly 30 s: no longer younger than 30 s
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(2);
  });

  it("serves a change made after the entry was sent only from the next refresh (this is what AC-4.6's 60 s bound is made of)", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.teams.set("t1", fact("t1", { members: [] }));
    expect((await reader.cached(["t1"])).teams.get("t1")!.members).toHaveLength(1);
    w.advance(31 * SECOND);
    expect((await reader.cached(["t1"])).teams.get("t1")!.members).toHaveLength(0);
  });

  it("stamps an entry with the time its request was SENT, not when the answer arrived", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    w.script.push({ delayMs: 29 * SECOND }); // sent at 0, answered at 29 s
    await reader.cached(["t1"]);
    expect(w.now()).toBe(29 * SECOND);
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(1); // 29 s old by its send time
    w.advance(2 * SECOND); // 31 s since it was sent; only 2 s since it arrived
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(2);
  });

  it("an id auth does not know is in neither part of the answer and is not remembered", async () => {
    const w = world();
    const read = await w.reader().cached(["nope"]);
    expect(read.teams.size).toBe(0);
    expect(read.unavailable.size).toBe(0);
  });

  it("an empty list makes no call", async () => {
    const w = world();
    const read = await w.reader().cached([]);
    expect(read.teams.size + read.unavailable.size).toBe(0);
    expect(w.calls).toHaveLength(0);
  });

  it("asks once for an id given twice", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    await w.reader().cached(["t1", "t1"]);
    expect(w.idsOf(w.calls[0]!)).toEqual(["t1"]);
  });
});

describe("a failed refresh: the entry up to t + 60 s, then unavailable (AC-4.6, AC-5.4)", () => {
  it("uses an entry of at most 60 s and logs `teams_stale_used`", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(59 * SECOND);
    w.script.push("fail");
    const read = await reader.cached(["t1"]);
    expect(read.teams.get("t1")).toEqual(fact("t1"));
    expect(read.unavailable.size).toBe(0);
    expect(logged.some((line) => line.includes("teams_stale_used"))).toBe(true);
  });

  it("an entry of exactly 60 s is still used; one of 60 s and a little is not", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(60 * SECOND);
    w.script.push("fail");
    expect((await reader.cached(["t1"])).teams.has("t1")).toBe(true);
    w.advance(1);
    w.script.push("fail");
    const read = await reader.cached(["t1"]);
    expect(read.teams.has("t1")).toBe(false);
    expect([...read.unavailable.keys()]).toEqual(["t1"]);
  });

  it("with no entry a failure is 'unavailable', never an empty team", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("fail");
    const read = await w.reader().cached(["t1"]);
    expect(read.teams.size).toBe(0);
    expect([...read.unavailable.keys()]).toEqual(["t1"]);
    expect(logged.some((line) => line.includes("teams_unavailable"))).toBe(true);
  });

  it("an unreadable body, a timeout and a missing service credential are failed refreshes too", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("garbage");
    expect((await w.reader().cached(["t1"])).unavailable.has("t1")).toBe(true);

    w.script.push("hang");
    expect((await w.reader({ timeoutMs: 20 }).cached(["t1"])).unavailable.has("t1")).toBe(true);

    const noClient = w.reader({ tokens: null });
    const read = await noClient.cached(["t1"]);
    expect(read.unavailable.has("t1")).toBe(true);
    // no credential, no call: the first two cases made the only two
    expect(w.calls).toHaveLength(2);
  });

  it("a token that cannot be obtained is a failed refresh", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const tokens: ServiceTokenProvider = { getToken: async () => Promise.reject(new Error("secret-bearing message")), invalidate: () => {} };
    const read = await w.reader({ tokens }).cached(["t1"]);
    expect(read.unavailable.has("t1")).toBe(true);
    expect(w.calls).toHaveLength(0);
    // an error's own text never reaches a log
    expect(logged.join("\n")).not.toContain("secret-bearing");
  });

  it("a malformed answer is a failed refresh: an item that was not asked for, a duplicate, a wrong type", async () => {
    const w = world();
    const reader = (reply: unknown) =>
      w.reader({ fetchImpl: (async () => Response.json(reply)) as unknown as typeof fetch });
    const good = { id: "t1", name: "T", archived: false, members: [] };
    expect((await reader({ items: [{ ...good, id: "other" }] }).cached(["t1"])).unavailable.has("t1")).toBe(true);
    expect((await reader({ items: [good, good] }).cached(["t1"])).unavailable.has("t1")).toBe(true);
    expect((await reader({ items: [{ ...good, archived: "no" }] }).cached(["t1"])).unavailable.has("t1")).toBe(true);
    expect((await reader({ items: [{ ...good, members: [{ id: "u", name: 1, active: true, appAccess: true }] }] }).cached(["t1"])).unavailable.has("t1")).toBe(true);
    expect((await reader({ items: "x" }).cached(["t1"])).unavailable.has("t1")).toBe(true);
    // and the well-formed one is read
    expect((await reader({ items: [good] }).cached(["t1"])).teams.has("t1")).toBe(true);
  });

  it("a body over 1 MiB is refused, by its announced length and by what is read", async () => {
    const w = world();
    const big = "x".repeat(TEAMS_MAX_BODY_BYTES + 1);
    const announced = w.reader({
      fetchImpl: (async () => new Response("{}", { headers: { "Content-Length": String(TEAMS_MAX_BODY_BYTES + 1) } })) as unknown as typeof fetch,
    });
    expect((await announced.cached(["t1"])).unavailable.has("t1")).toBe(true);
    const streamed = w.reader({
      fetchImpl: (async () => new Response(`{"items":[],"pad":"${big}"}`)) as unknown as typeof fetch,
    });
    expect((await streamed.cached(["t1"])).unavailable.has("t1")).toBe(true);
  });

  it("an unavailable team carries the name and state of an entry that is held, however old, else null", async () => {
    const w = world();
    w.teams.set("t1", fact("t1", { name: "Backend", archived: true }));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(5 * 60 * SECOND);
    w.script.push("fail");
    const read = await reader.cached(["t1", "t2"]);
    expect(read.unavailable.get("t1")).toEqual({ name: "Backend", archived: true });
    expect(read.unavailable.get("t2")).toBeNull();
  });
});

describe("the proof of AC-4.6: nothing older than 60 s is ever used, whatever the call order", () => {
  it("a decision at t uses an entry sent at s >= t - 60 s", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]); // sent at 0
    for (const t of [10, 29, 45, 60, 61, 120]) {
      w.script.push("fail");
      const at = t * SECOND;
      w.advance(at - w.now());
      const read = await reader.cached(["t1"]);
      const used = read.teams.has("t1");
      // a failed refresh leaves only the entry sent at 0 to use
      expect(used).toBe(at < TEAMS_FRESH_MS || at <= TEAMS_USABLE_MS);
    }
  });
});

describe("single flight, and one call for the cache's entries together", () => {
  it("concurrent reads of one team make one call", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    const [a, b, c] = await Promise.all([reader.cached(["t1"]), reader.cached(["t1"]), reader.cached(["t1"])]);
    expect(w.calls).toHaveLength(1);
    for (const read of [a, b, c]) expect(read.teams.get("t1")).toEqual(fact("t1"));
  });

  it("a read of an id already in flight joins it and asks only for the others", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.teams.set("t2", fact("t2"));
    const reader = w.reader();
    const first = reader.cached(["t1"]);
    const second = reader.cached(["t1", "t2"]);
    await Promise.all([first, second]);
    expect(w.calls.map((call) => w.idsOf(call))).toEqual([["t1"], ["t2"]]);
  });

  it("a failed flight is not remembered: the next read asks again", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    w.script.push("fail");
    expect((await reader.cached(["t1"])).unavailable.has("t1")).toBe(true);
    expect((await reader.cached(["t1"])).teams.has("t1")).toBe(true);
  });

  it("a refresh carries every other entry older than 15 s (so they expire together), and no younger one", async () => {
    const w = world();
    for (const id of ["a", "b", "c"]) w.teams.set(id, fact(id));
    const reader = w.reader();
    await reader.cached(["a"]); // sent at 0
    w.advance(10 * SECOND);
    await reader.cached(["b"]); // sent at 10 s
    w.advance(10 * SECOND); // a is 20 s old, b 10 s
    w.calls.length = 0;
    await reader.cached(["c"]); // needs a call; carries a (older than 15 s) but not b
    expect(w.calls).toHaveLength(1);
    expect(w.idsOf(w.calls[0]!)).toEqual(["c", "a"]);
  });

  it("an entry of exactly 15 s is not carried, one beyond it is; an entry beyond 60 s is not worth carrying", async () => {
    const w = world();
    for (const id of ["a", "z"]) w.teams.set(id, fact(id));
    const reader = w.reader();
    await reader.cached(["a"]);
    w.advance(TEAMS_PIGGYBACK_MS);
    w.teams.set("n", fact("n"));
    w.calls.length = 0;
    await reader.cached(["n"]);
    expect(w.idsOf(w.calls[0]!)).toEqual(["n"]);
    w.advance(1);
    w.teams.set("m", fact("m"));
    w.calls.length = 0;
    await reader.cached(["m"]);
    expect(w.idsOf(w.calls[0]!)).toEqual(["m", "a"]);
    // a has just been refreshed. Let it go past 60 s with nobody asking, then ask for another
    w.advance(61 * SECOND);
    w.calls.length = 0;
    w.teams.set("o", fact("o"));
    await reader.cached(["o"]);
    expect(w.idsOf(w.calls[0]!)).toEqual(["o"]);
  });

  it("a carried entry that comes back unknown is dropped, so it cannot be served as a fact", async () => {
    const w = world();
    w.teams.set("a", fact("a"));
    w.teams.set("c", fact("c"));
    const reader = w.reader();
    await reader.cached(["a"]);
    w.advance(20 * SECOND);
    w.teams.delete("a");
    await reader.cached(["c"]); // carries a, which auth no longer knows
    w.script.push("fail");
    w.advance(11 * SECOND); // 31 s since c, 31 s since a's last good entry
    const read = await reader.cached(["a"]);
    expect(read.teams.has("a")).toBe(false);
  });
});

describe("ids in chunks of 50", () => {
  it("120 teams are read in three calls of 50, 50 and 20, in the order asked", async () => {
    const w = world();
    const ids = Array.from({ length: 120 }, (_, i) => `t${i}`);
    for (const id of ids) w.teams.set(id, fact(id));
    const read = await w.reader().cached(ids);
    expect(w.calls.map((call) => w.idsOf(call).length)).toEqual([50, 50, 20]);
    expect(w.calls.flatMap((call) => w.idsOf(call))).toEqual(ids);
    expect(read.teams.size).toBe(120);
  });

  it("one failed chunk makes only its own teams unavailable", async () => {
    const w = world();
    const ids = Array.from({ length: 60 }, (_, i) => `t${i}`);
    for (const id of ids) w.teams.set(id, fact(id));
    w.script.push("answer", "fail");
    const read = await w.reader().cached(ids);
    expect(read.teams.size).toBe(50);
    expect([...read.unavailable.keys()]).toEqual(ids.slice(50));
  });

  it("an id that is not shaped like an auth id is never sent (it would fail its whole chunk) and is read as unknown", async () => {
    const w = world();
    w.teams.set("good", fact("good"));
    const read = await w.reader().cached(["good", "a,b", "with space", "", "x".repeat(65), "é"]);
    expect(w.calls).toHaveLength(1);
    expect(w.idsOf(w.calls[0]!)).toEqual(["good"]);
    expect([...read.teams.keys()]).toEqual(["good"]);
    expect(read.unavailable.size).toBe(0);
  });
});

describe("a 401 drops the cached service token and retries once", () => {
  it("retries with a new token and answers", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("401");
    const read = await w.reader().cached(["t1"]);
    expect(read.teams.has("t1")).toBe(true);
    expect(w.invalidated).toEqual(["token-1"]);
    expect(w.calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("a second 401 is a failed refresh, with no third call", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("401", "401");
    const read = await w.reader().cached(["t1"]);
    expect(read.unavailable.has("t1")).toBe(true);
    expect(w.calls).toHaveLength(2);
  });

  it("the retry is stamped when IT is sent", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    // dropping the token takes 5 s on the harness clock, so the retry goes out at 5 s
    const tokens: ServiceTokenProvider = {
      getToken: async () => "token",
      invalidate: () => w.advance(5 * SECOND),
    };
    const reader = w.reader({ tokens });
    w.script.push("401", "answer");
    await reader.cached(["t1"]);
    expect(w.calls.map((call) => call.at)).toEqual([0, 5 * SECOND]);
    w.advance(29 * SECOND); // 34 s after the first send, 29 s after the retry's
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(2);
    w.advance(1 * SECOND);
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(3);
  });
});

describe("the fresh read: the project page and the PUT (D2, D15)", () => {
  it("always asks, even when the cache holds a young entry, and refreshes the cache with the answer", async () => {
    const w = world();
    w.teams.set("t1", fact("t1", { name: "Old" }));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.teams.set("t1", fact("t1", { name: "New" })); // a rename
    const read = await reader.fresh(["t1"], { fallback: true });
    expect(read.teams.get("t1")!.name).toBe("New");
    expect(w.calls).toHaveLength(2);
    // the cached path now sees the new name without a call
    expect((await reader.cached(["t1"])).teams.get("t1")!.name).toBe("New");
    expect(w.calls).toHaveLength(2);
  });

  it("does not join a read in flight that was sent before it", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    const cached = reader.cached(["t1"]);
    const fresh = reader.fresh(["t1"], { fallback: true });
    await Promise.all([cached, fresh]);
    expect(w.calls).toHaveLength(2);
  });

  it("carries nothing but its own ids (no piggyback)", async () => {
    const w = world();
    w.teams.set("a", fact("a"));
    w.teams.set("b", fact("b"));
    const reader = w.reader();
    await reader.cached(["a"]);
    w.advance(20 * SECOND);
    w.calls.length = 0;
    await reader.fresh(["b"], { fallback: true });
    expect(w.idsOf(w.calls[0]!)).toEqual(["b"]);
  });

  it("splits more than 50 ids into chunks", async () => {
    const w = world();
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    for (const id of ids) w.teams.set(id, fact(id));
    await w.reader().fresh(ids, { fallback: true });
    expect(w.calls.map((call) => w.idsOf(call).length)).toEqual([50, 1]);
  });

  it("with `fallback`, a failed read uses an entry of at most 60 s (logged) and otherwise says unavailable", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.teams.set("t2", fact("t2"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(40 * SECOND);
    w.script.push("fail");
    const read = await reader.fresh(["t1", "t2"], { fallback: true });
    expect(read.teams.has("t1")).toBe(true);
    expect(read.unavailable.has("t2")).toBe(true);
    expect(logged.some((line) => line.includes("teams_stale_used"))).toBe(true);
  });

  it("without `fallback`, a failed read never uses an entry (the PUT confirms what it adds)", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.script.push("fail");
    const read = await reader.fresh(["t1"], { fallback: false });
    expect(read.teams.size).toBe(0);
    expect(read.unavailable.get("t1")).toEqual({ name: "Team t1", archived: false });
  });

  it("an older answer that arrives after a newer one does not replace it in the cache", async () => {
    const w = world();
    w.teams.set("t1", fact("t1", { name: "Old" }));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 0;
    // the first request is answered with the old name at once but delivered late
    const slowFirst = (async (input: unknown, init?: RequestInit) => {
      const response = await w.fetchImpl(input as string, init);
      if (++n === 1) await gate;
      return response;
    }) as unknown as typeof fetch;
    const reader = w.reader({ fetchImpl: slowFirst });
    const first = reader.fresh(["t1"], { fallback: true }); // sent at 0
    while (w.calls.length < 1) await Promise.resolve();
    w.advance(1 * SECOND);
    w.teams.set("t1", fact("t1", { name: "New" }));
    await reader.fresh(["t1"], { fallback: true }); // sent at 1 s
    release();
    await first;
    expect((await reader.cached(["t1"])).teams.get("t1")!.name).toBe("New");
  });
});

describe("the options read: the attach picker (D13)", () => {
  it("asks `state=active`, with the trimmed text as `q` when there is one, and returns auth's items and `truncated`", async () => {
    const w = world();
    w.teams.set("t1", fact("t1", { name: "Backend" }));
    w.teams.set("t2", fact("t2", { name: "Frontend", archived: true }));
    w.teams.set("t3", fact("t3", { name: "Design" }));
    const reader = w.reader();
    expect(await reader.options()).toEqual({
      items: [
        { id: "t1", name: "Backend" },
        { id: "t3", name: "Design" },
      ],
      truncated: false,
    });
    expect(w.calls[0]!.url.search).toBe("?state=active");
    await reader.options("end");
    expect(w.calls[1]!.url.searchParams.get("q")).toBe("end");
    expect(w.calls[1]!.url.searchParams.get("state")).toBe("active");
    expect(w.calls[1]!.url.searchParams.get("ids")).toBeNull();
  });

  it("sends the text as one query value, whatever characters it holds", async () => {
    const w = world();
    await w.reader().options("a&ids=b %_\\");
    expect(w.calls[0]!.url.searchParams.get("q")).toBe("a&ids=b %_\\");
    expect(w.calls[0]!.url.searchParams.get("ids")).toBeNull();
  });

  it("is never cached: every call goes to auth, and it does not join another", async () => {
    const w = world();
    const reader = w.reader();
    await Promise.all([reader.options("a"), reader.options("a")]);
    await reader.options("a");
    expect(w.calls).toHaveLength(3);
  });

  it("fails with the 503 `teams_unavailable` problem: a failure, a timeout, a 401 after the retry, an unreadable answer", async () => {
    const w = world();
    for (const fate of ["fail", "hang", "garbage"] as const) {
      w.script.push(fate);
      const error = await w.reader({ timeoutMs: 20 }).options().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).status).toBe(503);
      expect((error as ProblemError).code).toBe("teams_unavailable");
    }
    w.script.push("401", "401");
    await expect(w.reader().options()).rejects.toBeInstanceOf(ProblemError);
    await expect(w.reader({ tokens: null }).options()).rejects.toBeInstanceOf(ProblemError);
  });

  it("retries once on a 401 with a new token", async () => {
    const w = world();
    w.script.push("401");
    await w.reader().options();
    expect(w.invalidated).toEqual(["token-1"]);
    expect(w.calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("reads more than the contract's 50 items as an unreadable answer", async () => {
    const w = world();
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
    const reader = w.reader({ fetchImpl: (async () => Response.json({ items, truncated: true })) as unknown as typeof fetch });
    await expect(reader.options()).rejects.toBeInstanceOf(ProblemError);
  });
});

describe("what is logged", () => {
  it("never a token, a team name, a member or a query text", async () => {
    const w = world();
    w.teams.set("t1", fact("t1", { name: "Secretive name" }));
    const reader = w.reader();
    await reader.cached(["t1"]);
    w.advance(45 * SECOND);
    w.script.push("fail");
    await reader.cached(["t1"]);
    w.script.push("fail");
    await reader.options("private search text").catch(() => {});
    const everything = logged.join("\n");
    expect(everything).not.toContain("token-1");
    expect(everything).not.toContain("Secretive");
    expect(everything).not.toContain("Ada");
    expect(everything).not.toContain("private search text");
  });
});

describe("factsOrUnavailable (what onProject reads)", () => {
  it("is the facts when every wanted team is known, else 'unavailable': an unavailable OR unknown team is never 'nobody'", () => {
    const read = { teams: new Map([["a", fact("a")]]), unavailable: new Map([["b", null]]) };
    expect(factsOrUnavailable(read, ["a"])).toBe(read.teams);
    expect(factsOrUnavailable(read, [])).toBe(read.teams);
    expect(factsOrUnavailable(read, ["a", "b"])).toBe("unavailable");
    expect(factsOrUnavailable(read, ["a", "unknown-to-auth"])).toBe("unavailable");
  });
});

describe("teamsUnavailable", () => {
  it("is the 503 `teams_unavailable` problem", () => {
    const problem = teamsUnavailable();
    expect(problem).toBeInstanceOf(ProblemError);
    expect(problem.status).toBe(503);
    expect(problem.code).toBe("teams_unavailable");
  });
});

// ─── The host path waits inside its callers' deadline (D16) ──────────────────────────────────────────────────────────
// Real timers: the wait is a wall-clock bound. The world's clock stays the cache's (ages, send stamps).

const WAIT = 60;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const timed = async <T>(work: Promise<T>): Promise<{ value: T; elapsed: number }> => {
  const started = performance.now();
  const value = await work;
  return { value, elapsed: performance.now() - started };
};

describe("the constants of the host wait (D16)", () => {
  it("wait 800 ms, margin 1 000 ms, a flight's own limit 5 000 ms", () => {
    expect(TEAMS_HOST_WAIT_MS).toBe(800);
    expect(TEAMS_HOST_MARGIN_MS).toBe(1_000);
    expect(TEAMS_TIMEOUT_MS).toBe(5_000);
    expect(TEAMS_HOST_WAIT_MS).toBeLessThan(TEAMS_TIMEOUT_MS);
  });
});

describe("cached() waits at most hostWaitMs for the refreshes it needs (D16, AC-4.6)", () => {
  it("returns at the wait, not before it and well before the flight's limit, unavailable, logging wait_exceeded", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("hold");
    const { value, elapsed } = await timed(w.reader({ hostWaitMs: WAIT, timeoutMs: 5_000 }).cached(["t1"]));
    expect(elapsed).toBeGreaterThanOrEqual(WAIT - 5);
    expect(elapsed).toBeLessThan(WAIT + 400);
    expect(value.teams.size).toBe(0);
    expect(value.unavailable.has("t1")).toBe(true);
    expect(logged.join("\n")).toContain("teams_unavailable");
    expect(logged.join("\n")).toContain("wait_exceeded");
    w.release();
  });

  it("uses an entry of at most 60 s and logs teams_stale_used; an entry over 60 s is unavailable", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader({ hostWaitMs: WAIT });
    await reader.cached(["t1"]);
    w.advance(40 * SECOND);
    w.script.push("hold");
    const stale = await reader.cached(["t1"]);
    expect(stale.teams.get("t1")).toEqual(fact("t1"));
    expect(logged.join("\n")).toContain("teams_stale_used");
    expect(logged.join("\n")).toContain("wait_exceeded");
    w.release();
    await sleep(10);

    w.advance(61 * SECOND);
    w.script.push("hold");
    const old = await reader.cached(["t1"]);
    expect(old.teams.has("t1")).toBe(false);
    expect(old.unavailable.has("t1")).toBe(true);
    w.release(1);
  });

  it("does not abort the flight: released after the wait, it stores the entry with its send stamp, and the next call within 30 s makes no call", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader({ hostWaitMs: WAIT, timeoutMs: 5_000 });
    w.script.push("hold");
    expect((await reader.cached(["t1"])).unavailable.has("t1")).toBe(true);
    w.advance(10 * SECOND); // time passes while the flight is still held: the entry's age is counted from its SEND
    w.release();
    await sleep(20);
    expect(w.calls).toHaveLength(1);
    // sent at 0, now 10 s: fresh, no call
    expect((await reader.cached(["t1"])).teams.get("t1")).toEqual(fact("t1"));
    expect(w.calls).toHaveLength(1);
    // and the stamp is the send time: at 31 s from the send it is refreshed
    w.advance(21 * SECOND);
    await reader.cached(["t1"]);
    expect(w.calls).toHaveLength(2);
  });

  it("a call that starts while the flight runs joins it (no second call) and gets its own full wait", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader({ hostWaitMs: WAIT });
    w.script.push("hold");
    await reader.cached(["t1"]); // gives up at WAIT; the flight runs on
    const { value, elapsed } = await timed(reader.cached(["t1"]));
    expect(elapsed).toBeGreaterThanOrEqual(WAIT - 5); // a full wait of its own, not the first call's remainder
    expect(value.unavailable.has("t1")).toBe(true);
    expect(w.calls).toHaveLength(1);
    // a joiner released inside its wait gets the answer
    const third = reader.cached(["t1"]);
    await sleep(10);
    w.release();
    expect((await third).teams.get("t1")).toEqual(fact("t1"));
    expect(w.calls).toHaveLength(1);
  });

  it("one wait per call: 120 ids in three held chunks return once, at about the wait", async () => {
    const w = world();
    const ids = Array.from({ length: 120 }, (_, i) => `t${i}`);
    for (const id of ids) w.teams.set(id, fact(id));
    w.script.push("hold", "hold", "hold");
    const { value, elapsed } = await timed(w.reader({ hostWaitMs: WAIT }).cached(ids));
    expect(w.calls).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(WAIT - 5);
    expect(elapsed).toBeLessThan(WAIT * 2); // not three waits
    expect(value.unavailable.size).toBe(120);
    for (const index of [0, 1, 2]) w.release(index);
  });

  it("a chunk that settled before the wait is used as answered while a held one counts as failed", async () => {
    const w = world();
    const ids = Array.from({ length: 60 }, (_, i) => `t${i}`);
    for (const id of ids) w.teams.set(id, fact(id));
    w.script.push("answer", "hold");
    const { value } = await timed(w.reader({ hostWaitMs: WAIT }).cached(ids));
    expect(value.teams.size).toBe(50);
    expect(value.unavailable.size).toBe(10);
    w.release();
  });

  it("returns at once, with the timer cleared, when every flight answers before the wait", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const { value, elapsed } = await timed(w.reader({ hostWaitMs: 5_000 }).cached(["t1"]));
    expect(value.teams.has("t1")).toBe(true);
    expect(elapsed).toBeLessThan(200);
    expect(logged).toEqual([]);
  });

  it("starts no timer and makes no call when nothing needs a refresh", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader({ hostWaitMs: 5_000 });
    await reader.cached(["t1"]);
    const { elapsed } = await timed(reader.cached(["t1"]));
    expect(elapsed).toBeLessThan(50);
    expect(w.calls).toHaveLength(1);
  });

  it("a flight still running at its own limit fails as before and is not remembered", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    const reader = w.reader({ hostWaitMs: 20, timeoutMs: 80 });
    w.script.push("hold");
    expect((await reader.cached(["t1"])).unavailable.has("t1")).toBe(true);
    await sleep(120); // the flight hit timeoutMs and aborted
    const second = await reader.cached(["t1"]); // nothing held: a new call, answered
    expect(second.teams.get("t1")).toEqual(fact("t1"));
    expect(w.calls).toHaveLength(2);
  });

  it("makes the same calls with and without the wait (no extra call to auth)", async () => {
    const run = async (hostWaitMs: number | undefined) => {
      const w = world();
      w.teams.set("t1", fact("t1"));
      w.teams.set("t2", fact("t2"));
      const reader = w.reader(hostWaitMs === undefined ? {} : { hostWaitMs });
      await reader.cached(["t1", "t2"]);
      w.advance(20 * SECOND);
      await reader.cached(["t1"]);
      return w.calls.map((call) => w.idsOf(call).join(","));
    };
    expect(await run(WAIT)).toEqual(await run(undefined));
  });
});

describe("fresh() and options() ignore the host wait (D16)", () => {
  it("fresh returns the fact of an answer released after hostWaitMs and before timeoutMs", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("hold");
    const reader = w.reader({ hostWaitMs: WAIT, timeoutMs: 5_000 });
    const read = reader.fresh(["t1"], { fallback: false });
    await sleep(WAIT * 3);
    w.release();
    expect((await read).teams.get("t1")).toEqual(fact("t1"));
  });

  it("options returns the options of an answer released after hostWaitMs and before timeoutMs", async () => {
    const w = world();
    w.teams.set("t1", fact("t1"));
    w.script.push("hold");
    const reader = w.reader({ hostWaitMs: WAIT, timeoutMs: 5_000 });
    const options = reader.options();
    await sleep(WAIT * 3);
    w.release();
    expect((await options).items).toEqual([{ id: "t1", name: "Team t1" }]);
  });
});
