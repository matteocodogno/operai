/**
 * What a person's own writes do to an automatic entry (specs/20261112-meeting-hours T5; plan § "The person's writes",
 * § API contracts "hours-api — changed"; AC-2.3, AC-2.4, AC-2.5), through the ASSEMBLED app against the real
 * database and the fake hosts.
 *
 * Operai writes an automatic entry (`apply()`, T6); here it is inserted directly with `makeMeetingEntry(…, { automatic })`
 * and then read, changed and deleted by its person through the routes — the only other writers of those rows:
 *   - a successful PATCH stops the entry following its meeting (`followsMeeting = false`, A39) and keeps its
 *     `origin: meeting` (AC-2.3); a PATCH that is refused writes nothing, so the entry still follows (AC-2.4);
 *   - a DELETE removes the person's own entry and, when it came from a meeting, blocks it from coming back
 *     in the SAME transaction (AC-2.5).
 *
 * Time is fixed at 2026-11-13 10:00Z (a Friday, 11:00 in Zurich), as in write.test.ts.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { spyOn } from "bun:test";
import {
  PERSONAS,
  SEED,
  call,
  db,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "./today";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const patch = (id: string, payload: unknown, as: PersonaName | null = "alice") => call("PATCH", `/time-entries/${id}`, { as, body: payload });
const remove = (id: string, as: PersonaName | null = "alice") => call("DELETE", `/time-entries/${id}`, { as });
const row = (id: string) => db.timeEntry.findUniqueOrThrow({ where: { id } });
const blocks = () => db.meetingHoursBlock.findMany({ orderBy: [{ meetingId: "asc" }, { userId: "asc" }] });

describe("every route that returns an entry says who wrote it: `origin` (AC-2.3)", () => {
  it("answers `person` for an entry recorded with POST, and the List — mine, and everyone's for a holder of read-all — tells an automatic entry from it", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    const typed = await call("POST", "/time-entries", { body: { day: "2026-11-12", minutes: 60, on: { type: "none", categoryId: SEED.categories.training } } });
    expect(typed.status).toBe(201);
    expect(typed.json.origin).toBe("person");
    const automatic = await makeMeetingEntry("m1", { automatic: "untouched", day: "2026-11-12" });
    const theirs = await makeMeetingEntry("m1", { automatic: "untouched", day: "2026-11-12", userId: BOB });
    const originsOf = (res: { json: { items: Array<{ id: string; origin: string }> } }) => Object.fromEntries(res.json.items.map((item) => [item.id, item.origin]));

    const mine = await call("GET", "/time-entries?from=2026-11-01&to=2026-11-30");
    const everyones = await call("GET", "/time-entries?whose=all&from=2026-11-01&to=2026-11-30", { as: "holder" });

    expect(mine.status).toBe(200);
    expect(originsOf(mine)).toEqual({ [typed.json.id]: "person", [automatic.id]: "meeting" });
    expect(everyones.status).toBe(200);
    expect(originsOf(everyones)).toEqual({ [typed.json.id]: "person", [automatic.id]: "meeting", [theirs.id]: "meeting" });
  });
});

describe("PATCH /time-entries/{id} on an automatic entry stops it following its meeting (AC-2.4, A39)", () => {
  it("clears `followsMeeting` on a saved change of the day, the duration or the note, and the view still says `origin: meeting` (AC-2.3)", async () => {
    const changes: Array<[string, Record<string, unknown>]> = [
      ["m-day", { day: "2026-11-10" }],
      ["m-minutes", { minutes: 90 }],
      ["m-note", { note: "Only the first half" }],
    ];
    for (const [meetingId, change] of changes) {
      const entry = await makeMeetingEntry(meetingId, { automatic: "untouched" });
      expect((await row(entry.id)).followsMeeting).toBe(true);

      const res = await patch(entry.id, change);

      expect({ meetingId, status: res.status }).toEqual({ meetingId, status: 200 });
      expect(res.json).toMatchObject({ id: entry.id, ...change, origin: "meeting" });
      expect({ case: meetingId, ...(await row(entry.id)) }).toMatchObject({ case: meetingId, origin: "meeting", sourceMeetingId: meetingId, followsMeeting: false });
    }
  });

  it("clears it in the same statement that carries the entry to another target, which the schema allows only once it no longer follows (CHECK time_entry_follows_shape)", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeMeetingEntry("m1", { automatic: "untouched" });

    const res = await patch(entry.id, { on: { type: "project", id: "p1" } });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ on: { type: "project", id: "p1" }, origin: "meeting" });
    // It remembers its meeting even from the project: `origin` stays `meeting` (read by the delete sentence, D70; hours-ui hides the mark while it is on a project, AC-2.3, D67), and the unique index keeps it the person's only one for `m1`.
    expect(await row(entry.id)).toMatchObject({ target: "project", projectId: "p1", meetingId: null, origin: "meeting", sourceMeetingId: "m1", followsMeeting: false });
  });

  it("keeps `origin: meeting` through every later change, for an entry that no longer follows too", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "touched", minutes: 90 });

    const res = await patch(entry.id, { minutes: 120 });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ minutes: 120, origin: "meeting" });
    expect(await row(entry.id)).toMatchObject({ origin: "meeting", sourceMeetingId: "m1", followsMeeting: false });
  });

  it("changes nothing about the origin of an entry the person typed: it stays `person`, not following, never given a meeting", async () => {
    const mine = await makeMeetingEntry("m1");

    const res = await patch(mine.id, { minutes: 90 });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ minutes: 90, origin: "person" });
    expect(await row(mine.id)).toMatchObject({ origin: "person", sourceMeetingId: null, followsMeeting: false });
  });
});

describe("a PATCH that is refused writes nothing, so the entry still follows its meeting (AC-2.4)", () => {
  /** Each is refused by a different rule: the day, the duration, the note, the shape of the body, an empty one. */
  const REFUSED: Array<[string, Record<string, unknown>, number]> = [
    ["a future day", { day: "2026-11-14" }, 422],
    ["45 minutes", { minutes: 45 }, 422],
    ["a note of 1001 characters", { note: "x".repeat(1001) }, 422],
    ["a member the contract does not have", { minutes: 60, userId: BOB }, 400],
    ["an empty body", {}, 400],
  ];

  it.each(REFUSED)("%s: the answer is the refusal, the row is byte for byte what it was and still follows", async (_name, payload, status) => {
    const entry = await makeMeetingEntry("m1", { automatic: "untouched", minutes: 60 });
    const before = await row(entry.id);

    const res = await patch(entry.id, payload);

    expect(res.status).toBe(status);
    const after = await row(entry.id);
    expect(after).toEqual(before);
    expect(after.followsMeeting).toBe(true);
  });

  it("is also the answer for an entry that is not the caller's: 404, and the other person's entry still follows", async () => {
    const theirs = await makeMeetingEntry("m1", { automatic: "untouched", userId: BOB });

    expect((await patch(theirs.id, { minutes: 30 }, "alice")).status).toBe(404);
    expect((await patch(theirs.id, { minutes: 30 }, "admin")).status).toBe(404);
    // A holder of `time-entry:read-all` may read it, so it is told why — and nothing changes.
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    expect((await patch(theirs.id, { minutes: 30 }, "holder")).status).toBe(403);

    expect(await row(theirs.id)).toMatchObject({ minutes: 60, followsMeeting: true, userId: BOB });
  });
});

describe("DELETE /time-entries/{id} of an automatic entry blocks it from coming back (AC-2.5)", () => {
  it("writes the block `deleted` for (meeting, caller) with the delete, for an untouched entry and for one the person changed", async () => {
    for (const automatic of ["untouched", "touched"] as const) {
      await resetWorld();
      const entry = await makeMeetingEntry("m1", { automatic });

      const res = await remove(entry.id);

      expect({ automatic, status: res.status, text: res.text }).toEqual({ automatic, status: 204, text: "" });
      expect(await db.timeEntry.count()).toBe(0);
      expect(await blocks()).toMatchObject([{ meetingId: "m1", userId: ALICE, reason: "deleted" }]);
    }
  });

  it("blocks the entry's meeting even when its person had moved it to another target, and only that person on that meeting", async () => {
    const moved = await makeProjectEntry("p1", { userId: ALICE });
    await db.timeEntry.update({ where: { id: moved.id }, data: { origin: "meeting", sourceMeetingId: "m1" } });
    const others = [
      await makeMeetingEntry("m1", { automatic: "untouched", userId: BOB }),
      await makeMeetingEntry("m2", { automatic: "untouched", userId: ALICE }),
    ];

    expect((await remove(moved.id)).status).toBe(204);

    expect(await blocks()).toMatchObject([{ meetingId: "m1", userId: ALICE, reason: "deleted" }]);
    expect(await db.timeEntry.findMany({ select: { id: true }, orderBy: { id: "asc" } })).toEqual(others.map(({ id }) => ({ id })).sort((a, b) => (a.id < b.id ? -1 : 1)));
  });

  it("writes no block for an entry the person typed — on a meeting, a project or no entity", async () => {
    const typed = [await makeMeetingEntry("m1"), await makeProjectEntry("p1"), await makeNoEntityEntry(SEED.categories.training)];

    for (const entry of typed) expect((await remove(entry.id)).status).toBe(204);

    expect(await db.timeEntry.count()).toBe(0);
    expect(await blocks()).toEqual([]);
  });

  it("answers someone else's automatic entry as it does any: 404 — 403 `owner_only` for a holder of read-all — deletes nothing and blocks nobody", async () => {
    const theirs = await makeMeetingEntry("m1", { automatic: "untouched", userId: BOB });
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");

    const asAlice = await remove(theirs.id, "alice");
    const asAdmin = await remove(theirs.id, "admin");
    const asHolder = await remove(theirs.id, "holder");
    const ghost = await remove("cmhx0p3v10000nobody0000000", "alice");

    expect([asAlice.status, asAdmin.status, asHolder.status, ghost.status]).toEqual([404, 404, 403, 404]);
    expect(asHolder.json).toMatchObject({ code: "owner_only" });
    // The 404 is one answer for "not yours" and "no such entry" alike.
    expect({ ...asAlice.json, instance: "", detail: "" }).toEqual({ ...ghost.json, instance: "", detail: "" });
    expect(await row(theirs.id)).toMatchObject({ userId: BOB, followsMeeting: true });
    expect(await blocks()).toEqual([]);
  });

  it("is not an error when the block is already there: the entry is deleted and the block keeps its reason", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "touched" });
    await db.meetingHoursBlock.create({ data: { meetingId: "m1", userId: ALICE, reason: "had_entry" } });

    const res = await remove(entry.id);

    expect(res.status).toBe(204);
    expect(await db.timeEntry.count()).toBe(0);
    expect(await blocks()).toMatchObject([{ meetingId: "m1", userId: ALICE, reason: "had_entry" }]);
  });

  it("answers a second delete of the same entry 404 and leaves the one block it wrote", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "untouched" });

    expect((await remove(entry.id)).status).toBe(204);
    expect((await remove(entry.id)).status).toBe(404);

    expect(await blocks()).toMatchObject([{ meetingId: "m1", userId: ALICE, reason: "deleted" }]);
  });

  it("deletes the entry and writes the block in ONE transaction: the entry is still there while the block's insert waits, and gone with it", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "untouched" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let blockInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (blockInserted = resolve));
    // Another connection inserts the very block the DELETE will write and keeps its transaction open: the DELETE's
    // `INSERT … ON CONFLICT DO NOTHING` has to wait for it to end, which is when its own transaction is still open.
    const competing = db.$transaction(
      async (tx) => {
        await tx.meetingHoursBlock.create({ data: { meetingId: "m1", userId: ALICE, reason: "had_entry" } });
        blockInserted();
        await held;
      },
      { timeout: 15_000 },
    );
    await inserted;

    const deleting = remove(entry.id);
    const waiting = async () => {
      const rows = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return rows[0]!.n > 0;
    };
    try {
      const deadline = Date.now() + 5_000;
      while (!(await waiting()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await waiting()).toBe(true);
      // The block's insert is blocked, so a delete that had committed on its own would be visible by now.
      expect(await db.timeEntry.count()).toBe(1);
    } finally {
      // Whatever the assertions said, the other transaction ends: a connection must not outlive the test.
      release();
      await competing;
    }
    const res = await deleting;

    expect(res.status).toBe(204);
    expect(await db.timeEntry.count()).toBe(0);
    expect(await blocks()).toMatchObject([{ meetingId: "m1", userId: ALICE, reason: "had_entry" }]);
  });

  it("a block the database refuses takes the delete back with it: 500, the entry still there, no block", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "untouched" });
    // A database that refuses the block: the delete statement has already run when the insert fails. A block that were
    // "best effort" would commit the delete with no block, and the next notice would record the entry again (AC-2.5).
    await db.$executeRawUnsafe(`CREATE FUNCTION t24_refuse_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER t24_refuse_block BEFORE INSERT ON meeting_hours_block FOR EACH ROW EXECUTE FUNCTION t24_refuse_block()`);
    const error = spyOn(console, "error").mockImplementation(() => {});
    let res: Awaited<ReturnType<typeof remove>>;
    let logged: unknown[][];
    try {
      res = await remove(entry.id);
    } finally {
      logged = [...error.mock.calls];
      error.mockRestore();
      await db.$executeRawUnsafe(`DROP TRIGGER t24_refuse_block ON meeting_hours_block`);
      await db.$executeRawUnsafe(`DROP FUNCTION t24_refuse_block()`);
    }

    expect(res.status).toBe(500);
    // The fault path of the global handler, not a typed refusal: the entry's own 404/403 answers are not what this is.
    expect(logged.some((args) => args[0] === "[uncaught]")).toBe(true);
    expect(await row(entry.id)).toMatchObject({ userId: ALICE, sourceMeetingId: "m1", followsMeeting: true });
    expect(await blocks()).toEqual([]);
  });

  it("writes the block on the DELETE's own transaction: a delete the database refuses at commit leaves no block behind", async () => {
    const entry = await makeMeetingEntry("m1", { automatic: "untouched" });
    // A constraint trigger deferred to COMMIT refuses the delete only after the block's insert has gone through. A block
    // written on any other connection than the delete's own would already be committed by then; on its transaction it is
    // taken back with the delete. (Nothing else tells the transaction's `tx` from the shared `db`.)
    await db.$executeRawUnsafe(`CREATE FUNCTION t24_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused at commit by the test'; END $$`);
    await db.$executeRawUnsafe(
      `CREATE CONSTRAINT TRIGGER t24_refuse_commit AFTER DELETE ON time_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t24_refuse_commit()`,
    );
    const error = spyOn(console, "error").mockImplementation(() => {});
    let res: Awaited<ReturnType<typeof remove>>;
    try {
      res = await remove(entry.id);
    } finally {
      error.mockRestore();
      await db.$executeRawUnsafe(`DROP TRIGGER t24_refuse_commit ON time_entry`);
      await db.$executeRawUnsafe(`DROP FUNCTION t24_refuse_commit()`);
    }

    expect(res.status).toBe(500);
    expect(await row(entry.id)).toMatchObject({ userId: ALICE, sourceMeetingId: "m1", followsMeeting: true });
    expect(await blocks()).toEqual([]);
  });
});
