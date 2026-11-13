/**
 * The test world itself (specs/029 T10): every later hours-api task builds its fixtures with it and
 * is told it need not edit it, so what it promises is proved here: an entry inserted directly on
 * every target, the seeded lists by id, a reset that puts the lists back as the migration left
 * them, and a request helper that signs tokens and does not choke on an answer that is not JSON.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { decodeJwt } from "jose";
import {
  PERSONAS,
  SEED,
  bearerOf,
  call,
  db,
  makeCategory,
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  makeWorkType,
  onReset,
  resetWorld,
} from "./world";

beforeEach(resetWorld);

describe("entries inserted directly, one factory per target", () => {
  it("inserts an entry of every target in its own shape, with the defaults of a valid 1 h entry of alice", async () => {
    const project = await makeProjectEntry("project-1");
    const deal = await makeDealEntry("deal-1");
    const meeting = await makeMeetingEntry("meeting-1");
    const none = await makeNoEntityEntry();

    expect(project).toMatchObject({ target: "project", projectId: "project-1", dealId: null, meetingId: null, categoryId: null });
    expect(deal).toMatchObject({ target: "deal", dealId: "deal-1", projectId: null, meetingId: null, categoryId: null });
    expect(meeting).toMatchObject({ target: "meeting", meetingId: "meeting-1", projectId: null, dealId: null, categoryId: null, workTypeId: null, activityId: null });
    expect(none).toMatchObject({ target: "none", categoryId: SEED.categories.training, workTypeId: null, projectId: null, dealId: null, meetingId: null });
    for (const entry of [project, deal, meeting, none]) {
      expect(entry).toMatchObject({ userId: PERSONAS.alice.sub, minutes: 60, note: null });
      expect(entry.day.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    }
    expect(await db.timeEntry.count()).toBe(4);
  });

  it("honours every option: author, day, minutes, note, work type, activity and creation time", async () => {
    const createdAt = new Date("2026-11-03T08:00:00Z");
    const entry = await makeProjectEntry("project-1", {
      userId: PERSONAS.bob.sub,
      day: "2026-10-30",
      minutes: 150,
      note: "Pairing on the importer",
      workTypeId: SEED.workTypes.project.development,
      activityId: "activity-1",
      createdAt,
    });
    expect(entry).toMatchObject({ userId: "user-bob", minutes: 150, note: "Pairing on the importer", workTypeId: "wt-project-development", activityId: "activity-1" });
    expect(entry.day.toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(entry.createdAt).toEqual(createdAt);

    const deal = await makeDealEntry("deal-1", { workTypeId: SEED.workTypes.deal.estimate, activityId: "activity-2" });
    expect(deal).toMatchObject({ workTypeId: "wt-deal-estimate", activityId: "activity-2" });
    expect(await makeNoEntityEntry(SEED.categories.other, { note: "Moving desks" })).toMatchObject({ categoryId: "tc-other", note: "Moving desks" });
  });
});

describe("the seeded lists", () => {
  it("names every row the migration inserts: SEED holds exactly the twelve fixed ids, and the database has each", async () => {
    const categoryIds = Object.values(SEED.categories);
    const workTypeIds = [...Object.values(SEED.workTypes.project), ...Object.values(SEED.workTypes.deal)];
    expect(categoryIds).toHaveLength(4);
    expect(workTypeIds).toHaveLength(8);
    expect((await db.timeCategory.findMany({ select: { id: true } })).map((row) => row.id).sort()).toEqual([...categoryIds].sort());
    expect((await db.workType.findMany({ select: { id: true } })).map((row) => row.id).sort()).toEqual([...workTypeIds].sort());
  });

  it("makes categories and work types an admin added: not seeded, retired only when asked", async () => {
    const category = await makeCategory("Mentoring", { requiresNote: true });
    const retired = await makeCategory("Old", { retired: true });
    const workType = await makeWorkType("deal", "Pitch");
    const retiredWorkType = await makeWorkType("project", "Legacy", { retired: true });
    expect(category).toMatchObject({ name: "Mentoring", requiresNote: true, retiredAt: null });
    expect(retired.retiredAt).not.toBeNull();
    expect(workType).toMatchObject({ list: "deal", name: "Pitch", retiredAt: null });
    expect(retiredWorkType.retiredAt).not.toBeNull();
    expect(await makeCategory()).toMatchObject({ requiresNote: false });
    expect([category.createdBy, workType.createdBy].every((by) => by !== "system:migration")).toBe(true);
  });
});

describe("resetWorld", () => {
  it("empties the entries and removes the list rows a test added", async () => {
    await makeProjectEntry("project-1");
    const category = await makeCategory("Mentoring");
    await makeNoEntityEntry(category.id);
    await makeWorkType("project", "Pitch");

    await resetWorld();

    expect(await db.timeEntry.count()).toBe(0);
    expect(await db.timeCategory.count()).toBe(4);
    expect(await db.workType.count()).toBe(8);
  });

  it("puts a seeded row back as the migration made it after a test renamed, retired or changed it", async () => {
    await db.timeCategory.update({ where: { id: SEED.categories.other }, data: { name: "Misc", requiresNote: false, retiredAt: new Date(), createdBy: "user-admin" } });
    await db.timeCategory.update({ where: { id: SEED.categories.training }, data: { requiresNote: true } });
    await db.workType.update({ where: { id: SEED.workTypes.deal.demo }, data: { name: "Showcase", retiredAt: new Date() } });

    await resetWorld();

    expect(await db.timeCategory.findUnique({ where: { id: SEED.categories.other } })).toMatchObject({ name: "Other", requiresNote: true, retiredAt: null, createdBy: "system:migration" });
    expect(await db.timeCategory.findUnique({ where: { id: SEED.categories.training } })).toMatchObject({ name: "Training", requiresNote: false });
    expect(await db.workType.findUnique({ where: { id: SEED.workTypes.deal.demo } })).toMatchObject({ list: "deal", name: "Demo", retiredAt: null, createdBy: "system:migration" });
  });

  it("is safe to run twice in a row", async () => {
    await makeProjectEntry("project-1");
    await resetWorld();
    await resetWorld();
    expect(await db.timeEntry.count()).toBe(0);
  });

  it("runs the hooks other test-support files register, in order, on every reset", async () => {
    const seen: string[] = [];
    onReset(() => void seen.push("first"));
    onReset(async () => {
      seen.push("second");
    });
    await resetWorld();
    await resetWorld();
    expect(seen).toEqual(["first", "second", "first", "second"]);
  });
});

describe("call", () => {
  it("signs a token for the persona (alice by default) and sends none for `as: null`", async () => {
    const claims = decodeJwt((await bearerOf("bob")).slice("Bearer ".length));
    expect(claims.sub).toBe("user-bob");
    expect(claims["email"]).toBe("bob@welld.test");
    expect(claims["name"]).toBe("Name of bob");
    // Past the gate the answer is the 404 of a path nothing serves yet; without one it is the 401.
    expect((await call("GET", "/nothing-here")).status).toBe(404);
    expect((await call("GET", "/nothing-here", { as: null })).status).toBe(401);
    expect((await call("GET", "/nothing-here", { as: "holder" })).status).toBe(404);
  });

  it("puts a `perm_epoch` claim in the token only when asked, and a new epoch is a new token", async () => {
    const plain = decodeJwt((await bearerOf("alice")).slice(7));
    const epoch3 = decodeJwt((await bearerOf("alice", 3)).slice(7));
    const epoch4 = decodeJwt((await bearerOf("alice", 4)).slice(7));
    expect(plain["perm_epoch"]).toBeUndefined();
    expect(epoch3["perm_epoch"]).toBe(3);
    expect(epoch4["perm_epoch"]).toBe(4);
    expect(await bearerOf("alice", 3)).toBe(await bearerOf("alice", 3));
    expect(await bearerOf("alice", 3)).not.toBe(await bearerOf("alice", 4));
  });

  it("parses a JSON answer and leaves `json` undefined for one that is not (/docs is HTML)", async () => {
    const health = await call("GET", "/health", { as: null });
    expect(health.json).toMatchObject({ service: "hours-api" });
    const docs = await call("GET", "/docs", { as: null });
    expect(docs.json).toBeUndefined();
    expect(docs.text).toContain("<html");
    expect(docs.headers.get("content-type")).toContain("html");
  });

  it("sends a raw body as is, for a malformed one", async () => {
    const res = await call("POST", "/nothing-here", { rawBody: "{not json" });
    expect(res.status).toBe(404); // nothing serves the path yet; the body was sent without crashing the helper
  });
});
