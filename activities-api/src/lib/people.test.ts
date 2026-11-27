/**
 * The names of a list are waited for at most `NAMES_WAIT_MS` (specs/20261126-teams R13 b, ADR 20261119-on-demand-outbound-work-...,
 * rule 6): a list route of activities-api sits inside hours-api's 6 s, so a slow `auth` costs the names, which fail soft to
 * `unknown`, never the page. The lookup is NOT aborted: it runs on and fills the 60 s cache, so the next load has them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { authStub, resetWorld } from "../test-support/world";
import { resolveIdentities } from "./identities";
import { loadPeople, NAMES_WAIT_MS } from "./people";

const request = { req: { header: (name: string) => (name === "Authorization" ? "Bearer test" : undefined) } };

let release: () => void = () => {};
const hold = (): void => {
  authStub.identityHold = new Promise<void>((done) => {
    release = done;
  });
};

beforeEach(resetWorld);
// A lookup left running would settle into a later test's cache: every test lets go of what it held.
afterEach(() => release());

const settle = () => new Promise<void>((done) => setTimeout(done, 30));

describe("loadPeople with a slow auth", () => {
  it("waits 800 ms for the names, then answers `unknown` for those not yet known and names the cached ones", async () => {
    expect(NAMES_WAIT_MS).toBe(800);
    await loadPeople(request, ["user-cached"]); // primes the cache
    expect(authStub.identityCalls).toBe(1);

    hold();
    const started = Date.now();
    const { person } = await loadPeople(request, ["user-cached", "user-new"]);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(NAMES_WAIT_MS - 20);
    expect(took).toBeLessThan(NAMES_WAIT_MS + 400);
    expect(person("user-cached")).toEqual({ id: "user-cached", name: "Name of user-cached", status: "active" });
    expect(person("user-new")).toEqual({ id: "user-new", name: null, status: "unknown" });
  });

  it("does not abort the lookup: it fills the cache, so the next load names them with no new call", async () => {
    hold();
    const first = await loadPeople(request, ["user-a", "user-b"]);
    expect(first.person("user-a").status).toBe("unknown");
    expect(authStub.identityCalls).toBe(1);

    release();
    await settle();
    const second = await loadPeople(request, ["user-a", "user-b"]);
    expect(second.person("user-a")).toEqual({ id: "user-a", name: "Name of user-a", status: "active" });
    expect(second.person("user-b").name).toBe("Name of user-b");
    expect(authStub.identityCalls).toBe(1);
  });

  it("returns a snapshot: the answer already handed back does not change when the lookup ends", async () => {
    hold();
    const { person } = await loadPeople(request, ["user-a"]);
    expect(person("user-a").status).toBe("unknown");
    release();
    await settle();
    expect(person("user-a").status).toBe("unknown");
  });

  it("answers at once when auth is fast (no waiting for the timer)", async () => {
    const started = Date.now();
    const { person } = await loadPeople(request, ["user-a"]);
    expect(Date.now() - started).toBeLessThan(NAMES_WAIT_MS / 2);
    expect(person("user-a").name).toBe("Name of user-a");
  });

  it("caches nothing from a failing lookup: the next load asks again", async () => {
    authStub.down = true;
    expect((await loadPeople(request, ["user-a"])).person("user-a").status).toBe("unknown");
    authStub.down = false;
    expect((await loadPeople(request, ["user-a"])).person("user-a").name).toBe("Name of user-a");
  });
});

describe("resolveIdentities with and without a wait", () => {
  it("without `waitMs` waits for the whole lookup, as before", async () => {
    authStub.identityDelayMs = 300;
    const started = Date.now();
    const result = await resolveIdentities("Bearer test", ["user-a"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(result.get("user-a")?.name).toBe("Name of user-a");
  });

  it("with `waitMs` shorter than the lookup answers `unknown` for the uncached, and still answers system actors and invalid ids at once", async () => {
    authStub.identityDelayMs = 300;
    const result = await resolveIdentities("Bearer test", ["user-a", "system:crm-api", ""], { waitMs: 50 });
    expect(result.get("user-a")).toEqual({ id: "user-a", name: null, status: "unknown" });
    expect(result.get("system:crm-api")?.status).toBe("system");
    expect(result.get("")?.status).toBe("unknown");
    await new Promise<void>((done) => setTimeout(done, 350)); // let the run-on lookup settle inside this test
  });

  it("with `waitMs` and a fast lookup answers everything, once", async () => {
    const result = await resolveIdentities("Bearer test", ["user-a", "user-b", "user-gone"], { waitMs: 800 });
    expect(result.get("user-a")?.name).toBe("Name of user-a");
    expect(result.get("user-gone")).toEqual({ id: "user-gone", name: null, status: "deleted" });
    expect(authStub.identityCalls).toBe(1);
  });
});
