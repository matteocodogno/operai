/**
 * Recording, changing and deleting an entry (specs/029 T14; AC-1.1 – AC-1.3, AC-1.5 – AC-1.8, AC-2.1, AC-3.1,
 * AC-3.4 – AC-3.6; plan § Entries and § Errors), through the ASSEMBLED app, against the real database and the
 * fake hosts of T11.
 *
 * What an entry is ON decides which owner is asked about bookability (T15 and T16). This file is about the
 * rules hours-api decides alone: the day, the duration, the note, the category and work type, who may touch an
 * entry, and the shape of the body. Entries on no entity need no owner at all.
 *
 * Time is fixed at 2026-11-13 10:00Z (a Friday, 11:00 in Zurich) for every test, so "tomorrow" and "400 days
 * ago" are exact.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  call,
  db,
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  makeWorkType,
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

const NOW = "2026-11-13T10:00:00Z";
const TODAY = "2026-11-13";
const ALICE = PERSONAS.alice.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date(NOW));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** A valid body for an entry on no entity; every member is overridable. */
const none = (categoryId: string = SEED.categories.training) => ({ type: "none", categoryId });
const body = (over: Record<string, unknown> = {}) => ({ day: "2026-11-12", minutes: 60, on: none(), ...over });

const post = (payload: unknown, as: PersonaName | null = "alice") => call("POST", "/time-entries", { as, body: payload });
const patch = (id: string, payload: unknown, as: PersonaName | null = "alice") => call("PATCH", `/time-entries/${id}`, { as, body: payload });

const entryRows = () => db.timeEntry.findMany({ orderBy: { createdAt: "asc" } });

describe("POST /time-entries on no entity (AC-1.1)", () => {
  it("lets a user with no tool grant record hours: 201 with the view, stored for the JWT subject", async () => {
    const res = await post(body({ day: "2026-11-12", minutes: 90, note: "Fixed the expense report" }));

    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      day: "2026-11-12",
      minutes: 90,
      note: "Fixed the expense report",
      person: { id: ALICE, name: "Name of alice", status: "active" },
      on: { type: "none", category: { id: SEED.categories.training, name: "Training", retired: false } },
      workType: null,
      activity: null,
    });
    const rows = await entryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.json.id, userId: ALICE, target: "none", categoryId: SEED.categories.training, minutes: 90, note: "Fixed the expense report" });
    // No owner is asked about hours on no entity: only `auth` names the person in the view.
    expect(hosts.calls.map((recorded) => recorded.route)).toEqual(["auth.identities"]);
  });
});

describe("the duration (AC-1.2)", () => {
  it("refuses 0, 15, 45 and 1470 minutes, and 30.5, with 422 invalid_minutes and writes nothing", async () => {
    for (const minutes of [0, 15, 45, 1470, 30.5, -30, 1500]) {
      const res = await post(body({ minutes }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "invalid_minutes", field: "minutes" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("accepts 30 minutes and 24 hours", async () => {
    for (const minutes of [30, 1440]) {
      const res = await post(body({ minutes }));
      expect(res.status).toBe(201);
      expect(res.json.minutes).toBe(minutes);
    }
  });

  it("refuses a duration that is not a number with 400: it is the shape of the body, not a rule", async () => {
    for (const minutes of ["60", null, [60], { minutes: 60 }, true]) {
      const res = await post(body({ minutes }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "minutes" });
    }
    expect(await entryRows()).toHaveLength(0);
  });
});

/** A day that is not a real calendar day from 2000-01-01 (plan § Entries, "A day"). */
const NOT_A_DAY = [
  "2026-02-30",
  "2025-02-29",
  "2026-13-01",
  "2026-00-10",
  "2026-11-00",
  "1999-12-31",
  "0000-01-01",
  "0050-01-01",
  "2026-2-01",
  "2026-11-13T00:00:00Z",
  "",
] as const;

describe("the day is a real calendar day from 2000-01-01 (AC-1.3; plan amendment 4)", () => {
  it("refuses what is not one with 400 invalid_request naming `day`, never a 500, nothing written", async () => {
    for (const day of NOT_A_DAY) {
      const res = await post(body({ day }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "day" });
    }
    for (const day of [null, 20261112, true, ["2026-11-12"]]) {
      const res = await post(body({ day }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "day" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("never stores the day a parser would roll an impossible one over to", async () => {
    // Bun reads new Date("2026-02-30") as 2 March: without the rule this would be a 201 on the wrong day.
    await post(body({ day: "2026-02-30" }));
    expect(await entryRows()).toHaveLength(0);
  });

  it("accepts the first day, a leap day, and (as a future day, not a malformed one) the last", async () => {
    for (const day of ["2000-01-01", "2024-02-29"]) {
      const res = await post(body({ day }));
      expect(res.status).toBe(201);
      expect(res.json.day).toBe(day);
    }
    const last = await post(body({ day: "9999-12-31" }));
    expect(last.status).toBe(422);
    expect(last.json.code).toBe("future_day");
    expect((await entryRows()).map((row) => row.day.toISOString().slice(0, 10))).toEqual(["2000-01-01", "2024-02-29"]);
  });
});

describe("the day is not after today in Europe/Zurich (AC-1.3)", () => {
  it("accepts today and the days before it, and refuses tomorrow and the far future with 422 future_day", async () => {
    for (const day of [TODAY, "2026-11-12", "2026-01-01"]) expect((await post(body({ day }))).status).toBe(201);

    for (const day of ["2026-11-14", "2027-01-01", "9999-12-31"]) {
      const res = await post(body({ day }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "future_day", field: "day" });
    }
    expect(await entryRows()).toHaveLength(3);
  });

  it("goes by Zurich, not UTC: at 23:30Z the 13th is today, at 22:30Z it is tomorrow", async () => {
    __setClockForTests(() => new Date("2026-11-12T23:30:00Z"));
    expect((await post(body({ day: "2026-11-13" }))).status).toBe(201);
    expect((await post(body({ day: "2026-11-14" }))).status).toBe(422);

    __setClockForTests(() => new Date("2026-11-12T22:30:00Z"));
    const res = await post(body({ day: "2026-11-13" }));
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("future_day");
  });
});

describe("the note's length counts code points (AC-1.7; plan amendment 2)", () => {
  it("accepts 1000 characters and refuses 1001 with 422 note_too_long, writing nothing", async () => {
    const accepted = await post(body({ note: "x".repeat(1000) }));
    expect(accepted.status).toBe(201);
    expect(accepted.json.note).toBe("x".repeat(1000));

    const refused = await post(body({ note: "x".repeat(1001) }));
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: "note_too_long", field: "note" });
    expect(await entryRows()).toHaveLength(1);
  });

  it("counts an emoji once: 1000 of them (2000 UTF-16 units) are stored whole, 1001 are refused", async () => {
    const emoji1000 = "😀".repeat(1000);
    const accepted = await post(body({ note: emoji1000 }));
    expect(accepted.status).toBe(201);
    expect(accepted.json.note).toBe(emoji1000);
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: accepted.json.id } })).note).toBe(emoji1000);

    const refused = await post(body({ note: "😀".repeat(1001) }));
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("note_too_long");
  });

  it("measures a note of spaces too: 1001 spaces are refused though they are blank", async () => {
    const refused = await post(body({ note: " ".repeat(1001) }));
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("note_too_long");
    expect(await entryRows()).toHaveLength(0);
  });
});

/** Text Postgres cannot store as sent: a NUL (a 500), a half of a surrogate pair (silently U+FFFD). */
const UNSTORABLE_NOTES = ["\u0000", "a\u0000b", "text\u0000", "\ud800", "a\udc00b", "abc\ud83d", "\ude00 trailing low first"] as const;

describe("a note holds no NUL and no lone surrogate (AC-1.7; plan amendments 1 and 3)", () => {
  it("is refused with 400 invalid_request naming `note`, never a 500, and nothing is written", async () => {
    for (const note of UNSTORABLE_NOTES) {
      const res = await post(body({ note }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "note" });
      // The answer names the rule, not the text.
      expect(res.text).not.toContain("trailing low first");
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("is checked before the length: a long note with a NUL is 400, not 422", async () => {
    const res = await post(body({ note: `${"x".repeat(1200)}\u0000` }));
    expect(res.status).toBe(400);
    expect(res.json.field).toBe("note");
  });

  it("accepts a surrogate PAIR, which is one character", async () => {
    expect((await post(body({ note: "😀 and 𝄞" }))).status).toBe(201);
  });
});

describe("the category of an entry on no entity (AC-2.1, AC-3.4)", () => {
  it("refuses an unknown category with 422 category_not_found", async () => {
    const res = await post(body({ on: none("tc-does-not-exist") }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "category_not_found", field: "on.categoryId" });
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses a retired category with 422 category_retired, and takes it again once restored", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    const category = await db.timeCategory.create({ data: { name: "Offsite", createdBy: "user-admin" } });
    const retire = await call("PATCH", `/time-categories/${category.id}`, { as: "manager", body: { retired: true } });
    expect(retire.status).toBe(200);

    const refused = await post(body({ on: none(category.id) }));
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: "category_retired", field: "on.categoryId" });
    expect(await entryRows()).toHaveLength(0);

    const restore = await call("PATCH", `/time-categories/${category.id}`, { as: "manager", body: { retired: false } });
    expect(restore.status).toBe(200);
    const accepted = await post(body({ on: none(category.id) }));
    expect(accepted.status).toBe(201);
    expect(accepted.json.on).toEqual({ type: "none", category: { id: category.id, name: "Offsite", retired: false } });
  });

  it("makes `tc-other` ask for a note: none, null, an empty note and one of spaces are 422 note_required, a note is 201", async () => {
    for (const note of [undefined, null, "", "  ", "\n\t "]) {
      const res = await post(body({ on: none(SEED.categories.other), ...(note === undefined ? {} : { note }) }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "note_required", field: "note" });
    }
    expect(await entryRows()).toHaveLength(0);

    const res = await post(body({ on: none(SEED.categories.other), note: "Interview day" }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ note: "Interview day", on: { category: { id: SEED.categories.other } } });
  });

  it("asks for a note on whatever category an admin marked as requiring one, and for none on the others", async () => {
    const category = await db.timeCategory.create({ data: { name: "Needs words", requiresNote: true, createdBy: "user-admin" } });
    expect((await post(body({ on: none(category.id) }))).json.code).toBe("note_required");
    expect((await post(body({ on: none(category.id), note: "words" }))).status).toBe(201);
    expect((await post(body({ on: none(SEED.categories.training) }))).status).toBe(201);
  });

  it("takes any of the seeded categories", async () => {
    for (const id of Object.values(SEED.categories)) {
      const res = await post(body({ on: none(id), note: "A note, in case the category needs one" }));
      expect(res.status).toBe(201);
      expect(res.json.on.category.id).toBe(id);
    }
  });
});

describe("the body is strict (AC-1.6, AC-1.8, AC-2.1)", () => {
  it("refuses a member the contract does not have — userId, start, end, a top-level categoryId — with 400 invalid_request", async () => {
    for (const extra of [{ userId: PERSONAS.bob.sub }, { start: "09:00" }, { end: "17:30" }, { categoryId: SEED.categories.training }, { project: "p1" }]) {
      const res = await post(body(extra));
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses an `on` that carries the wrong members for its type — before any owner is asked", async () => {
    for (const on of [
      { type: "project", id: "p1", categoryId: SEED.categories.training }, // a project has no category
      { type: "deal", id: "d1", categoryId: SEED.categories.training },
      { type: "meeting", id: "m1", categoryId: SEED.categories.training },
      { type: "none" }, // other work must name its category
      { type: "none", categoryId: SEED.categories.training, id: "x" },
      { type: "project" },
      { type: "project", id: "p1", extra: true },
      { type: "company", id: "c1" },
      { id: "p1" },
      null,
      "none",
    ]) {
      const res = await post(body({ on }));
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    // `on` missing altogether.
    const { on: _on, ...withoutOn } = body();
    expect((await post(withoutOn)).status).toBe(400);
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(0);
  });

  it("refuses a body that is not an object, and malformed JSON", async () => {
    for (const payload of [[], "text", 7, null]) expect((await post(payload)).status).toBe(400);
    const malformed = await call("POST", "/time-entries", { rawBody: "{ not json" });
    expect(malformed.status).toBe(400);
    expect(malformed.json.code).toBe("invalid_request");
  });
});

/** Ids outside the id rule (plan § Entries): empty, 65 characters, a NUL, a comma, a space at either end. */
const BAD_IDS = ["", "x".repeat(65), "a\u0000b", "\u0000", "a,b", ",", " a", "a ", "   "] as const;

describe("the ids of a body follow the id rule (AC-2.1; plan amendment 2026-11-13)", () => {
  it("refuses an on.categoryId outside it with 400 naming `on.categoryId`, never a 500 (a NUL would reach Postgres)", async () => {
    for (const categoryId of BAD_IDS) {
      const res = await post(body({ on: none(categoryId) }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "on.categoryId" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses a workTypeId and an activityId outside it with 400 naming them", async () => {
    for (const id of BAD_IDS) {
      const workType = await post(body({ workTypeId: id }));
      expect(workType.status).toBe(400);
      expect(workType.json).toMatchObject({ code: "invalid_request", field: "workTypeId" });
      const activity = await post(body({ activityId: id }));
      expect(activity.status).toBe(400);
      expect(activity.json).toMatchObject({ code: "invalid_request", field: "activityId" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("takes an id of exactly 64 characters, and answers a well-formed unknown one as unknown (422), not malformed", async () => {
    const res = await post(body({ on: none("x".repeat(64)) }));
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("category_not_found");
  });
});

describe("what an entry on no entity may not carry (AC-2.1, AC-3.5, AC-2.7)", () => {
  it("refuses a work type with 422 work_type_not_allowed, whichever list it is from and even an unknown one", async () => {
    for (const workTypeId of [SEED.workTypes.project.development, SEED.workTypes.deal.offer, "wt-does-not-exist"]) {
      const res = await post(body({ workTypeId }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });
    }
    expect(await entryRows()).toHaveLength(0);
  });

  it("refuses an activity pointer with 422 activity_not_allowed", async () => {
    const res = await post(body({ activityId: "activity-1" }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "activity_not_allowed", field: "activityId" });
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(0);
  });

  it("takes an explicit null for both: that is no work type and no activity", async () => {
    const res = await post(body({ workTypeId: null, activityId: null }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ workType: null, activity: null });
  });
});

const remove = (id: string, as: PersonaName | null = "alice") => call("DELETE", `/time-entries/${id}`, { as });

/** A `404`'s body with the id the caller asked for replaced, since `instance` is the request's own path. */
const sameAnswer = (res: { status: number; text: string }, id: string) => ({ status: res.status, text: res.text.replaceAll(id, "<id>") });

/** `<n>` days before TODAY, as `YYYY-MM-DD`. */
const daysAgo = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Ids that must be refused as a path segment: each is what a client would put in the URL (percent-encoded). */
const BAD_PATH_IDS = ["x".repeat(65), "%00", "a%2Cb", "%20a", "a%20"] as const;

describe("DELETE /time-entries/{id} (AC-1.5, AC-1.6)", () => {
  it("lets the owner delete an entry of any age: 204, and the entry is gone", async () => {
    const old = await makeNoEntityEntry(SEED.categories.training, { day: daysAgo(400) });
    const res = await remove(old.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(await entryRows()).toHaveLength(0);
  });

  it("answers someone else's entry — an admin's included — with the 404 of an id no entry has, and deletes nothing", async () => {
    const theirs = await makeNoEntityEntry(SEED.categories.training, { userId: PERSONAS.bob.sub });
    const ghost = "cmhx0p3v10000nobody0000000";
    const nobody = await remove(ghost, "alice");
    expect(nobody.status).toBe(404);

    for (const as of ["alice", "admin", "holder", "manager"] as const) {
      const res = await remove(theirs.id, as);
      expect(sameAnswer(res, theirs.id)).toEqual(sameAnswer(nobody, ghost));
    }
    expect(await entryRows()).toHaveLength(1);
  });

  it("answers an id outside the id rule with 400 invalid_request naming `id`, alike for the owner and anyone else, nothing deleted", async () => {
    const mine = await makeNoEntityEntry(SEED.categories.training);
    for (const id of BAD_PATH_IDS) {
      for (const as of ["alice", "bob"] as const) {
        const res = await remove(id, as);
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ code: "invalid_request", field: "id" });
      }
    }
    expect(await entryRows()).toHaveLength(1);
    expect((await entryRows())[0]?.id).toBe(mine.id);
  });

  it("needs a session", async () => {
    const mine = await makeNoEntityEntry(SEED.categories.training);
    expect((await remove(mine.id, null)).status).toBe(401);
    expect(await entryRows()).toHaveLength(1);
  });
});

describe("PATCH /time-entries/{id}: whose entry, and which members (AC-1.5, AC-1.6, AC-1.8)", () => {
  it("lets the owner change an entry of any age: only the members sent change", async () => {
    const old = await makeNoEntityEntry(SEED.categories.administration, { day: daysAgo(400), minutes: 120, note: "Filed receipts" });

    const res = await patch(old.id, { minutes: 90 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: old.id,
      day: daysAgo(400),
      minutes: 90,
      note: "Filed receipts",
      on: { type: "none", category: { id: SEED.categories.administration } },
    });

    const moved = await patch(old.id, { day: daysAgo(399), note: "Filed the receipts" });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ day: daysAgo(399), minutes: 90, note: "Filed the receipts" });

    const stored = await db.timeEntry.findUniqueOrThrow({ where: { id: old.id } });
    expect(stored).toMatchObject({ userId: ALICE, minutes: 90, note: "Filed the receipts", categoryId: SEED.categories.administration, target: "none" });
    expect(stored.day.toISOString().slice(0, 10)).toBe(daysAgo(399));
  });

  it("answers someone else's entry — an admin's included — with the 404 of an id no entry has, and changes nothing", async () => {
    const theirs = await makeNoEntityEntry(SEED.categories.training, { userId: PERSONAS.bob.sub, minutes: 60, note: "Theirs" });
    const ghost = "cmhx0p3v10000nobody0000000";
    const nobody = await patch(ghost, { minutes: 30 }, "alice");
    expect(nobody.status).toBe(404);

    for (const as of ["alice", "admin", "holder", "manager"] as const) {
      const res = await patch(theirs.id, { minutes: 30, note: "Changed" }, as);
      expect(sameAnswer(res, theirs.id)).toEqual(sameAnswer(nobody, ghost));
    }
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ minutes: 60, note: "Theirs", userId: PERSONAS.bob.sub });
  });

  it("answers an id outside the id rule with 400 naming `id`, alike for the owner and anyone else, and changes nothing", async () => {
    const mine = await makeNoEntityEntry(SEED.categories.training, { minutes: 60 });
    for (const id of BAD_PATH_IDS) {
      for (const as of ["alice", "bob"] as const) {
        const res = await patch(id, { minutes: 30 }, as);
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ code: "invalid_request", field: "id" });
      }
    }
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: mine.id } })).minutes).toBe(60);
  });

  it("refuses a member the contract does not have — userId, start, end — and an empty body, with 400 invalid_request", async () => {
    const mine = await makeNoEntityEntry(SEED.categories.training, { minutes: 60 });
    for (const payload of [{ userId: PERSONAS.bob.sub }, { start: "09:00" }, { end: "17:30" }, { minutes: 30, userId: PERSONAS.bob.sub }, {}]) {
      const res = await patch(mine.id, payload);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ minutes: 60, userId: ALICE });
  });
});

describe("PATCH /time-entries/{id}: a member that is sent is checked like on POST (AC-1.2, AC-1.3, AC-1.7)", () => {
  const stored = () => makeNoEntityEntry(SEED.categories.training, { day: "2026-11-02", minutes: 60, note: "Original" });
  const unchanged = async (id: string) => {
    const row = await db.timeEntry.findUniqueOrThrow({ where: { id } });
    return { minutes: row.minutes, note: row.note, day: row.day.toISOString().slice(0, 10) };
  };
  const ORIGINAL = { minutes: 60, note: "Original", day: "2026-11-02" };

  it("refuses 0, 15, 45 and 1470 minutes with 422 invalid_minutes, and takes 30 and 1440", async () => {
    const entry = await stored();
    for (const minutes of [0, 15, 45, 1470]) {
      const res = await patch(entry.id, { minutes });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "invalid_minutes", field: "minutes" });
    }
    expect(await unchanged(entry.id)).toEqual(ORIGINAL);
    for (const minutes of [30, 1440]) expect((await patch(entry.id, { minutes })).json.minutes).toBe(minutes);
  });

  it("refuses a day after today with 422 future_day, and any day that is not a real one with 400, changing nothing", async () => {
    const entry = await stored();
    for (const day of ["2026-11-14", "9999-12-31"]) {
      const res = await patch(entry.id, { day });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "future_day", field: "day" });
    }
    for (const day of NOT_A_DAY) {
      const res = await patch(entry.id, { day });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "day" });
    }
    expect(await unchanged(entry.id)).toEqual(ORIGINAL);
    expect((await patch(entry.id, { day: TODAY })).json.day).toBe(TODAY);
    expect((await patch(entry.id, { day: "2000-01-01" })).json.day).toBe("2000-01-01");
    expect((await patch(entry.id, { day: "2024-02-29" })).json.day).toBe("2024-02-29");
  });

  it("counts a note in code points: 1000 characters or emoji are stored whole, 1001 are 422 note_too_long", async () => {
    const entry = await stored();
    for (const note of ["x".repeat(1000), "😀".repeat(1000)]) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(200);
      expect(res.json.note).toBe(note);
      expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).note).toBe(note);
    }
    for (const note of ["x".repeat(1001), "😀".repeat(1001), " ".repeat(1001)]) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "note_too_long", field: "note" });
    }
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).note).toBe("😀".repeat(1000));
  });

  it("refuses a note with a NUL or a lone surrogate with 400 naming `note`, changing nothing", async () => {
    const entry = await stored();
    for (const note of UNSTORABLE_NOTES) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "invalid_request", field: "note" });
    }
    expect(await unchanged(entry.id)).toEqual(ORIGINAL);
  });

  it("stores a blank note as none (null) and any other note exactly as sent", async () => {
    const entry = await stored();
    for (const note of ["", "  ", " \n\t", null]) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(200);
      expect(res.json.note).toBeNull();
      expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).note).toBeNull();
    }
    const res = await patch(entry.id, { note: "  text " });
    expect(res.json.note).toBe("  text ");
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).note).toBe("  text ");
  });

  it("looks the entry up first: a rule's 422 is never the answer to someone else's entry", async () => {
    const theirs = await makeNoEntityEntry(SEED.categories.training, { userId: PERSONAS.bob.sub });
    const res = await patch(theirs.id, { minutes: 15 });
    expect(res.status).toBe(404);
  });

  it("answers the 404 of an entry that is deleted between the lookup and the update, not a 500 (two tabs)", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training);
    const ghost = await patch("cmhx0p3v10000nobody0000000", { minutes: 30 });
    // The row vanishes at the very moment of the UPDATE: a BEFORE UPDATE trigger deletes it and cancels the
    // statement, so Prisma raises its own P2025 ("Record to update not found") exactly as for a real race.
    const dropTrigger = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS t14_row_vanishes ON "time_entry"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS t14_row_vanishes()`);
    };
    await dropTrigger();
    await db.$executeRawUnsafe(
      `CREATE FUNCTION t14_row_vanishes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "time_entry" WHERE id = OLD.id; RETURN NULL; END $$`,
    );
    await db.$executeRawUnsafe(`CREATE TRIGGER t14_row_vanishes BEFORE UPDATE ON "time_entry" FOR EACH ROW EXECUTE FUNCTION t14_row_vanishes()`);
    try {
      const res = await patch(entry.id, { minutes: 30 });
      expect(sameAnswer(res, entry.id)).toEqual(sameAnswer(ghost, "cmhx0p3v10000nobody0000000"));
    } finally {
      await dropTrigger();
    }
    // The cancelled statement changed nothing, and the trigger is gone.
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).minutes).toBe(60);
    expect((await patch(entry.id, { minutes: 90 })).status).toBe(200);
  });
});

describe("PATCH /time-entries/{id}: note_required (AC-3.6, A7; D50, plan amendments 3 and 4)", () => {
  const OTHER = SEED.categories.other;
  const noteOf = async (id: string) => (await db.timeEntry.findUniqueOrThrow({ where: { id } })).note;

  it("refuses to clear the note of an entry whose category requires one — `''`, spaces and null alike — and leaves the row", async () => {
    const entry = await makeNoEntityEntry(OTHER, { note: "Interview day" });
    for (const note of ["", "  ", "\n", null]) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "note_required", field: "note" });
    }
    expect(await noteOf(entry.id)).toBe("Interview day");
  });

  it("clears the note of an entry whose category does not require one: 200 with note null", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training, { note: "Course" });
    for (const note of ["", null]) {
      const res = await patch(entry.id, { note });
      expect(res.status).toBe(200);
      expect(res.json.note).toBeNull();
    }
    expect(await noteOf(entry.id)).toBeNull();
  });

  it("takes a new note on a category that requires one", async () => {
    const entry = await makeNoEntityEntry(OTHER, { note: "Interview day" });
    const res = await patch(entry.id, { note: "Second interview day" });
    expect(res.status).toBe(200);
    expect(res.json.note).toBe("Second interview day");
  });

  it("refuses to move a note-less entry to a category that requires a note, and accepts it when the same PATCH sends one", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training);
    const refused = await patch(entry.id, { on: none(OTHER) });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: "note_required", field: "note" });
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).categoryId).toBe(SEED.categories.training);

    const refusedBlank = await patch(entry.id, { on: none(OTHER), note: "   " });
    expect(refusedBlank.status).toBe(422);

    const accepted = await patch(entry.id, { on: none(OTHER), note: "Interview day" });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ note: "Interview day", on: { type: "none", category: { id: OTHER } } });
  });

  it("accepts moving an entry that HAS a note to a category that requires one: the note stored is the note it will have", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training, { note: "Already described" });
    const res = await patch(entry.id, { on: none(OTHER) });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ note: "Already described", on: { category: { id: OTHER } } });
  });

  describe("D50: an entry recorded before its category required a note", () => {
    /** A note-less Training entry, then Training is marked as requiring a note (touching no entry, plan § Lists). */
    async function grandfathered() {
      const entry = await makeNoEntityEntry(SEED.categories.training, { minutes: 60, day: "2026-11-02" });
      hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
      const marked = await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { requiresNote: true } });
      expect(marked.status).toBe(200);
      return entry;
    }

    it("is not refused for a PATCH that sends neither a note nor another target: minutes and day change, the note stays null", async () => {
      const entry = await grandfathered();
      const minutes = await patch(entry.id, { minutes: 90 });
      expect(minutes.status).toBe(200);
      expect(minutes.json).toMatchObject({ minutes: 90, note: null });

      const day = await patch(entry.id, { day: "2026-11-03" });
      expect(day.status).toBe(200);
      expect(day.json).toMatchObject({ day: "2026-11-03", note: null });
      expect(await noteOf(entry.id)).toBeNull();
    });

    it("counts `on` equal to the stored target as unchanged: not checked", async () => {
      const entry = await grandfathered();
      const res = await patch(entry.id, { on: none(SEED.categories.training), minutes: 120 });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ minutes: 120, note: null });
    });

    it("is refused as soon as the PATCH sends a note that says nothing, and accepted with one that does", async () => {
      const entry = await grandfathered();
      for (const note of ["", "  ", null]) {
        const res = await patch(entry.id, { note });
        expect(res.status).toBe(422);
        expect(res.json.code).toBe("note_required");
      }
      expect(await noteOf(entry.id)).toBeNull();

      const res = await patch(entry.id, { note: "At last, a note" });
      expect(res.status).toBe(200);
      expect(res.json.note).toBe("At last, a note");
    });

    it("is checked when the entry is moved to another category, and the move back to this one is such a move", async () => {
      const entry = await grandfathered();
      const res = await patch(entry.id, { on: none(SEED.categories.administration), minutes: 60 });
      expect(res.status).toBe(200); // Administration does not require a note
      const back = await patch(entry.id, { on: none(SEED.categories.training) });
      expect(back.status).toBe(422); // Training now does, and this is a move
      expect(back.json.code).toBe("note_required");
    });
  });
});

describe("PATCH /time-entries/{id}: the category of an entry on no entity (AC-2.1, AC-3.4)", () => {
  const categoryOf = async (id: string) => (await db.timeEntry.findUniqueOrThrow({ where: { id } })).categoryId;

  it("moves the entry to another category: `on` replaced whole", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training, { note: "Course" });
    const res = await patch(entry.id, { on: none(SEED.categories.administration) });
    expect(res.status).toBe(200);
    expect(res.json.on).toEqual({ type: "none", category: { id: SEED.categories.administration, name: "Administration", retired: false } });
    expect(await categoryOf(entry.id)).toBe(SEED.categories.administration);
  });

  it("refuses an unknown or retired category with 422, and leaves the entry on the one it had", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    const retired = await db.timeCategory.create({ data: { name: "Offsite", createdBy: "user-admin", retiredAt: new Date() } });
    const entry = await makeNoEntityEntry(SEED.categories.training);

    const unknown = await patch(entry.id, { on: none("tc-does-not-exist") });
    expect(unknown.status).toBe(422);
    expect(unknown.json).toMatchObject({ code: "category_not_found", field: "on.categoryId" });

    const gone = await patch(entry.id, { on: none(retired.id) });
    expect(gone.status).toBe(422);
    expect(gone.json).toMatchObject({ code: "category_retired", field: "on.categoryId" });
    expect(await categoryOf(entry.id)).toBe(SEED.categories.training);

    const restored = await call("PATCH", `/time-categories/${retired.id}`, { as: "manager", body: { retired: false } });
    expect(restored.status).toBe(200);
    expect((await patch(entry.id, { on: none(retired.id) })).status).toBe(200);
    expect(await categoryOf(entry.id)).toBe(retired.id);
  });

  it("keeps showing an older entry's retired category with retired:true, and still lets its author correct the note", async () => {
    const category = await db.timeCategory.create({ data: { name: "Offsite", createdBy: "user-admin" } });
    const entry = await makeNoEntityEntry(category.id, { note: "Team day" });
    await db.timeCategory.update({ where: { id: category.id }, data: { retiredAt: new Date() } });

    const note = await patch(entry.id, { note: "Team day, Lugano" });
    expect(note.status).toBe(200);
    expect(note.json).toMatchObject({ note: "Team day, Lugano", on: { type: "none", category: { id: category.id, name: "Offsite", retired: true } } });

    // The entry is not MOVED by naming the category it is already on: nothing is chosen, so nothing is refused.
    const same = await patch(entry.id, { on: none(category.id), minutes: 90 });
    expect(same.status).toBe(200);
    expect(same.json).toMatchObject({ minutes: 90, on: { category: { id: category.id, retired: true } } });
  });

  it("refuses a PATCH whose `on` is of a kind it does not know, or has the wrong members, with 400", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training);
    for (const on of [{ type: "none" }, { type: "none", categoryId: "a,b" }, { type: "project", id: "p1", categoryId: SEED.categories.training }, { type: "company", id: "c1" }, null]) {
      const res = await patch(entry.id, { on });
      expect(res.status).toBe(400);
    }
    expect(await categoryOf(entry.id)).toBe(SEED.categories.training);
    expect(hosts.calls).toHaveLength(0);
  });
});

describe("PATCH /time-entries/{id}: the work type (AC-3.4, AC-3.5)", () => {
  const PROJECT_DEV = SEED.workTypes.project.development;
  const PROJECT_ANALYSIS = SEED.workTypes.project.analysis;
  const DEAL_OFFER = SEED.workTypes.deal.offer;
  const workTypeOf = async (id: string) => (await db.timeEntry.findUniqueOrThrow({ where: { id } })).workTypeId;

  it("changes the work type of a project entry to another of the project list, and clears it with null — asking no owner", async () => {
    const entry = await makeProjectEntry("p1", { workTypeId: PROJECT_DEV });
    // projects-api is down: the author may still correct the entry (a change that keeps the target asks no owner, AC-2.12).
    hosts.fail("projects.resolve", { status: 500 });

    const changed = await patch(entry.id, { workTypeId: PROJECT_ANALYSIS });
    expect(changed.status).toBe(200);
    expect(changed.json.workType).toEqual({ id: PROJECT_ANALYSIS, name: "Analysis", retired: false });
    expect(await workTypeOf(entry.id)).toBe(PROJECT_ANALYSIS);

    const cleared = await patch(entry.id, { workTypeId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.workType).toBeNull();
    expect(await workTypeOf(entry.id)).toBeNull();
  });

  it("takes only the list that matches what the entry is on: a deal work type on a project is 422, and the reverse", async () => {
    const project = await makeProjectEntry("p1", { workTypeId: PROJECT_DEV });
    const deal = await makeDealEntry("d1", { workTypeId: SEED.workTypes.deal.analysis });

    const wrongForProject = await patch(project.id, { workTypeId: DEAL_OFFER });
    expect(wrongForProject.status).toBe(422);
    expect(wrongForProject.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });
    const wrongForDeal = await patch(deal.id, { workTypeId: PROJECT_ANALYSIS });
    expect(wrongForDeal.status).toBe(422);
    expect(wrongForDeal.json.code).toBe("work_type_not_allowed");
    expect(await workTypeOf(project.id)).toBe(PROJECT_DEV);
    expect(await workTypeOf(deal.id)).toBe(SEED.workTypes.deal.analysis);

    expect((await patch(deal.id, { workTypeId: DEAL_OFFER })).status).toBe(200);
  });

  it("refuses an unknown work type with 422 work_type_not_found, a retired one with work_type_retired, and takes it again once restored", async () => {
    hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
    const retired = await makeWorkType("project", "Workshops", { retired: true });
    const entry = await makeProjectEntry("p1", { workTypeId: PROJECT_DEV });

    const unknown = await patch(entry.id, { workTypeId: "wt-does-not-exist" });
    expect(unknown.status).toBe(422);
    expect(unknown.json).toMatchObject({ code: "work_type_not_found", field: "workTypeId" });

    const gone = await patch(entry.id, { workTypeId: retired.id });
    expect(gone.status).toBe(422);
    expect(gone.json).toMatchObject({ code: "work_type_retired", field: "workTypeId" });
    expect(await workTypeOf(entry.id)).toBe(PROJECT_DEV);

    const restore = await call("PATCH", `/work-types/${retired.id}`, { as: "manager", body: { retired: false } });
    expect(restore.status).toBe(200);
    expect((await patch(entry.id, { workTypeId: retired.id })).status).toBe(200);
  });

  it("never gives a meeting one: 422 work_type_not_allowed whatever it is", async () => {
    const entry = await makeMeetingEntry("m1");
    for (const workTypeId of [PROJECT_DEV, DEAL_OFFER, "wt-does-not-exist"]) {
      const res = await patch(entry.id, { workTypeId });
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("work_type_not_allowed");
    }
    expect((await patch(entry.id, { workTypeId: null })).status).toBe(200);
  });

  it("is checked on POST before any owner is asked, whatever the target (AC-3.5): the work type's list must match, and a meeting has none", async () => {
    const retired = await makeWorkType("project", "Workshops", { retired: true });
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ on: { type: "project", id: "p1" }, workTypeId: DEAL_OFFER }, "work_type_not_allowed"],
      [{ on: { type: "deal", id: "d1" }, workTypeId: PROJECT_DEV }, "work_type_not_allowed"],
      [{ on: { type: "meeting", id: "m1" }, workTypeId: PROJECT_DEV }, "work_type_not_allowed"],
      [{ on: { type: "meeting", id: "m1" }, workTypeId: "wt-does-not-exist" }, "work_type_not_allowed"],
      [{ on: { type: "project", id: "p1" }, workTypeId: "wt-does-not-exist" }, "work_type_not_found"],
      [{ on: { type: "project", id: "p1" }, workTypeId: retired.id }, "work_type_retired"],
      [{ on: { type: "meeting", id: "m1" }, activityId: "activity-1" }, "activity_not_allowed"],
    ];
    for (const [over, code] of refusals) {
      const res = await post(body(over));
      expect(res.status).toBe(422);
      expect(res.json.code).toBe(code);
    }
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(0);
  });

  describe("an older entry on a work type retired since (AC-3.4)", () => {
    it("still shows it with retired:true, and its author can correct the note, the day and the duration", async () => {
      const retired = await makeWorkType("project", "Workshops");
      const entry = await makeProjectEntry("p1", { workTypeId: retired.id, note: "Kick-off" });
      await db.workType.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });

      const res = await patch(entry.id, { note: "Kick-off, Lugano", minutes: 90, day: "2026-11-03" });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ note: "Kick-off, Lugano", minutes: 90, day: "2026-11-03", workType: { id: retired.id, name: "Workshops", retired: true } });
    });

    it("accepts the PATCH that sends the stored retired work type again, the target unchanged: nothing is chosen, so nothing is refused", async () => {
      const retired = await makeWorkType("project", "Workshops");
      const other = await makeWorkType("project", "Reviews", { retired: true });
      const entry = await makeProjectEntry("p1", { workTypeId: retired.id });
      await db.workType.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });

      // A client that sends the whole form back (hours-ui sends only what changed) still saves its entry …
      const same = await patch(entry.id, { workTypeId: retired.id, minutes: 120, on: { type: "project", id: "p1" } });
      expect(same.status).toBe(200);
      expect(same.json).toMatchObject({ minutes: 120, workType: { id: retired.id, retired: true } });
      // … but choosing ANOTHER retired work type is refused.
      const changed = await patch(entry.id, { workTypeId: other.id });
      expect(changed.status).toBe(422);
      expect(changed.json.code).toBe("work_type_retired");
      expect(await workTypeOf(entry.id)).toBe(retired.id);
    });
  });
});

describe("PATCH /time-entries/{id}: a change that keeps the target asks no owner (AC-2.12, D46)", () => {
  it("saves day, duration, note and work type of a project entry while projects-api is down, and when `on` names the same project", async () => {
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, note: "Sprint" });
    hosts.fail("projects.resolve", { status: 500 });
    hosts.fail("activities.list", { status: 500 });
    hosts.fail("crm.resolve", { status: 500 });
    hosts.fail("meetings.list", { status: 500 });

    const res = await patch(entry.id, { day: "2026-11-03", minutes: 150, note: "Sprint review", workTypeId: SEED.workTypes.project.support });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ day: "2026-11-03", minutes: 150, note: "Sprint review", on: { type: "project", id: "p1", visibility: "unavailable" } });

    const sameProject = await patch(entry.id, { on: { type: "project", id: "p1" }, minutes: 30 });
    expect(sameProject.status).toBe(200);
    expect(sameProject.json.minutes).toBe(30);
  });

  it("does the same for a deal and a meeting entry", async () => {
    const deal = await makeDealEntry("d1");
    const meeting = await makeMeetingEntry("m1");
    hosts.fail("crm.resolve", { status: 500 });
    hosts.fail("meetings.list", { status: 500 });
    hosts.fail("meetings.system-hosts", { status: 500 });

    expect((await patch(deal.id, { minutes: 90, on: { type: "deal", id: "d1" } })).status).toBe(200);
    expect((await patch(meeting.id, { minutes: 90, on: { type: "meeting", id: "m1" } })).status).toBe(200);
  });
});

describe("PATCH /time-entries/{id}: the activity pointer (AC-2.7, D47)", () => {
  const activityOf = async (id: string) => (await db.timeEntry.findUniqueOrThrow({ where: { id } })).activityId;

  it("never gives one to a meeting or to an entry on no entity: 422 activity_not_allowed", async () => {
    const meeting = await makeMeetingEntry("m1");
    const none = await makeNoEntityEntry();
    for (const id of [meeting.id, none.id]) {
      const res = await patch(id, { activityId: "activity-1" });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "activity_not_allowed", field: "activityId" });
      expect((await patch(id, { activityId: null })).status).toBe(200);
    }
    // Nobody asked activities-api whether an activity exists: it is refused, or cleared, from the request alone.
    expect(hosts.callsTo("activities.list")).toHaveLength(0);
  });

  it("clears the pointer with null, never checking it", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "activity-1" });
    hosts.fail("activities.list", { status: 500 });
    const res = await patch(entry.id, { activityId: null });
    expect(res.status).toBe(200);
    expect(res.json.activity).toBeNull();
    expect(await activityOf(entry.id)).toBeNull();
  });

  it("never clears a pointer the PATCH does not mention, even one activities-api no longer returns (D47)", async () => {
    // The author can read the project, and activities-api does not know the activity: it is gone (AC-2.9).
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const entry = await makeProjectEntry("p1", { activityId: "activity-gone" });
    const res = await patch(entry.id, { note: "Changed the note" });
    expect(res.status).toBe(200);
    expect(res.json.activity).toBeNull(); // gone on read (AC-2.9) …
    expect(await activityOf(entry.id)).toBe("activity-gone"); // … but never cleared in the database
    expect((await patch(entry.id, { minutes: 90 })).status).toBe(200);
    expect(await activityOf(entry.id)).toBe("activity-gone");
  });
});

describe("PATCH /time-entries/{id}: moving an entry to no entity (AC-2.1, AC-3.5)", () => {
  const rowOf = (id: string) => db.timeEntry.findUniqueOrThrow({ where: { id } });

  it("carries what the entry has, so it is refused while it holds a work type or an activity that no longer fit", async () => {
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, activityId: "activity-1" });

    const withWorkType = await patch(entry.id, { on: none(), activityId: null });
    expect(withWorkType.status).toBe(422);
    expect(withWorkType.json).toMatchObject({ code: "work_type_not_allowed", field: "workTypeId" });

    const withActivity = await patch(entry.id, { on: none(), workTypeId: null });
    expect(withActivity.status).toBe(422);
    expect(withActivity.json).toMatchObject({ code: "activity_not_allowed", field: "activityId" });

    expect(await rowOf(entry.id)).toMatchObject({ target: "project", projectId: "p1", categoryId: null });
  });

  it("moves it when the work type and the activity are let go in the same PATCH: only the category stays", async () => {
    const entry = await makeProjectEntry("p1", { workTypeId: SEED.workTypes.project.development, activityId: "activity-1", note: "Hand-over" });
    const res = await patch(entry.id, { on: none(SEED.categories.administration), workTypeId: null, activityId: null });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ note: "Hand-over", workType: null, activity: null, on: { type: "none", category: { id: SEED.categories.administration } } });
    expect(await rowOf(entry.id)).toMatchObject({
      target: "none",
      categoryId: SEED.categories.administration,
      projectId: null,
      dealId: null,
      meetingId: null,
      workTypeId: null,
      activityId: null,
      note: "Hand-over",
    });
  });

  it("moves a meeting entry too, and the CHECK is never the one to answer", async () => {
    const entry = await makeMeetingEntry("m1");
    const res = await patch(entry.id, { on: none(SEED.categories.training) });
    expect(res.status).toBe(200);
    expect(await rowOf(entry.id)).toMatchObject({ target: "none", meetingId: null, categoryId: SEED.categories.training });
  });
});

/**
 * TRANSITIONAL — T16 (deals, the activity pointer) replaces the refusals below with the owners' checks and
 * moves these tests to its own files (deals.test.ts, activityPointer.test.ts). Projects and meetings are T15's:
 * src/entries/bookability.test.ts. Until T16 a write on a deal, or one that points at an activity, is refused,
 * never accepted unchecked (fail closed, AC-2.11's posture).
 */
describe("hours on a deal, and an activity pointer, until their owners are asked (T16)", () => {
  it("a deal is refused with 501 not_implemented, nothing written and no owner called", async () => {
    const res = await post(body({ on: { type: "deal", id: "d1" } }));
    expect(res.status).toBe(501);
    expect(res.json.code).toBe("not_implemented");
    expect(await entryRows()).toHaveLength(0);
    expect(hosts.calls).toHaveLength(0);
  });

  it("refuse a PATCH that moves an entry to a deal, leaving the entry", async () => {
    const onProject = await makeProjectEntry("p1");
    const onNone = await makeNoEntityEntry(SEED.categories.training);
    for (const entry of [onProject, onNone]) {
      const res = await patch(entry.id, { on: { type: "deal", id: "d1" } });
      expect(res.status).toBe(501);
    }
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: onProject.id } })).toMatchObject({ target: "project", projectId: "p1", dealId: null });
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: onNone.id } })).toMatchObject({ target: "none", dealId: null });
    expect(hosts.calls).toHaveLength(0);
  });

  it("refuse a PATCH that gives a project or deal entry an activity it did not point at, leaving the entry", async () => {
    const entry = await makeProjectEntry("p1", { activityId: "activity-1" });
    const res = await patch(entry.id, { activityId: "activity-2" });
    expect(res.status).toBe(501);
    expect((await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).activityId).toBe("activity-1");
    expect(hosts.calls).toHaveLength(0);
  });

  it("refuse a new project entry that points at an activity, after bookability said yes: nothing is written", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const res = await post(body({ on: { type: "project", id: "p1" }, activityId: "activity-1" }));
    expect(res.status).toBe(501);
    expect(await entryRows()).toHaveLength(0);
  });

  it("let the project's own answer come first: a caller who is not on it is told 403, not 501", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [PERSONAS.bob.sub] });
    const res = await post(body({ on: { type: "project", id: "p1" }, activityId: "activity-1" }));
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("not_on_project");
  });
});

describe("a blank note is no note (AC-1.7, AC-3.6; plan amendment 3)", () => {
  it("stores and returns null for an empty note, one of whitespace, and an absent or null one", async () => {
    for (const note of ["", " ", " \n\t", "  ", null, undefined]) {
      const res = await post(body(note === undefined ? {} : { note }));
      expect(res.status).toBe(201);
      expect(res.json.note).toBeNull();
      expect((await db.timeEntry.findUniqueOrThrow({ where: { id: res.json.id } })).note).toBeNull();
    }
  });

  it("stores any other note exactly as sent, spaces and line breaks included: it is the person's text", async () => {
    for (const note of ["  text ", "\nline one\nline two\n", "​"]) {
      const res = await post(body({ note }));
      expect(res.status).toBe(201);
      expect(res.json.note).toBe(note);
      expect((await db.timeEntry.findUniqueOrThrow({ where: { id: res.json.id } })).note).toBe(note);
    }
  });
});
