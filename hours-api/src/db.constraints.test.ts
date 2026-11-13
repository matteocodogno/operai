/**
 * The rules the schema itself enforces (specs/029 T10): Prisma cannot express CHECKs or
 * expression indexes, so the initial migration adds them by hand, and these tests prove at the
 * DATABASE that each one refuses what the model forbids. Each refusal is asserted by its
 * constraint's (or index's) NAME, so a row refused for some other reason (a missing column, a
 * bad enum) cannot pass for it; each rule also has its accepted neighbour, so the refusal is the
 * rule and not the fixture.
 *
 * Runs against the `*_test` database (src/test-support/env.ts, the `bun test` preload).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./lib/db";
import type { Prisma } from "./lib/generated/prisma/client";

/** Rows these tests create carry this `createdBy`; the seeded lists (`system:migration`) are never touched. */
const MINE = "constraints-test";

async function clean() {
  await db.timeEntry.deleteMany();
  await db.timeCategory.deleteMany({ where: { createdBy: MINE } });
  await db.workType.deleteMany({ where: { createdBy: MINE } });
}
beforeEach(clean);
afterAll(clean);

const day = new Date("2026-11-02T00:00:00Z");

let counter = 0;
const next = (prefix: string) => `${prefix}-${++counter}`;

/** A category and a project work type only this test file knows. */
const makeCategory = (name = next("Category"), over: Partial<Prisma.TimeCategoryUncheckedCreateInput> = {}) =>
  db.timeCategory.create({ data: { name, createdBy: MINE, ...over } });
const makeWorkType = (list: "project" | "deal" = "project", name = next("Work type"), over: Partial<Prisma.WorkTypeUncheckedCreateInput> = {}) =>
  db.workType.create({ data: { list, name, createdBy: MINE, ...over } });

/** A valid entry on a project; `over` is applied last. */
const projectData = (over: Partial<Prisma.TimeEntryUncheckedCreateInput> = {}): Prisma.TimeEntryUncheckedCreateInput => ({
  userId: "user-1",
  day,
  minutes: 60,
  target: "project",
  projectId: "project-1",
  ...over,
});
const dealData = (over: Partial<Prisma.TimeEntryUncheckedCreateInput> = {}): Prisma.TimeEntryUncheckedCreateInput => ({
  userId: "user-1",
  day,
  minutes: 60,
  target: "deal",
  dealId: "deal-1",
  ...over,
});
const meetingData = (over: Partial<Prisma.TimeEntryUncheckedCreateInput> = {}): Prisma.TimeEntryUncheckedCreateInput => ({
  userId: "user-1",
  day,
  minutes: 60,
  target: "meeting",
  meetingId: "meeting-1",
  ...over,
});
const noneData = (categoryId: string, over: Partial<Prisma.TimeEntryUncheckedCreateInput> = {}): Prisma.TimeEntryUncheckedCreateInput => ({
  userId: "user-1",
  day,
  minutes: 60,
  target: "none",
  categoryId,
  ...over,
});

const make = (data: Prisma.TimeEntryUncheckedCreateInput) => db.timeEntry.create({ data });

/** The error a refused write carries: Prisma wraps the driver's, so match on the text. */
const refusal = (constraint: string) => expect.objectContaining({ message: expect.stringContaining(constraint) });
/** A Prisma query is a lazy thenable, not a Promise: run it inside an async function so `rejects` can see it. */
const refusedBy = (constraint: string, write: PromiseLike<unknown>) =>
  expect(
    (async () => {
      await write;
    })(),
  ).rejects.toEqual(refusal(constraint));

describe("time_entry_minutes (AC-1.2)", () => {
  const RULE = "time_entry_minutes";

  it("accepts every multiple of 30 from 30 minutes to 24 hours", async () => {
    for (const minutes of [30, 60, 150, 720, 1410, 1440]) {
      expect((await make(projectData({ minutes }))).minutes).toBe(minutes);
    }
  });

  it("refuses a duration that is not a whole number of 30-minute steps", async () => {
    for (const minutes of [15, 45, 59, 61, 1439]) await refusedBy(RULE, make(projectData({ minutes })));
  });

  it("refuses a duration under 30 minutes, zero and negative ones included", async () => {
    for (const minutes of [0, -30, -60]) await refusedBy(RULE, make(projectData({ minutes })));
  });

  it("refuses a duration over 24 hours, even in whole 30-minute steps", async () => {
    for (const minutes of [1470, 1500, 2880]) await refusedBy(RULE, make(projectData({ minutes })));
  });
});

describe("time_entry_note_length (AC-1.7)", () => {
  const RULE = "time_entry_note_length";

  it("accepts no note, a short note and a note of exactly 1000 characters", async () => {
    expect((await make(projectData())).note).toBeNull();
    expect((await make(projectData({ note: "Reviewed the design" }))).note).toBe("Reviewed the design");
    expect((await make(projectData({ note: "x".repeat(1000) }))).note).toHaveLength(1000);
  });

  it("refuses a note of 1001 characters", async () => {
    await refusedBy(RULE, make(projectData({ note: "x".repeat(1001) })));
  });

  it("counts characters, not bytes: 1000 two-byte characters pass and 1001 do not", async () => {
    expect((await make(projectData({ note: "é".repeat(1000) }))).note).toHaveLength(1000);
    await refusedBy(RULE, make(projectData({ note: "é".repeat(1001) })));
  });
});

describe("time_entry_target_shape (AC-2.1, AC-3.5)", () => {
  const SHAPE = "time_entry_target_shape";

  it("accepts one entry of every target, in its own shape", async () => {
    const category = await makeCategory();
    expect((await make(projectData())).target).toBe("project");
    expect((await make(dealData())).target).toBe("deal");
    expect((await make(meetingData())).target).toBe("meeting");
    expect((await make(noneData(category.id))).target).toBe("none");
  });

  it("accepts a work type on a project or a deal entry, and none", async () => {
    const workType = await makeWorkType();
    expect((await make(projectData({ workTypeId: workType.id }))).workTypeId).toBe(workType.id);
    expect((await make(dealData({ workTypeId: workType.id }))).workTypeId).toBe(workType.id);
  });

  it("refuses a project entry without a project, or with another entity's id", async () => {
    await refusedBy(SHAPE, make(projectData({ projectId: null })));
    await refusedBy(SHAPE, make(projectData({ dealId: "deal-1" })));
    await refusedBy(SHAPE, make(projectData({ meetingId: "meeting-1" })));
  });

  it("refuses a deal entry without a deal, or with another entity's id", async () => {
    await refusedBy(SHAPE, make(dealData({ dealId: null })));
    await refusedBy(SHAPE, make(dealData({ projectId: "project-1" })));
    await refusedBy(SHAPE, make(dealData({ meetingId: "meeting-1" })));
  });

  it("refuses a meeting entry without a meeting, or with another entity's id", async () => {
    await refusedBy(SHAPE, make(meetingData({ meetingId: null })));
    await refusedBy(SHAPE, make(meetingData({ projectId: "project-1" })));
    await refusedBy(SHAPE, make(meetingData({ dealId: "deal-1" })));
  });

  it("refuses an entry whose id belongs to a different target than its own", async () => {
    await refusedBy(SHAPE, make({ ...projectData(), projectId: null, dealId: "deal-1" }));
    await refusedBy(SHAPE, make({ ...dealData(), dealId: null, meetingId: "meeting-1" }));
    await refusedBy(SHAPE, make({ ...meetingData(), meetingId: null, projectId: "project-1" }));
  });

  it("refuses a category on a project, deal or meeting entry", async () => {
    const category = await makeCategory();
    await refusedBy(SHAPE, make(projectData({ categoryId: category.id })));
    await refusedBy(SHAPE, make(dealData({ categoryId: category.id })));
    await refusedBy(SHAPE, make(meetingData({ categoryId: category.id })));
  });

  it("refuses a work type on a meeting entry", async () => {
    const workType = await makeWorkType();
    await refusedBy(SHAPE, make(meetingData({ workTypeId: workType.id })));
  });

  it("refuses an entry on no entity without a category", async () => {
    await refusedBy(SHAPE, make({ userId: "user-1", day, minutes: 60, target: "none" }));
  });

  it("refuses an entry on no entity that carries a work type or an entity id", async () => {
    const category = await makeCategory();
    const workType = await makeWorkType();
    await refusedBy(SHAPE, make(noneData(category.id, { workTypeId: workType.id })));
    await refusedBy(SHAPE, make(noneData(category.id, { projectId: "project-1" })));
    await refusedBy(SHAPE, make(noneData(category.id, { dealId: "deal-1" })));
    await refusedBy(SHAPE, make(noneData(category.id, { meetingId: "meeting-1" })));
  });
});

describe("time_entry_activity_target (AC-2.7)", () => {
  const RULE = "time_entry_activity_target";

  it("accepts an activity pointer on a project and on a deal entry, and none", async () => {
    expect((await make(projectData({ activityId: "activity-1" }))).activityId).toBe("activity-1");
    expect((await make(dealData({ activityId: "activity-1" }))).activityId).toBe("activity-1");
    expect((await make(meetingData())).activityId).toBeNull();
  });

  it("refuses an activity pointer on a meeting entry", async () => {
    await refusedBy(RULE, make(meetingData({ activityId: "activity-1" })));
  });

  it("refuses an activity pointer on an entry on no entity", async () => {
    const category = await makeCategory();
    await refusedBy(RULE, make(noneData(category.id, { activityId: "activity-1" })));
  });
});

describe("unique names (AC-3.1, plan § Data model)", () => {
  // Prisma turns a unique violation on an expression index into "Unique constraint failed on the
  // fields: (...)" without the index's name, so the refusals are asserted on a raw INSERT, where
  // Postgres' own message names the index.
  const insertCategory = (name: string) =>
    db.$executeRaw`INSERT INTO "time_category" ("id", "name", "createdBy", "updatedAt")
                   VALUES (${next("tc-raw")}, ${name}, ${MINE}, CURRENT_TIMESTAMP)`;
  const insertWorkType = (list: "project" | "deal", name: string) =>
    db.$executeRaw`INSERT INTO "work_type" ("id", "list", "name", "createdBy", "updatedAt")
                   VALUES (${next("wt-raw")}, ${list}::"WorkTypeList", ${name}, ${MINE}, CURRENT_TIMESTAMP)`;

  it("refuses a category whose name differs only by case from another", async () => {
    await makeCategory("Mentoring");
    await refusedBy("time_category_name_lower_key", insertCategory("mentoring"));
    await refusedBy("time_category_name_lower_key", insertCategory("MENTORING"));
    expect(await insertCategory("Mentoring coach")).toBe(1);
  });

  it("keeps a retired category's name taken", async () => {
    await makeCategory("Mentoring", { retiredAt: new Date() });
    await refusedBy("time_category_name_lower_key", insertCategory("mentoring"));
  });

  it("refuses a second work type whose name differs only by case in the same list", async () => {
    await makeWorkType("project", "Reviewing");
    await refusedBy("work_type_list_name_lower_key", insertWorkType("project", "reviewing"));
    await makeWorkType("deal", "Pitching");
    await refusedBy("work_type_list_name_lower_key", insertWorkType("deal", "PITCHING"));
  });

  it("keeps a retired work type's name taken", async () => {
    await makeWorkType("project", "Reviewing", { retiredAt: new Date() });
    await refusedBy("work_type_list_name_lower_key", insertWorkType("project", "reviewing"));
  });

  it("allows the same work type name in the two lists, and a work type named like a category", async () => {
    await makeWorkType("project", "Coaching");
    expect((await makeWorkType("deal", "coaching")).list).toBe("deal");
    await makeCategory("Coaching");
    expect((await makeWorkType("project", "Mentoring")).name).toBe("Mentoring");
    expect((await makeCategory("mentoring")).name).toBe("mentoring");
  });
});

describe("Restrict on a category or work type an entry uses (AC-3.2)", () => {
  it("blocks a raw DELETE of a category an entry uses, and allows it for an unused one", async () => {
    const used = await makeCategory();
    const unused = await makeCategory();
    await make(noneData(used.id));

    await refusedBy("time_entry_categoryId_fkey", db.$executeRaw`DELETE FROM "time_category" WHERE "id" = ${used.id}`);
    expect(await db.timeCategory.count({ where: { id: used.id } })).toBe(1);

    expect(await db.$executeRaw`DELETE FROM "time_category" WHERE "id" = ${unused.id}`).toBe(1);
  });

  it("blocks a raw DELETE of a work type an entry uses, and allows it for an unused one", async () => {
    const used = await makeWorkType();
    const unused = await makeWorkType();
    await make(projectData({ workTypeId: used.id }));

    await refusedBy("time_entry_workTypeId_fkey", db.$executeRaw`DELETE FROM "work_type" WHERE "id" = ${used.id}`);
    expect(await db.workType.count({ where: { id: used.id } })).toBe(1);

    expect(await db.$executeRaw`DELETE FROM "work_type" WHERE "id" = ${unused.id}`).toBe(1);
  });

  it("refuses an entry that points at a category or work type that does not exist", async () => {
    await refusedBy("time_entry_categoryId_fkey", make(noneData("no-such-category")));
    await refusedBy("time_entry_workTypeId_fkey", make(projectData({ workTypeId: "no-such-work-type" })));
  });
});
