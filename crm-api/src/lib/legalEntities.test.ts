/**
 * crm-api's client of the legal-entity registry (specs/20261117-legal-entities T25; AC-1.5, AC-3.2, AC-3.3, AC-5.5; plan
 * decision 7, amendment E14). Auth is a stub `fetch` on a fake monotonic clock: no network, no database. The same clock
 * cases as letterhead-api's T21 (29 / 31 / 59 / 61 s) and the sent-time property.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-support/testAuth";
import { completeEntity, fakeAuth, fakeClock, fakeRegistryClient, fixtureEntities, legalEntitiesFixture, registryOver, type FakeAuth } from "../test-support/fakeRegistry";
import {
  createLegalEntityRegistry,
  LEGAL_ENTITIES_RETRY_AFTER_SECONDS,
  LEGAL_ENTITIES_UNAVAILABLE,
  parseLegalEntities,
  REGISTRY_MAX_BODY_BYTES,
} from "./legalEntities";
import { ProblemError } from "./problem";

const SECOND = 1_000;

async function refusal(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("the read did not fail");
}

let logged: string[] = [];
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = [];
  const keep = (...args: unknown[]) => void logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  warnSpy = spyOn(console, "warn").mockImplementation(keep);
  errorSpy = spyOn(console, "error").mockImplementation(keep);
  logSpy = spyOn(console, "log").mockImplementation(keep);
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("the shared contract fixture", () => {
  it("parses: both entities, in full", () => {
    const parsed = parseLegalEntities(legalEntitiesFixture());
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(["welld_ch", "welld_it"]);
    expect(parsed!.welld_ch).toMatchObject({
      entity: "welld_ch",
      version: 3,
      legalName: "wellD SA",
      vatNumber: "CHE-123.456.789 IVA",
      iban: "CH9300762011623852957",
      ibanPrint: "CH93 0076 2011 6238 5295 7",
      complete: true,
      missing: [],
      invalid: [],
    });
    expect(parsed!.welld_ch.address.it).toEqual(["Via Cantonale 1", "6900 Lugano", "Svizzera"]);
    expect(parsed!.welld_ch.address.en).toEqual(["Via Cantonale 1", "6900 Lugano", "Switzerland"]);
    expect(parsed!.welld_ch.contacts.en).toBe("Phone +41 91 000 00 00 · info@welld.ch");
    // a complete entity that breaks today's rules is still complete, and carries what is wrong (E13)
    expect(parsed!.welld_it.complete).toBe(true);
    expect(parsed!.welld_it.invalid.map((item) => item.reason)).toEqual(["too_long", "too_many_lines", "iban_check_digits"]);
    expect(parsed!.welld_it.invalid[0]).toEqual({ field: "address.it", line: 2, reason: "too_long", limit: 120 });
  });

  it("is what the client reads through a fake auth, unchanged", async () => {
    const registry = registryOver(fakeAuth());
    expect((await registry.all()).entities).toEqual(fixtureEntities());
  });

  it("refuses an answer that is not the contract's", () => {
    const fixture = legalEntitiesFixture() as { items: Record<string, unknown>[] };
    expect(parseLegalEntities(null)).toBeNull();
    expect(parseLegalEntities({})).toBeNull();
    expect(parseLegalEntities({ items: [] })).toBeNull();
    expect(parseLegalEntities({ items: [fixture.items[0]] })).toBeNull();
    expect(parseLegalEntities({ items: [fixture.items[0], fixture.items[0]] })).toBeNull();
    expect(parseLegalEntities({ items: [fixture.items[0], { ...fixture.items[1], version: "3" }] })).toBeNull();
    expect(parseLegalEntities({ items: [fixture.items[0], { ...fixture.items[1], address: { it: [], en: "x" } }] })).toBeNull();
    // an entity this CRM does not know is ignored, not refused
    expect(parseLegalEntities({ items: [...fixture.items, { ...fixture.items[1], entity: "welld_de" }] })).not.toBeNull();
  });
});

describe("the cache rule (AC-3.3, AC-5.5; plan decision 7)", () => {
  let auth: FakeAuth;
  beforeEach(() => {
    auth = fakeAuth();
  });

  it("reads auth with the service token, as GET, refusing redirects", async () => {
    const seen: RequestInit[] = [];
    const registry = createLegalEntityRegistry({
      baseUrl: "http://auth.test/",
      tokens: auth.tokens,
      fetchImpl: ((url: unknown, init?: RequestInit) => {
        seen.push(init!);
        return auth.fetch(url as string, init);
      }) as typeof fetch,
      now: auth.clock.now,
    });
    await registry.all();
    expect(auth.calls).toHaveLength(1);
    expect(auth.calls[0]).toMatchObject({ url: "http://auth.test/system/legal-entities", method: "GET", authorization: "Bearer token-1" });
    expect(seen[0]!.redirect).toBe("error");
    expect(seen[0]!.signal).toBeDefined();
  });

  it("the first read calls auth and a read at 29 s uses the entry without a call", async () => {
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(29 * SECOND);
    await registry.all();
    expect((await registry.get("welld_ch")).legalName).toBe("wellD SA");
    expect(auth.calls).toHaveLength(1);
  });

  it("a read at 31 s refreshes (30 s exactly refreshes too)", async () => {
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(30_000 - 1);
    await registry.all();
    expect(auth.calls).toHaveLength(1);
    auth.clock.advance(1);
    await registry.all();
    expect(auth.calls).toHaveLength(2);
    auth.clock.advance(31 * SECOND);
    await registry.all();
    expect(auth.calls).toHaveLength(3);
  });

  it("a refresh failing at 59 s uses the entry and logs registry_stale_used", async () => {
    const registry = registryOver(auth);
    const first = await registry.all();
    auth.clock.advance(59 * SECOND);
    auth.mode = "down";
    const again = await registry.all();
    expect(again).toBe(first);
    expect(auth.calls).toHaveLength(2);
    expect(logged.some((line) => line.includes("registry_stale_used"))).toBe(true);
  });

  it("a refresh failing at 61 s is 503 legal_entities_unavailable (60 s exactly is still usable)", async () => {
    const registry = registryOver(auth);
    await registry.all();
    auth.mode = "down";
    auth.clock.advance(60_000);
    await registry.all();
    auth.clock.advance(1);
    const error = await refusal(registry.all());
    expect(error.status).toBe(503);
    expect(error.code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    expect(LEGAL_ENTITIES_RETRY_AFTER_SECONDS).toBe(5);
    const at61 = fakeAuth();
    const other = registryOver(at61);
    await other.all();
    at61.mode = "error";
    at61.clock.advance(61 * SECOND);
    expect((await refusal(other.get("welld_it"))).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
  });

  it("no entry yet and auth failing is 503, whatever the failure", async () => {
    for (const mode of ["down", "error", "garbage"] as const) {
      const failing = fakeAuth();
      failing.mode = mode;
      const error = await refusal(registryOver(failing).all());
      expect(error).toMatchObject({ status: 503, code: LEGAL_ENTITIES_UNAVAILABLE });
    }
  });

  it("a refresh that works after a failure replaces the entry, and the 503 is not remembered", async () => {
    const registry = registryOver(auth);
    auth.mode = "down";
    await refusal(registry.all());
    auth.mode = "ok";
    expect((await registry.all()).entities.welld_ch.version).toBe(3);
    auth.save("welld_ch", { legalName: "wellD SA (new)" });
    auth.clock.advance(31 * SECOND);
    expect((await registry.get("welld_ch")).legalName).toBe("wellD SA (new)");
  });

  it("the age is counted from when the request was SENT, not from when the answer arrived", async () => {
    const registry = registryOver(auth);
    auth.latencyMs = 20 * SECOND;
    const first = await registry.all();
    expect(first.sentAt).toBe(1_000_000);
    expect(auth.clock.now()).toBe(1_020_000);
    // 20 s after the answer, 40 s after the send: not fresh any more
    auth.clock.advance(20 * SECOND);
    auth.latencyMs = 0;
    auth.mode = "down";
    await registry.all(); // usable (40 s <= 60 s), after a failed call
    expect(auth.calls).toHaveLength(2);
    // 61 s after the send, 41 s after the answer
    auth.clock.advance(21 * SECOND);
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
  });

  it("a save is read within 31 s by a refresh, and nothing older than 60 s is used after it", async () => {
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(10 * SECOND);
    auth.save("welld_ch");
    auth.clock.advance(19 * SECOND); // 29 s old entry: still the old version, allowed by the 60 s bound
    expect((await registry.get("welld_ch")).version).toBe(3);
    auth.clock.advance(2 * SECOND); // 31 s
    expect((await registry.get("welld_ch")).version).toBe(4);
  });

  it("concurrent reads share one call (single flight)", async () => {
    const registry = registryOver(auth);
    const reads = await Promise.all(Array.from({ length: 8 }, () => registry.all()));
    expect(auth.calls).toHaveLength(1);
    expect(new Set(reads).size).toBe(1);
  });

  it("a hanging auth is 503 within the 5 s bound (a short one here)", async () => {
    const hanging = fakeAuth();
    hanging.mode = "hang";
    const registry = registryOver(hanging, { timeoutMs: 25 });
    const began = performance.now();
    const error = await refusal(registry.all());
    expect(error.code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    expect(performance.now() - began).toBeLessThan(2_000);
  });

  it("a token exchange that never ends is bounded by the same budget", async () => {
    const registry = createLegalEntityRegistry({
      baseUrl: "http://auth.test",
      tokens: { getToken: () => new Promise<string>(() => {}), invalidate() {} },
      fetchImpl: auth.fetch,
      now: auth.clock.now,
      timeoutMs: 25,
    });
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    expect(auth.calls).toHaveLength(0);
  });

  it("a body over 64 KiB is refused, announced or not", async () => {
    const huge = JSON.stringify({ items: [], pad: "x".repeat(REGISTRY_MAX_BODY_BYTES) });
    for (const announced of [true, false]) {
      const registry = createLegalEntityRegistry({
        baseUrl: "http://auth.test",
        tokens: auth.tokens,
        now: auth.clock.now,
        fetchImpl: (async () =>
          new Response(huge, { status: 200, headers: announced ? { "Content-Length": String(huge.length) } : { "Transfer-Encoding": "chunked" } })) as unknown as typeof fetch,
      });
      expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    }
    expect(logged.some((line) => line.includes("body too large"))).toBe(true);
  });

  it("an answer that is not JSON, or is not the contract's, is a failed refresh", async () => {
    for (const body of ["<html>", "{", JSON.stringify({ items: "x" })]) {
      const registry = createLegalEntityRegistry({
        baseUrl: "http://auth.test",
        tokens: auth.tokens,
        now: auth.clock.now,
        fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      });
      expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    }
  });

  it("a redirect is a failed refresh (the request carries a credential)", async () => {
    const registry = createLegalEntityRegistry({
      baseUrl: "http://auth.test",
      tokens: auth.tokens,
      now: auth.clock.now,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        throw new TypeError("Redirect not allowed");
      }) as unknown as typeof fetch,
    });
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
  });
});

describe("the service token (401 drops it, once)", () => {
  it("a 401 drops the token and the retry takes a fresh one", async () => {
    const auth = fakeAuth();
    auth.unauthorizedNext = 1;
    const registry = registryOver(auth);
    const answer = await registry.all();
    expect(answer.entities.welld_ch.version).toBe(3);
    expect(auth.invalidated).toEqual(["token-1"]);
    expect(auth.calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("a second 401 is the failure: one retry, no more", async () => {
    const auth = fakeAuth();
    auth.unauthorizedNext = 5;
    const registry = registryOver(auth);
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    expect(auth.calls).toHaveLength(2);
  });

  it("a token that cannot be had is a failed refresh, and the entry is used within 60 s", async () => {
    const auth = fakeAuth();
    let broken = false;
    const registry = createLegalEntityRegistry({
      baseUrl: "http://auth.test",
      tokens: {
        async getToken() {
          if (broken) throw new Error("auth is down SECRET-TOKEN-DETAIL");
          return auth.tokens.getToken();
        },
        invalidate: (token) => auth.tokens.invalidate(token),
      },
      fetchImpl: auth.fetch,
      now: auth.clock.now,
    });
    const first = await registry.all();
    broken = true;
    auth.clock.advance(45 * SECOND);
    expect(await registry.all()).toBe(first);
    auth.clock.advance(20 * SECOND);
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
    expect(logged.join("\n")).not.toContain("SECRET-TOKEN-DETAIL");
  });
});

describe("fail closed without a service client (E14)", () => {
  it("every read is 503 legal_entities_unavailable and auth is never called", async () => {
    const auth = fakeAuth();
    const registry = createLegalEntityRegistry({ baseUrl: "http://auth.test", tokens: null, fetchImpl: auth.fetch, now: auth.clock.now });
    expect(await refusal(registry.all())).toMatchObject({ status: 503, code: LEGAL_ENTITIES_UNAVAILABLE });
    expect(await refusal(registry.get("welld_ch"))).toMatchObject({ status: 503, code: LEGAL_ENTITIES_UNAVAILABLE });
    auth.clock.advance(5 * SECOND);
    expect((await refusal(registry.all())).status).toBe(503);
    expect(auth.calls).toHaveLength(0);
  });
});

describe("invalidate() (the pin retry)", () => {
  it("forgets the entry: the next read asks auth and sees what was saved", async () => {
    const auth = fakeAuth();
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(5 * SECOND);
    auth.save("welld_ch");
    expect((await registry.get("welld_ch")).version).toBe(3);
    registry.invalidate();
    expect((await registry.get("welld_ch")).version).toBe(4);
    expect(auth.calls).toHaveLength(2);
  });

  it("an invalidated entry is not used as stale: auth failing then is 503", async () => {
    const auth = fakeAuth();
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(5 * SECOND);
    registry.invalidate();
    auth.mode = "down";
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
  });

  it("a refresh already in flight when it is called is neither joined nor cached", async () => {
    const auth = fakeAuth();
    let release: (() => void) | undefined;
    let gated = true;
    const registry = createLegalEntityRegistry({
      baseUrl: "http://auth.test",
      tokens: auth.tokens,
      now: auth.clock.now,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        // the table is read now; the answer is held back
        const answer = await auth.fetch(url as string, init);
        if (gated) {
          gated = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return answer;
      }) as typeof fetch,
    });
    const slow = registry.all(); // sent at the old version
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    auth.save("welld_ch");
    registry.invalidate();
    const fresh = await registry.all(); // a flight of its own, after the save
    expect(fresh.entities.welld_ch.version).toBe(4);
    release!();
    const old = await slow;
    expect(old.entities.welld_ch.version).toBe(3);
    // the late answer did not replace the newer entry
    expect((await registry.all()).entities.welld_ch.version).toBe(4);
    expect(auth.calls).toHaveLength(2);
  });
});

describe("what is logged", () => {
  it("never a token, a value or the text of an answer", async () => {
    const auth = fakeAuth();
    const registry = registryOver(auth);
    await registry.all();
    auth.clock.advance(50 * SECOND);
    auth.mode = "down";
    await registry.all();
    auth.clock.advance(20 * SECOND);
    await refusal(registry.all());
    const text = logged.join("\n");
    expect(text).toContain("registry_stale_used");
    expect(text).toContain("legal_entities_unavailable");
    for (const secret of ["token-1", "wellD SA", "CH9300762011623852957", "Via Cantonale"]) expect(text).not.toContain(secret);
  });
});

describe("the in-memory client of the other tests", () => {
  it("answers what it holds, fails like the real one, and counts invalidations", async () => {
    const fake = fakeRegistryClient({ welld_it: completeEntity("welld_it", { legalName: "Mine" }) });
    expect((await fake.get("welld_it")).legalName).toBe("Mine");
    fake.unavailable();
    expect(await refusal(fake.all())).toMatchObject({ status: 503, code: LEGAL_ENTITIES_UNAVAILABLE });
    fake.unavailable(false);
    fake.invalidate();
    expect(fake.invalidations).toBe(1);
    expect(fake.reads).toBe(2);
  });
});

// ─── The sent-time property ─────────────────────────────────────────────────────────────────────────────────────────

describe("property: a document started at T + 60.001 s never uses an entry sent before the save at T (AC-3.3)", () => {
  /** A small deterministic generator, so a failure names its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it("over random schedules of saves, outages, latencies and documents", async () => {
    let documents = 0;
    let refused = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const next = random(seed);
      const auth = fakeAuth({ clock: fakeClock(5_000_000) });
      const registry = registryOver(auth);
      const saves: { at: number; version: number }[] = [];
      for (let step = 0; step < 60; step += 1) {
        auth.clock.advance(Math.floor(next() * 40_000));
        const roll = next();
        auth.mode = next() < 0.35 ? "down" : "ok";
        auth.latencyMs = next() < 0.3 ? Math.floor(next() * 25_000) : 0;
        if (roll < 0.25) {
          const version = auth.save("welld_ch");
          saves.push({ at: auth.clock.now(), version });
        }
        const started = auth.clock.now();
        let snapshot;
        try {
          snapshot = await registry.all();
        } catch (error) {
          expect(error).toBeInstanceOf(ProblemError);
          refused += 1;
          continue;
        }
        documents += 1;
        // nothing older than 60 s is ever used
        expect(started - snapshot.sentAt, `seed ${seed} step ${step}`).toBeLessThanOrEqual(60_000);
        // a save committed more than 60 s before the document started is in the entry used
        for (const save of saves) {
          if (started > save.at + 60_000) {
            expect(snapshot.entities.welld_ch.version, `seed ${seed} step ${step}: the save at ${save.at}`).toBeGreaterThanOrEqual(save.version);
          }
        }
        // the entry was read after every save it claims to hold, and before no save it lacks: sent >= the saves it shows
        const latest = saves.at(-1);
        if (latest !== undefined && snapshot.sentAt > latest.at) expect(snapshot.entities.welld_ch.version).toBe(latest.version);
      }
    }
    expect(documents).toBeGreaterThan(1_000);
    expect(refused).toBeGreaterThan(100);
  });

  it("the boundary by hand: saved at T, document at T + 60.001 s with auth down is refused, at T + 60 s it is not", async () => {
    const auth = fakeAuth();
    const registry = registryOver(auth);
    await registry.all(); // sent at S, before the save
    const sent = auth.clock.now();
    auth.clock.advance(1);
    const savedAt = auth.clock.now();
    auth.save("welld_ch");
    auth.mode = "down";
    auth.clock.advance(sent + 60_000 - auth.clock.now());
    expect((await registry.all()).entities.welld_ch.version).toBe(3); // 60 s after the send: the old entry, as the bound allows
    auth.clock.advance(1);
    expect(auth.clock.now()).toBeGreaterThan(savedAt);
    expect((await refusal(registry.all())).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
  });
});
