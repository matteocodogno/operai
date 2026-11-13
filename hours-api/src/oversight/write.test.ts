/**
 * A holder of `time-entry:read-all` writing someone else's entry (specs/029 T19; AC-1.6, AC-5.2, AC-5.4; plan § Sequences
 * "Oversight", § Errors "Order of the answers", ADR-0075, ADR-0088): the privilege is for LOOKING. Reading everyone's hours
 * never becomes a way to change them, so the holder is told 403 `owner_only` — they can read the entry anyway — while
 * anyone else, and a holder when `auth` cannot say, is told what they are told for an entry that does not exist: 404.
 *
 * The check is asked only when the entry is not the caller's, so the owner's own path never calls `auth`.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, call, db, makeProjectEntry, makeNoEntityEntry, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "./oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const TRAINING = SEED.categories.training;
const GHOST = "cmhx0p3v10000nobody0000000";

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
  hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
});

const patch = (id: string, payload: unknown, as: PersonaName | null = "holder") => call("PATCH", `/time-entries/${id}`, { as, body: payload });
const remove = (id: string, as: PersonaName | null = "holder") => call("DELETE", `/time-entries/${id}`, { as });

/** An answer with the id it was asked about set aside: `instance` echoes the requested path. */
const sameAnswer = (res: { status: number; text: string }, id: string) => ({ status: res.status, text: res.text.replaceAll(id, "<id>") });

/** Alice's entry, and what it must still be after any refused write. */
async function alicesEntry() {
  return makeNoEntityEntry(TRAINING, { userId: ALICE, day: "2026-11-05", minutes: 60, note: "Alice's note" });
}
const rowOf = (id: string) => db.timeEntry.findUnique({ where: { id } });

describe("a holder writing someone else's entry (AC-1.6)", () => {
  it("is 403 owner_only on PATCH and DELETE, whatever the write says, and the row is unchanged", async () => {
    const entry = await alicesEntry();
    const before = await rowOf(entry.id);

    for (const payload of [{ minutes: 90 }, { note: "Changed by the holder" }, { day: "2026-11-06" }, { workTypeId: null }]) {
      const res = await patch(entry.id, payload);
      expect({ payload, status: res.status }).toEqual({ payload, status: 403 });
      expect(res.json).toMatchObject({ status: 403, code: "owner_only" });
    }
    const removed = await remove(entry.id);
    expect(removed.status).toBe(403);
    expect(removed.json).toMatchObject({ status: 403, code: "owner_only" });

    expect(await rowOf(entry.id)).toEqual(before);
  });

  it("is 403 owner_only, never 422, for a write that breaks a rule: the entry is looked up before any rule (lookup before rules)", async () => {
    const entry = await alicesEntry();
    const before = await rowOf(entry.id);

    for (const payload of [{ minutes: 15 }, { minutes: 1500 }, { day: "2026-11-14" }, { note: "x".repeat(1001) }, { on: { type: "none", categoryId: "tc-other" } }]) {
      const res = await patch(entry.id, payload);
      expect({ payload, status: res.status, code: res.json?.code }).toEqual({ payload, status: 403, code: "owner_only" });
    }
    expect(await rowOf(entry.id)).toEqual(before);
  });

  it("asks no owner and records no change when the write would move the entry onto a project", async () => {
    const entry = await alicesEntry();
    hosts.projects.setProject("p1", { label: "Alpha" });

    const res = await patch(entry.id, { on: { type: "project", id: "p1" } });

    expect(res.status).toBe(403);
    expect(hosts.callsTo("projects.resolve")).toEqual([]);
    expect((await rowOf(entry.id))?.target).toBe("none");
  });

  it("does not create an entry on someone's behalf either: POST with a userId is 400 for a holder, and nothing is written", async () => {
    const res = await call("POST", "/time-entries", {
      as: "holder",
      body: { day: "2026-11-12", minutes: 60, on: { type: "none", categoryId: TRAINING }, userId: ALICE },
    });

    expect(res.status).toBe(400);
    expect(await db.timeEntry.count()).toBe(0);
  });

  it("changes and deletes the holder's OWN entry as anyone does: 200 and 204, with no call to auth", async () => {
    const own = await makeNoEntityEntry(TRAINING, { userId: PERSONAS.holder.sub, day: "2026-11-05", minutes: 60 });

    const changed = await patch(own.id, { minutes: 90 });
    expect(changed.status).toBe(200);
    expect(changed.json.minutes).toBe(90);
    expect((await remove(own.id)).status).toBe(204);

    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });

  it("is 404 for an entry that does not exist, as for anyone: the holder is never told 'owner only' about nothing", async () => {
    const asHolder = await patch(GHOST, { minutes: 90 });
    const asNobody = await patch(GHOST, { minutes: 90 }, "alice");
    expect(asHolder.status).toBe(404);
    expect(sameAnswer(asHolder, GHOST)).toEqual(sameAnswer(asNobody, GHOST));

    const removedAsHolder = await remove(GHOST);
    expect(removedAsHolder.status).toBe(404);
    expect(sameAnswer(removedAsHolder, GHOST)).toEqual(sameAnswer(await remove(GHOST, "alice"), GHOST));
  });
});

describe("anyone else writing someone else's entry (AC-1.6)", () => {
  it("is 404, byte-identical to an entry that does not exist once the requested id is set aside — an admin included", async () => {
    const entry = await alicesEntry();
    const before = await rowOf(entry.id);

    for (const as of ["bob", "admin", "manager"] as const) {
      const res = await patch(entry.id, { minutes: 90 }, as);
      expect({ as, status: res.status }).toEqual({ as, status: 404 });
      expect(sameAnswer(res, entry.id)).toEqual(sameAnswer(await patch(GHOST, { minutes: 90 }, as), GHOST));

      const removed = await remove(entry.id, as);
      expect({ as, status: removed.status }).toEqual({ as, status: 404 });
      expect(sameAnswer(removed, entry.id)).toEqual(sameAnswer(await remove(GHOST, as), GHOST));
    }
    expect(await rowOf(entry.id)).toEqual(before);
  });

  it("is 404 for a rule-breaking write too, never the 422: a rule must not tell a stranger the entry exists", async () => {
    const entry = await alicesEntry();
    const res = await patch(entry.id, { minutes: 15 }, "bob");
    expect(res.status).toBe(404);
    expect(sameAnswer(res, entry.id)).toEqual(sameAnswer(await patch(GHOST, { minutes: 15 }, "bob"), GHOST));
  });

  it("is 404 for a holder whose permission was revoked: the next write is decided by what auth says now", async () => {
    const entry = await alicesEntry();
    expect((await patch(entry.id, { minutes: 90 })).status).toBe(403);

    hosts.fail("auth.resolve", { body: { sub: PERSONAS.holder.sub, epoch: 0, permissions: [], entity: null, jobTitle: null } });
    const res = await patch(entry.id, { minutes: 90 });

    expect(res.status).toBe(404);
    expect(sameAnswer(res, entry.id)).toEqual(sameAnswer(await patch(GHOST, { minutes: 90 }), GHOST));
  });
});

describe("an auth that cannot answer (AC-5.4)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["a 500", () => hosts.fail("auth.resolve", { status: 500 })],
    ["a redirect", () => hosts.fail("auth.resolve", { redirect: true })],
    ["a body that is not a permission list", () => hosts.fail("auth.resolve", { body: { permissions: "everything" } })],
    ["an unreachable auth", () => hosts.sever("auth")],
  ];

  for (const [outage, cause] of OUTAGES) {
    it(`is 404 on ${outage}, even for a holder: a write is refused either way, and a stranger learns nothing`, async () => {
      const entry = await alicesEntry();
      const before = await rowOf(entry.id);
      cause();

      const patched = await patch(entry.id, { minutes: 90 });
      const removed = await remove(entry.id);

      expect(patched.status).toBe(404);
      expect(sameAnswer(patched, entry.id)).toEqual({ status: 404, text: sameAnswer(await patch(GHOST, { minutes: 90 }, "alice"), GHOST).text });
      expect(removed.status).toBe(404);
      expect(await rowOf(entry.id)).toEqual(before);
    });
  }

  it("reads only auth's silence as 'no': a database that cannot answer the check is a 500, never a 404 that says there is no such entry", async () => {
    const entry = await alicesEntry();
    // Prisma's model delegate is a proxy `spyOn` cannot patch: swap the property for one whose `count` (the check's
    // only query) fails, and put the real one back.
    const real = db.timeEntry;
    let counts = 0;
    (db as { timeEntry: unknown }).timeEntry = new Proxy(real, {
      get: (target, key) =>
        key === "count"
          ? async () => {
              counts += 1;
              throw new Error("database is down");
            }
          : Reflect.get(target, key),
    });
    try {
      const res = await patch(entry.id, { minutes: 90 });
      expect(counts).toBe(1);
      expect(res.status).toBe(500);
      expect((await remove(entry.id)).status).toBe(500);
    } finally {
      (db as { timeEntry: unknown }).timeEntry = real;
    }
    expect((await rowOf(entry.id))?.minutes).toBe(60);
  });

  it("never reaches the owner's own entry through auth: a person's own writes are served with auth down", async () => {
    const own = await makeNoEntityEntry(TRAINING, { userId: BOB, day: "2026-11-05", minutes: 60 });
    hosts.sever("auth");

    expect((await patch(own.id, { minutes: 90 }, "bob")).status).toBe(200);
    expect((await remove(own.id, "bob")).status).toBe(204);
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });
});

describe("a path {id} outside the id rule (plan amendment 2, 2026-11-13)", () => {
  it("is 400 invalid_request with field id for a holder, a non-holder and the owner alike, and auth is not asked", async () => {
    await alicesEntry();
    for (const id of ["x".repeat(65), "%00", "a%2Cb", "%20a", "a%20"]) {
      for (const as of ["holder", "bob", "alice"] as const) {
        for (const res of [await patch(id, { minutes: 90 }, as), await remove(id, as)]) {
          expect({ id, as, status: res.status }).toEqual({ id, as, status: 400 });
          expect(res.json).toMatchObject({ code: "invalid_request", field: "id" });
        }
      }
    }
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });

  it("is decided by the shape of the body before the lookup: a holder's empty PATCH on someone else's entry is 400, no auth call", async () => {
    const entry = await alicesEntry();

    const res = await patch(entry.id, {});

    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_request", field: "" });
    expect(hosts.callsTo("auth.resolve")).toEqual([]);
  });
});

describe("what the guard remembers", () => {
  it("shares the read path's memory of a refusal: a person refused on a read is not asked again on a write, and the other way round", async () => {
    const entry = await alicesEntry();

    expect((await call("GET", "/time-entries?from=2026-11-01&to=2026-11-30&whose=all", { as: "bob", permEpoch: 5 })).status).toBe(403);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);

    expect((await call("PATCH", `/time-entries/${entry.id}`, { as: "bob", permEpoch: 5, body: { minutes: 90 } })).status).toBe(404);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(1);
  });

  it("never remembers a grant: a holder revoked between two writes is refused on the second", async () => {
    const entry = await alicesEntry();
    expect((await call("PATCH", `/time-entries/${entry.id}`, { as: "holder", permEpoch: 5, body: { minutes: 90 } })).status).toBe(403);

    hosts.fail("auth.resolve", { body: { sub: PERSONAS.holder.sub, epoch: 0, permissions: [], entity: null, jobTitle: null } });
    expect((await call("PATCH", `/time-entries/${entry.id}`, { as: "holder", permEpoch: 5, body: { minutes: 90 } })).status).toBe(404);
    expect(hosts.callsTo("auth.resolve")).toHaveLength(2);
  });

  it("does not let a holder reach a project entry of someone else either", async () => {
    const theirs = await makeProjectEntry("p1", { userId: BOB, day: "2026-11-05" });

    expect((await patch(theirs.id, { minutes: 90 })).status).toBe(403);
    expect((await remove(theirs.id)).status).toBe(403);
    expect(await db.timeEntry.count()).toBe(1);
  });
});
