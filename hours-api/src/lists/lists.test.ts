/**
 * The categories and work types (specs/029 T12; AC-3.1 – AC-3.4, AC-3.7, AC-3.8): the lists everyone
 * reads with a session, and the writes only a holder of `time-list:manage` may make, asked live of
 * `auth` (played by the fake hosts of T11).
 *
 * Import order: `world` first. The harness replaces the JWT middleware with `mock.module`, which only
 * reaches modules loaded afterwards (the trap in test-support/world.ts).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  app,
  bearerOf,
  call,
  db,
  makeCategory,
  makeNoEntityEntry,
  makeProjectEntry,
  makeWorkType,
  resetWorld,
} from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __resetTimeListManageCacheForTests } from "../authz/timeListManage";

const hosts = startHosts();
afterAll(() => hosts.stop());

beforeEach(async () => {
  await resetWorld();
  __resetTimeListManageCacheForTests();
  hosts.auth.grant(PERSONAS.manager.sub, "time-list", "manage");
});

describe("GET /time-lists", () => {
  it("lists the initial lists of AC-3.7 to anyone with a session, no permission needed", async () => {
    const res = await call("GET", "/time-lists", { as: "alice" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      categories: [
        { id: SEED.categories.administration, name: "Administration", requiresNote: false, retired: false },
        { id: SEED.categories.other, name: "Other", requiresNote: true, retired: false },
        { id: SEED.categories.talkPreparation, name: "Talk preparation", requiresNote: false, retired: false },
        { id: SEED.categories.training, name: "Training", requiresNote: false, retired: false },
      ],
      workTypes: {
        project: [
          { id: SEED.workTypes.project.analysis, list: "project", name: "Analysis", retired: false },
          { id: SEED.workTypes.project.development, list: "project", name: "Development", retired: false },
          { id: SEED.workTypes.project.projectManagement, list: "project", name: "Project management", retired: false },
          { id: SEED.workTypes.project.support, list: "project", name: "Support", retired: false },
        ],
        deal: [
          { id: SEED.workTypes.deal.analysis, list: "deal", name: "Analysis", retired: false },
          { id: SEED.workTypes.deal.demo, list: "deal", name: "Demo", retired: false },
          { id: SEED.workTypes.deal.estimate, list: "deal", name: "Estimate", retired: false },
          { id: SEED.workTypes.deal.offer, list: "deal", name: "Offer", retired: false },
        ],
      },
    });
    // Reading asks `auth` nothing: a session is all a person needs (AC-5.1).
    expect(hosts.calls).toHaveLength(0);
  });

  it("hides the retired items unless includeRetired=true, and never says a retired one is gone (AC-3.4)", async () => {
    const category = await makeCategory("Seminars", { retired: true });
    const projectType = await makeWorkType("project", "Workshops", { retired: true });
    const dealType = await makeWorkType("deal", "Pitch", { retired: true });

    for (const query of ["", "?includeRetired=false"]) {
      const hidden = await call("GET", `/time-lists${query}`);
      expect(hidden.status).toBe(200);
      const ids = JSON.stringify(hidden.json);
      for (const retired of [category.id, projectType.id, dealType.id]) expect(ids).not.toContain(retired);
    }

    const shown = await call("GET", "/time-lists?includeRetired=true");
    expect(shown.status).toBe(200);
    expect(shown.json.categories.find((item: { id: string }) => item.id === category.id)).toEqual({
      id: category.id,
      name: "Seminars",
      requiresNote: false,
      retired: true,
    });
    expect(shown.json.workTypes.project.find((item: { id: string }) => item.id === projectType.id)).toEqual({
      id: projectType.id,
      list: "project",
      name: "Workshops",
      retired: true,
    });
    expect(shown.json.workTypes.deal.find((item: { id: string }) => item.id === dealType.id)).toEqual({
      id: dealType.id,
      list: "deal",
      name: "Pitch",
      retired: true,
    });
    // The seeded rows are still there, active.
    expect(shown.json.categories.filter((item: { retired: boolean }) => !item.retired)).toHaveLength(4);
  });

  it("puts an item an admin added after the ones before it, in the order they were created", async () => {
    // Created in this order (after the seeded rows), but named so that the alphabet would say the opposite.
    await db.timeCategory.create({ data: { name: "Zeta", createdBy: "u", createdAt: new Date("2099-01-01T10:00:00Z") } });
    await db.timeCategory.create({ data: { name: "Alpha", createdBy: "u", createdAt: new Date("2099-01-01T11:00:00Z") } });
    const res = await call("GET", "/time-lists");
    expect(res.json.categories.map((item: { name: string }) => item.name)).toEqual([
      "Administration",
      "Other",
      "Talk preparation",
      "Training",
      "Zeta",
      "Alpha",
    ]);
  });

  it("answers anything but true or false in includeRetired, and a repeated one, with 400 invalid_request", async () => {
    for (const query of ["includeRetired=yes", "includeRetired=", "includeRetired=TRUE", "includeRetired=true&includeRetired=false"]) {
      const res = await call("GET", `/time-lists?${query}`);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_request");
      expect(res.json.field).toBe("includeRetired");
    }
  });
});

describe("POST /time-categories", () => {
  it("lets a holder of time-list:manage create a category: 201 and the view, created by them (AC-3.1)", async () => {
    const res = await call("POST", "/time-categories", { as: "manager", body: { name: "Seminars" } });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), name: "Seminars", requiresNote: false, retired: false });
    const row = await db.timeCategory.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(row).toMatchObject({ name: "Seminars", requiresNote: false, retiredAt: null, createdBy: PERSONAS.manager.sub });

    const withNote = await call("POST", "/time-categories", { as: "manager", body: { name: "Client travel", requiresNote: true } });
    expect(withNote.status).toBe(201);
    expect(withNote.json.requiresNote).toBe(true);

    // It is in the lists now, after the initial ones.
    const lists = await call("GET", "/time-lists");
    expect(lists.json.categories.map((item: { name: string }) => item.name)).toContain("Seminars");
  });

  it("asks auth as the caller: the caller's own Authorization header, verbatim, and nothing else", async () => {
    await call("POST", "/time-categories", { as: "manager", body: { name: "Seminars" } });
    const asked = hosts.callsTo("auth.resolve");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(await bearerOf("manager"));
    expect(hosts.calls).toHaveLength(1);
  });

  it("refuses a caller without time-list:manage with 403 time_list_manage_required and changes nothing (AC-3.3)", async () => {
    // `admin` is the admin role, which holds neither list permission unless a test grants it: Admin
    // access is not the permission (AC-3.3). `alice` is anyone.
    for (const as of ["alice", "admin"] as const) {
      const res = await call("POST", "/time-categories", { as, body: { name: "Seminars" } });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "time_list_manage_required" });
    }
    expect(await db.timeCategory.count()).toBe(4);
  });

  it("does not take another permission for this one: a grant of time-entry:read-all is not time-list:manage", async () => {
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    const res = await call("POST", "/time-categories", { as: "holder", body: { name: "Seminars" } });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("time_list_manage_required");
  });

  const OUTAGES: Array<[string, () => void]> = [
    ["a 500", () => hosts.fail("auth.resolve", { status: 500 })],
    ["a 502", () => hosts.fail("auth.resolve", { status: 502 })],
    ["a 401", () => hosts.fail("auth.resolve", { status: 401 })],
    ["a 200 that is not JSON", () => hosts.fail("auth.resolve", { rawBody: "<html>gateway</html>" })],
    ["a 200 whose permissions are not a list", () => hosts.fail("auth.resolve", { body: { permissions: "everything" } })],
    ["a 200 with no permissions member", () => hosts.fail("auth.resolve", { body: { sub: "user-manager" } })],
    ["a 200 listing something that is not a permission", () => hosts.fail("auth.resolve", { body: { permissions: [null, 3] } })],
    ["a redirect", () => hosts.fail("auth.resolve", { redirect: true })],
    ["an unreachable auth", () => hosts.sever("auth")],
    ["an auth that does not answer within 2 s", () => hosts.fail("auth.resolve", { delayMs: 2_600 })],
  ];

  for (const [outage, cause] of OUTAGES) {
    it(`fails closed on ${outage}: 503 authz_unavailable, nothing written, even for a holder (AC-3.3)`, async () => {
      cause();
      const res = await call("POST", "/time-categories", { as: "manager", body: { name: "Seminars" } });
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
      expect(await db.timeCategory.count()).toBe(4);
    });
  }

  it("never takes an unreadable answer for a permission: the outage does not grant, and a redirect is not followed", async () => {
    hosts.fail("auth.resolve", { redirect: true });
    await call("POST", "/time-categories", { as: "manager", body: { name: "Seminars" } });
    expect(hosts.elsewhere).toHaveLength(0);
  });
});

describe("a name already taken (plan § Lists: unique per list, case-insensitive, retired rows included)", () => {
  it("refuses a category named like another, whatever the case: 409 name_taken, nothing added", async () => {
    for (const name of ["Training", "training", "TRAINING", "tRaInInG"]) {
      const res = await call("POST", "/time-categories", { as: "manager", body: { name } });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ status: 409, code: "name_taken" });
    }
    expect(await db.timeCategory.count()).toBe(4);
  });

  it("counts the retired ones: a retired category keeps its name", async () => {
    await makeCategory("Seminars", { retired: true });
    const res = await call("POST", "/time-categories", { as: "manager", body: { name: "seminars" } });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("name_taken");
  });

  it("compares the name as it will be stored: trimmed at the ends, inner spaces as typed", async () => {
    expect((await call("POST", "/time-categories", { as: "manager", body: { name: "  Training \n" } })).status).toBe(409);
    expect((await call("POST", "/time-categories", { as: "manager", body: { name: "Talk  preparation" } })).status).toBe(201);
  });

  it("refuses a work type named like another of the SAME list, retired ones included", async () => {
    await makeWorkType("deal", "Pitch", { retired: true });
    for (const [list, name] of [
      ["project", "development"],
      ["project", "PROJECT MANAGEMENT"],
      ["deal", "demo"],
      ["deal", "pitch"],
    ] as const) {
      const res = await call("POST", "/work-types", { as: "manager", body: { list, name } });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ status: 409, code: "name_taken" });
    }
    expect(await db.workType.count()).toBe(9);
  });

  it("lets the other list, and the categories, use a name a work type has: each list is its own namespace", async () => {
    // "Analysis" is in both seeded lists already; "Demo" only in the deal list, "Development" only in the project list.
    expect((await call("POST", "/work-types", { as: "manager", body: { list: "project", name: "Demo" } })).status).toBe(201);
    expect((await call("POST", "/work-types", { as: "manager", body: { list: "deal", name: "Development" } })).status).toBe(201);
    expect((await call("POST", "/time-categories", { as: "manager", body: { name: "Development" } })).status).toBe(201);
    expect((await call("POST", "/work-types", { as: "manager", body: { list: "deal", name: "Training" } })).status).toBe(201);
  });
});

describe("renaming (PATCH { name })", () => {
  it("renames a category and answers the view; the rest of the row stays (AC-3.1)", async () => {
    const before = await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } });
    const res = await call("PATCH", `/time-categories/${SEED.categories.other}`, { as: "manager", body: { name: "  Miscellaneous " } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: SEED.categories.other, name: "Miscellaneous", requiresNote: true, retired: false });
    const after = await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } });
    expect(after).toMatchObject({ name: "Miscellaneous", requiresNote: true, retiredAt: null, createdBy: "system:migration" });
    expect(after.createdAt).toEqual(before.createdAt);
  });

  for (const list of ["project", "deal"] as const) {
    it(`renames a work type of the ${list} list, and the answer carries its list`, async () => {
      const id = list === "project" ? SEED.workTypes.project.support : SEED.workTypes.deal.demo;
      const res = await call("PATCH", `/work-types/${id}`, { as: "manager", body: { name: "Formazione" } });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ id, list, name: "Formazione", retired: false });
    });
  }

  it("answers a name exactly as typed in both languages: case and inner spaces kept, trimmed only at the ends (AC-3.8)", async () => {
    const name = "Formazione  e   AFFIANCAMENTO";
    const res = await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { name: `\t${name}\n` } });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe(name);
    for (const lang of ["en", "it"]) {
      const lists = await call("GET", "/time-lists", { headers: { "Accept-Language": lang } });
      expect(lists.json.categories.find((item: { id: string }) => item.id === SEED.categories.training).name).toBe(name);
    }
  });

  it("answers 404 not_found for a well-formed id no item has, in either list", async () => {
    for (const path of ["/time-categories/tc-nope", "/work-types/wt-nope"]) {
      const res = await call("PATCH", path, { as: "manager", body: { name: "Anything" } });
      expect(res.status).toBe(404);
      expect(res.json.status).toBe(404);
    }
  });

  it("renames a retired item and leaves it retired: Rename is offered on a retired row (design S5)", async () => {
    const retired = await makeCategory("Seminars", { retired: true });
    const res = await call("PATCH", `/time-categories/${retired.id}`, { as: "manager", body: { name: "Workshops" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: retired.id, name: "Workshops", requiresNote: false, retired: true });
    expect((await db.timeCategory.findUniqueOrThrow({ where: { id: retired.id } })).retiredAt).toBeInstanceOf(Date);

    const retiredType = await makeWorkType("deal", "Pitch", { retired: true });
    const renamed = await call("PATCH", `/work-types/${retiredType.id}`, { as: "manager", body: { name: "Pitching" } });
    expect(renamed.json).toEqual({ id: retiredType.id, list: "deal", name: "Pitching", retired: true });
  });

  it("answers an id of no length, or a path longer than the route, with the app's 404 for everyone", async () => {
    for (const path of ["/time-categories/", "/work-types/", "/time-categories/a/b", "/work-types/a/b"]) {
      for (const as of ["manager", "alice"] as const) {
        const res = await call("PATCH", path, { as, body: { name: "Workshops" } });
        expect(res.status).toBe(404);
      }
    }
  });

  it("does not take a work type's id for a category's, nor the reverse", async () => {
    expect((await call("PATCH", `/time-categories/${SEED.workTypes.deal.demo}`, { as: "manager", body: { name: "X" } })).status).toBe(404);
    expect((await call("PATCH", `/work-types/${SEED.categories.training}`, { as: "manager", body: { name: "X" } })).status).toBe(404);
  });
});

describe("retiring and restoring (PATCH { retired })", () => {
  type Item = { id: string };
  const inLists = async (query = "") => (await call("GET", `/time-lists${query}`)).json;

  it("retires a category, which leaves GET /time-lists but stays on includeRetired, and restores it (AC-3.1, AC-3.4)", async () => {
    const id = SEED.categories.talkPreparation;

    const retired = await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { retired: true } });
    expect(retired.status).toBe(200);
    expect(retired.json).toEqual({ id, name: "Talk preparation", requiresNote: false, retired: true });
    expect((await db.timeCategory.findUniqueOrThrow({ where: { id } })).retiredAt).toBeInstanceOf(Date);
    expect((await inLists()).categories.map((item: Item) => item.id)).not.toContain(id);
    expect((await inLists("?includeRetired=true")).categories.map((item: Item) => item.id)).toContain(id);

    const restored = await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { retired: false } });
    expect(restored.status).toBe(200);
    expect(restored.json).toEqual({ id, name: "Talk preparation", requiresNote: false, retired: false });
    expect((await db.timeCategory.findUniqueOrThrow({ where: { id } })).retiredAt).toBeNull();
    expect((await inLists()).categories.map((item: Item) => item.id)).toContain(id);
  });

  for (const list of ["project", "deal"] as const) {
    it(`retires and restores a work type of the ${list} list, the same way`, async () => {
      const id = list === "project" ? SEED.workTypes.project.analysis : SEED.workTypes.deal.offer;
      const retired = await call("PATCH", `/work-types/${id}`, { as: "manager", body: { retired: true } });
      expect(retired.status).toBe(200);
      expect(retired.json.retired).toBe(true);
      expect((await inLists()).workTypes[list].map((item: Item) => item.id)).not.toContain(id);
      expect((await inLists("?includeRetired=true")).workTypes[list].map((item: Item) => item.id)).toContain(id);

      const restored = await call("PATCH", `/work-types/${id}`, { as: "manager", body: { retired: false } });
      expect(restored.status).toBe(200);
      expect(restored.json.retired).toBe(false);
      expect((await inLists()).workTypes[list].map((item: Item) => item.id)).toContain(id);
    });
  }

  it("is idempotent: retiring a retired item and restoring an active one answer 200 and leave the row as it was", async () => {
    const id = SEED.categories.administration;
    const retire = () => call("PATCH", `/time-categories/${id}`, { as: "manager", body: { retired: true } });
    const restore = () => call("PATCH", `/time-categories/${id}`, { as: "manager", body: { retired: false } });

    // Restoring an item that was never retired.
    const untouched = await db.timeCategory.findUniqueOrThrow({ where: { id } });
    expect((await restore()).status).toBe(200);
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id } })).toEqual(untouched);

    expect((await retire()).status).toBe(200);
    const once = await db.timeCategory.findUniqueOrThrow({ where: { id } });
    const twice = await retire();
    expect(twice.status).toBe(200);
    expect(twice.json.retired).toBe(true);
    // The instant of the first retire is kept, and so is `updatedAt`.
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id } })).toEqual(once);

    expect((await restore()).status).toBe(200);
    const restoredOnce = await db.timeCategory.findUniqueOrThrow({ where: { id } });
    expect((await restore()).status).toBe(200);
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id } })).toEqual(restoredOnce);

    // And for a work type.
    const workTypeId = SEED.workTypes.deal.demo;
    const retireWorkType = () => call("PATCH", `/work-types/${workTypeId}`, { as: "manager", body: { retired: true } });
    await retireWorkType();
    const retiredWorkType = await db.workType.findUniqueOrThrow({ where: { id: workTypeId } });
    expect((await retireWorkType()).status).toBe(200);
    expect(await db.workType.findUniqueOrThrow({ where: { id: workTypeId } })).toEqual(retiredWorkType);
  });

  it("touches no entry: the entries that have the item keep it, retired or restored (AC-3.4)", async () => {
    const entry = await makeNoEntityEntry(SEED.categories.training);
    const projectEntry = await makeProjectEntry("project-1", { workTypeId: SEED.workTypes.project.development });
    await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { retired: true } });
    await call("PATCH", `/work-types/${SEED.workTypes.project.development}`, { as: "manager", body: { retired: true } });
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(entry);
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: projectEntry.id } })).toEqual(projectEntry);
    await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { retired: false } });
    await call("PATCH", `/work-types/${SEED.workTypes.project.development}`, { as: "manager", body: { retired: false } });
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(entry);
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: projectEntry.id } })).toEqual(projectEntry);
  });

  it("applies a rename and a retire sent together, or none of them", async () => {
    const id = SEED.categories.administration;
    const both = await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { name: "Back office", retired: true } });
    expect(both.status).toBe(200);
    expect(both.json).toEqual({ id, name: "Back office", requiresNote: false, retired: true });
  });
});

describe("a rename (alone, or with a restore) to a name already taken", () => {
  it("is 409 name_taken with the row unchanged, whatever the case, in a category", async () => {
    const before = await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } });
    for (const name of ["Training", "training", " ADMINISTRATION "]) {
      const res = await call("PATCH", `/time-categories/${SEED.categories.other}`, { as: "manager", body: { name } });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ status: 409, code: "name_taken" });
    }
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } })).toEqual(before);
  });

  it("counts a retired category's name as taken on a rename too", async () => {
    await makeCategory("Seminars", { retired: true });
    const before = await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } });
    const res = await call("PATCH", `/time-categories/${SEED.categories.other}`, { as: "manager", body: { name: "seminars" } });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("name_taken");
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } })).toEqual(before);
  });

  it("is 409 name_taken with the row unchanged in each work-type list, and a retired row's name is taken too", async () => {
    await makeWorkType("deal", "Pitch", { retired: true });
    const cases = [
      { id: SEED.workTypes.project.support, name: "development" },
      { id: SEED.workTypes.deal.offer, name: "DEMO" },
      { id: SEED.workTypes.deal.offer, name: "pitch" },
    ];
    for (const { id, name } of cases) {
      const before = await db.workType.findUniqueOrThrow({ where: { id } });
      const res = await call("PATCH", `/work-types/${id}`, { as: "manager", body: { name } });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("name_taken");
      expect(await db.workType.findUniqueOrThrow({ where: { id } })).toEqual(before);
    }
  });

  it("leaves a retired item retired when the rename sent with its restore is refused: one transaction", async () => {
    const retired = await makeCategory("Seminars", { retired: true });
    const before = await db.timeCategory.findUniqueOrThrow({ where: { id: retired.id } });
    const res = await call("PATCH", `/time-categories/${retired.id}`, { as: "manager", body: { name: "Training", retired: false } });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("name_taken");
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id: retired.id } })).toEqual(before);

    const workType = await makeWorkType("project", "Workshops", { retired: true });
    const workTypeBefore = await db.workType.findUniqueOrThrow({ where: { id: workType.id } });
    const refused = await call("PATCH", `/work-types/${workType.id}`, { as: "manager", body: { name: "development", retired: false } });
    expect(refused.status).toBe(409);
    expect(await db.workType.findUniqueOrThrow({ where: { id: workType.id } })).toEqual(workTypeBefore);
  });

  it("does not refuse an item its own name: a restore alone never collides, and a change of case is a rename", async () => {
    const retired = await makeCategory("Seminars", { retired: true });
    expect((await call("PATCH", `/time-categories/${retired.id}`, { as: "manager", body: { retired: false } })).status).toBe(200);
    const sameName = await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { name: "Training" } });
    expect(sameName.status).toBe(200);
    const recased = await call("PATCH", `/time-categories/${SEED.categories.training}`, { as: "manager", body: { name: "TRAINING" } });
    expect(recased.status).toBe(200);
    expect(recased.json.name).toBe("TRAINING");
  });

  it("lets a work type take a name only the OTHER list has", async () => {
    // "Demo" is a deal work type; the project list has no such name.
    const res = await call("PATCH", `/work-types/${SEED.workTypes.project.support}`, { as: "manager", body: { name: "Demo" } });
    expect(res.status).toBe(200);
  });
});

describe("what a PATCH may carry", () => {
  const BAD_BODIES: Array<[string, unknown]> = [
    ["no member at all", {}],
    ["`list`, which a work type never changes", { list: "deal" }],
    ["`list` next to a good member", { name: "Workshops", list: "deal" }],
    ["an unknown key", { name: "Workshops", color: "red" }],
    ["an id in the body", { id: "tc-other", name: "Workshops" }],
    ["a retired that is not a boolean", { retired: "yes" }],
    ["a retired of null", { retired: null }],
    ["a name that is not a string", { name: 7 }],
    ["a name of null", { name: null }],
    ["an array", [{ name: "Workshops" }]],
    ["null", null],
  ];

  for (const [label, body] of BAD_BODIES) {
    it(`refuses ${label}: 400 invalid_request, nothing changes, on a category and on a work type`, async () => {
      const category = await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } });
      const workType = await db.workType.findUniqueOrThrow({ where: { id: SEED.workTypes.deal.demo } });
      for (const path of [`/time-categories/${SEED.categories.other}`, `/work-types/${SEED.workTypes.deal.demo}`]) {
        const res = await call("PATCH", path, { as: "manager", body });
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ status: 400, code: "invalid_request" });
      }
      expect(await db.timeCategory.findUniqueOrThrow({ where: { id: SEED.categories.other } })).toEqual(category);
      expect(await db.workType.findUniqueOrThrow({ where: { id: SEED.workTypes.deal.demo } })).toEqual(workType);
    });
  }

  it("refuses malformed JSON and no body at all with 400 invalid_request", async () => {
    for (const path of [`/time-categories/${SEED.categories.other}`, `/work-types/${SEED.workTypes.deal.demo}`]) {
      const malformed = await call("PATCH", path, { as: "manager", rawBody: '{"name": ' });
      expect(malformed.status).toBe(400);
      expect(malformed.json.code).toBe("invalid_request");
      const empty = await call("PATCH", path, { as: "manager" });
      expect(empty.status).toBe(400);
      expect(empty.json.code).toBe("invalid_request");
    }
  });

  it("lets a category's requiresNote change, alone or with the rest, and not a work type's: it has none", async () => {
    const id = SEED.categories.training;
    const on = await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { requiresNote: true } });
    expect(on.status).toBe(200);
    expect(on.json).toEqual({ id, name: "Training", requiresNote: true, retired: false });
    expect((await db.timeCategory.findUniqueOrThrow({ where: { id } })).requiresNote).toBe(true);

    const both = await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { requiresNote: false, name: "Learning" } });
    expect(both.json).toEqual({ id, name: "Learning", requiresNote: false, retired: false });

    // The same value again changes nothing, `updatedAt` included.
    const before = await db.timeCategory.findUniqueOrThrow({ where: { id } });
    expect((await call("PATCH", `/time-categories/${id}`, { as: "manager", body: { requiresNote: false } })).status).toBe(200);
    expect(await db.timeCategory.findUniqueOrThrow({ where: { id } })).toEqual(before);

    const workType = await call("PATCH", `/work-types/${SEED.workTypes.deal.demo}`, { as: "manager", body: { requiresNote: true } });
    expect(workType.status).toBe(400);
  });
});

describe("every write needs time-list:manage, asked first (AC-3.3)", () => {
  interface Write {
    readonly label: string;
    readonly method: "POST" | "PATCH";
    readonly path: string;
    readonly body: unknown;
  }
  const categoryPath = `/time-categories/${SEED.categories.other}`;
  const workTypePath = `/work-types/${SEED.workTypes.deal.demo}`;
  const WRITES: Write[] = [
    { label: "create a category", method: "POST", path: "/time-categories", body: { name: "Seminars" } },
    { label: "rename a category", method: "PATCH", path: categoryPath, body: { name: "Misc" } },
    { label: "retire a category", method: "PATCH", path: categoryPath, body: { retired: true } },
    { label: "restore a category", method: "PATCH", path: categoryPath, body: { retired: false } },
    { label: "create a work type", method: "POST", path: "/work-types", body: { list: "deal", name: "Workshops" } },
    { label: "rename a work type", method: "PATCH", path: workTypePath, body: { name: "Misc" } },
    { label: "retire a work type", method: "PATCH", path: workTypePath, body: { retired: true } },
    { label: "restore a work type", method: "PATCH", path: workTypePath, body: { retired: false } },
  ];

  const snapshot = async () => [
    await db.timeCategory.findMany({ orderBy: { id: "asc" } }),
    await db.workType.findMany({ orderBy: { id: "asc" } }),
  ];

  // A retired row, so that "restore" has something to change if the gate ever let it through.
  beforeEach(async () => {
    await db.timeCategory.update({ where: { id: SEED.categories.other }, data: { retiredAt: new Date() } });
    await db.workType.update({ where: { id: SEED.workTypes.deal.demo }, data: { retiredAt: new Date() } });
  });

  for (const write of WRITES) {
    it(`to ${write.label}: 403 time_list_manage_required for someone without it, admin role included, the rows unchanged`, async () => {
      const before = await snapshot();
      for (const as of ["alice", "admin"] as const) {
        const res = await call(write.method, write.path, { as, body: write.body });
        expect(res.status).toBe(403);
        expect(res.json).toMatchObject({ status: 403, code: "time_list_manage_required" });
      }
      expect(await snapshot()).toEqual(before);
    });

    it(`to ${write.label}: 503 authz_unavailable when auth cannot answer, even for a holder, the rows unchanged`, async () => {
      const before = await snapshot();
      hosts.fail("auth.resolve", { status: 500 });
      const res = await call(write.method, write.path, { as: "manager", body: write.body });
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
      expect(await snapshot()).toEqual(before);
    });
  }

  it("is decided before the body and the path are looked at: a caller without the permission is refused whatever they send", async () => {
    const before = await snapshot();
    const mess: Array<[string, string, unknown, string | undefined]> = [
      ["POST", "/time-categories", { name: "\u0000" }, undefined],
      ["POST", "/time-categories", { name: "x".repeat(500), extra: true }, undefined],
      ["POST", "/work-types", { list: "elsewhere" }, undefined],
      ["PATCH", categoryPath, {}, undefined],
      ["PATCH", categoryPath, { list: "deal" }, undefined],
      ["PATCH", `/time-categories/${"a".repeat(65)}`, { name: "Misc" }, undefined],
      ["PATCH", "/work-types/%00", { name: "Misc" }, undefined],
      ["PATCH", "/work-types/a%2Cb", { name: "Misc" }, undefined],
      ["PATCH", categoryPath, undefined, '{"name": '],
    ];
    for (const [method, path, body, rawBody] of mess) {
      const res = await call(method, path, { as: "alice", ...(rawBody !== undefined ? { rawBody } : { body }) });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("time_list_manage_required");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("answers the same 403 for an id that names no item: the permission is checked before any lookup", async () => {
    const res = await call("PATCH", "/time-categories/tc-nope", { as: "alice", body: { name: "Misc" } });
    expect(res.status).toBe(403);
  });
});

describe("the name of an item, on create and on rename in each list (plan § Lists, § Entries 'Counting a note and a name')", () => {
  /** Each way to send a name: create or rename, in the categories and in each work-type list. */
  const WAYS: Array<{ label: string; send: (name: unknown) => ReturnType<typeof call>; stored: () => Promise<string[]> }> = [
    {
      label: "create a category",
      send: (name) => call("POST", "/time-categories", { as: "manager", body: { name } }),
      stored: async () => (await db.timeCategory.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
    {
      label: "rename a category",
      send: (name) => call("PATCH", `/time-categories/${SEED.categories.other}`, { as: "manager", body: { name } }),
      stored: async () => (await db.timeCategory.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
    {
      label: "create a project work type",
      send: (name) => call("POST", "/work-types", { as: "manager", body: { list: "project", name } }),
      stored: async () => (await db.workType.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
    {
      label: "rename a project work type",
      send: (name) => call("PATCH", `/work-types/${SEED.workTypes.project.support}`, { as: "manager", body: { name } }),
      stored: async () => (await db.workType.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
    {
      label: "create a deal work type",
      send: (name) => call("POST", "/work-types", { as: "manager", body: { list: "deal", name } }),
      stored: async () => (await db.workType.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
    {
      label: "rename a deal work type",
      send: (name) => call("PATCH", `/work-types/${SEED.workTypes.deal.offer}`, { as: "manager", body: { name } }),
      stored: async () => (await db.workType.findMany({ orderBy: { id: "asc" } })).map((row) => row.name),
    },
  ];

  const REFUSED: Array<[string, unknown]> = [
    ["a NUL", "Sem\u0000inars"],
    ["only a NUL", "\u0000"],
    ["a NUL behind a space", " \u0000"],
    ["a lone low surrogate", "\udc00"],
    ["a lone high surrogate", "a\ud800"],
    ["a high surrogate first", "\ud800b"],
    ["a low surrogate between letters", "a\udc00b"],
    ["81 emoji", "😀".repeat(81)],
    ["81 letters", "a".repeat(81)],
    ["81 letters between spaces", `  ${"a".repeat(81)}  `],
    ["nothing", ""],
    ["only spaces", "     "],
    ["only line breaks and tabs", "\n\t\r"],
    ["a number", 7],
    ["null", null],
    ["an object", { name: "x" }],
  ];

  for (const way of WAYS) {
    for (const [what, name] of REFUSED) {
      it(`to ${way.label}: ${what} is 400 invalid_request naming "name", and nothing is stored or changed`, async () => {
        const before = await way.stored();
        const res = await way.send(name);
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ status: 400, code: "invalid_request", field: "name" });
        expect(await way.stored()).toEqual(before);
      });
    }
  }

  const ACCEPTED: Array<[string, string, string]> = [
    ["80 emoji (160 UTF-16 units)", "😀".repeat(80), "😀".repeat(80)],
    ["80 letters", "b".repeat(80), "b".repeat(80)],
    ["80 emoji between spaces, trimmed", `  ${"🧑".repeat(80)}\n`, "🧑".repeat(80)],
    ["a name with accents, kept as typed", "Formazione e affiancamento — àèìòù", "Formazione e affiancamento — àèìòù"],
    ["a name with inner spaces and capitals, kept as typed", "AI   pair-Programming", "AI   pair-Programming"],
  ];
  for (const way of WAYS) {
    for (const [what, sent, kept] of ACCEPTED) {
      it(`to ${way.label}: ${what} is accepted and stored whole`, async () => {
        const res = await way.send(sent);
        expect([200, 201]).toContain(res.status);
        expect(res.json.name).toBe(kept);
        expect(await way.stored()).toContain(kept);
      });
    }
  }
});

describe("the {id} of a PATCH (plan § Entries, the id rule)", () => {
  const ROUTES = ["time-categories", "work-types"] as const;
  /** `[path segment as sent, what it decodes to]`. */
  const OUTSIDE_THE_RULE: Array<[string, string]> = [
    [`${"a".repeat(65)}`, "65 characters"],
    ["%00", "a NUL"],
    ["a%00b", "a NUL inside"],
    ["a%2Cb", "a comma"],
    ["%2C", "only a comma"],
    ["%20a", "a space first"],
    ["a%20", "a space last"],
    ["%20", "only a space"],
    ["%09a", "a tab first"],
    ["a%0A", "a line break last"],
    ["%C2%A0a", "a no-break space first"],
    [`${"😀".repeat(33)}`, "33 emoji (66 UTF-16 units)"],
  ];

  for (const route of ROUTES) {
    for (const [segment, what] of OUTSIDE_THE_RULE) {
      it(`${route}: ${what} is 400 invalid_request naming "id" for a holder, and nothing changes, never a 500`, async () => {
        const categories = await db.timeCategory.findMany({ orderBy: { id: "asc" } });
        const workTypes = await db.workType.findMany({ orderBy: { id: "asc" } });
        const res = await call("PATCH", `/${route}/${segment}`, { as: "manager", body: { name: "Workshops" } });
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ status: 400, code: "invalid_request", field: "id" });
        expect(await db.timeCategory.findMany({ orderBy: { id: "asc" } })).toEqual(categories);
        expect(await db.workType.findMany({ orderBy: { id: "asc" } })).toEqual(workTypes);
      });

      it(`${route}: ${what} is 403 time_list_manage_required for someone without the permission, whatever the id`, async () => {
        const res = await call("PATCH", `/${route}/${segment}`, { as: "alice", body: { name: "Workshops" } });
        expect(res.status).toBe(403);
        expect(res.json.code).toBe("time_list_manage_required");
      });
    }
  }

  /** Well-formed, so the answer is the one of any id nobody holds: 404. */
  const WELL_FORMED_UNKNOWN: Array<[string, string]> = [
    ["a".repeat(64), "64 characters"],
    ["x", "one character"],
    ["a%26b", "an ampersand"],
    ["a%23b", "a hash"],
    ["a%2Bb", "a plus"],
    ["a%25b", "a percent sign"],
    ["a%20b", "an inner space"],
    ["a%2Fb", "a slash"],
    [`${"😀".repeat(32)}`, "32 emoji (64 UTF-16 units)"],
    ["tc-Training", "an id shaped like a seeded one"],
  ];
  for (const route of ROUTES) {
    for (const [segment, what] of WELL_FORMED_UNKNOWN) {
      it(`${route}: ${what} is a well-formed id nobody holds: 404 not_found`, async () => {
        const res = await call("PATCH", `/${route}/${segment}`, { as: "manager", body: { name: "Workshops" } });
        expect(res.status).toBe(404);
        expect(res.json.status).toBe(404);
      });
    }
  }

  it("answers an id that cannot be decoded at all with a 4xx, never a 500", async () => {
    for (const route of ROUTES) {
      for (const segment of ["%", "%zz", "%E0%A4%A", "%FF"]) {
        const res = await call("PATCH", `/${route}/${segment}`, { as: "manager", body: { name: "Workshops" } });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    }
  });
});

describe("no DELETE (AC-3.2)", () => {
  const TARGETS: Array<[string, string]> = [
    ["time-categories", SEED.categories.training],
    ["time-categories", SEED.categories.other],
    ["work-types", SEED.workTypes.project.development],
    ["work-types", SEED.workTypes.deal.offer],
  ];

  for (const [route, id] of TARGETS) {
    it(`DELETE /${route}/${id} is the app's own 404 for a holder, an admin and anyone, and the row stays`, async () => {
      for (const as of ["manager", "admin", "alice"] as const) {
        const res = await call("DELETE", `/${route}/${id}`, { as });
        expect(res.status).toBe(404);
        expect(res.json).toMatchObject({ status: 404, detail: `DELETE /${route}/${id} does not exist` });
      }
      const there =
        route === "time-categories"
          ? await db.timeCategory.count({ where: { id } })
          : await db.workType.count({ where: { id } });
      expect(there).toBe(1);
    });
  }

  it("is a 404 whatever the id, a malformed one included, and asks auth nothing: no route, no check", async () => {
    for (const route of ["time-categories", "work-types"]) {
      for (const segment of ["tc-nope", "a".repeat(65), "%00", "a%2Cb", "%20a"]) {
        const res = await call("DELETE", `/${route}/${segment}`, { as: "manager" });
        expect(res.status).toBe(404);
      }
    }
    expect(hosts.callsTo("auth.resolve")).toHaveLength(0);
  });

  it("has no DELETE of the collections either, nor a PUT of an item", async () => {
    for (const [method, path] of [
      ["DELETE", "/time-categories"],
      ["DELETE", "/work-types"],
      ["DELETE", "/time-lists"],
      ["PUT", `/time-categories/${SEED.categories.training}`],
      ["PUT", `/work-types/${SEED.workTypes.deal.demo}`],
      ["POST", `/time-categories/${SEED.categories.training}`],
    ] as const) {
      const res = await call(method, path, { as: "manager", body: { name: "Anything" } });
      expect(res.status).toBe(404);
    }
    expect(await db.timeCategory.count()).toBe(4);
    expect(await db.workType.count()).toBe(8);
  });
});

describe("what a POST may carry", () => {
  const BAD: Array<[string, string, unknown]> = [
    ["a category without a name", "/time-categories", {}],
    ["a category with a list", "/time-categories", { name: "Seminars", list: "project" }],
    ["a category with an unknown key", "/time-categories", { name: "Seminars", retired: true }],
    ["a category whose requiresNote is not a boolean", "/time-categories", { name: "Seminars", requiresNote: "yes" }],
    ["a category whose requiresNote is null", "/time-categories", { name: "Seminars", requiresNote: null }],
    ["a category as an array", "/time-categories", ["Seminars"]],
    ["a work type without a name", "/work-types", { list: "deal" }],
    ["a work type with an unknown key", "/work-types", { list: "deal", name: "Workshops", retired: true }],
    ["a work type as null", "/work-types", null],
  ];
  for (const [label, path, body] of BAD) {
    it(`refuses ${label}: 400 invalid_request, nothing added`, async () => {
      const res = await call("POST", path, { as: "manager", body });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ status: 400, code: "invalid_request" });
      expect(await db.timeCategory.count()).toBe(4);
      expect(await db.workType.count()).toBe(8);
    });
  }

  it("refuses malformed JSON, no body and a body that is not JSON with 400 invalid_request", async () => {
    for (const path of ["/time-categories", "/work-types"]) {
      expect((await call("POST", path, { as: "manager", rawBody: '{"name": ' })).status).toBe(400);
      expect((await call("POST", path, { as: "manager" })).status).toBe(400);
      const text = await app.request(path, {
        method: "POST",
        headers: { Authorization: await bearerOf("manager"), "Content-Type": "text/plain" },
        body: '{"list":"deal","name":"Workshops"}',
      });
      expect(text.status).toBe(400);
    }
    expect(await db.timeCategory.count()).toBe(4);
    expect(await db.workType.count()).toBe(8);
  });

  it("lets the database decide a race: two creates of one name at once are one 201 and one 409", async () => {
    const [first, second] = await Promise.all([
      call("POST", "/time-categories", { as: "manager", body: { name: "Seminars" } }),
      call("POST", "/time-categories", { as: "manager", body: { name: "SEMINARS" } }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await db.timeCategory.count({ where: { name: { in: ["Seminars", "SEMINARS"] } } })).toBe(1);

    const [third, fourth] = await Promise.all([
      call("POST", "/work-types", { as: "manager", body: { list: "deal", name: "Workshops" } }),
      call("POST", "/work-types", { as: "manager", body: { list: "deal", name: "workshops" } }),
    ]);
    expect([third.status, fourth.status].sort()).toEqual([201, 409]);
  });
});

describe("POST /work-types", () => {
  for (const list of ["project", "deal"] as const) {
    it(`lets a holder add a work type to the ${list} list: 201 and the view, created by them (AC-3.1)`, async () => {
      const res = await call("POST", "/work-types", { as: "manager", body: { list, name: "Workshops" } });
      expect(res.status).toBe(201);
      expect(res.json).toEqual({ id: expect.any(String), list, name: "Workshops", retired: false });
      const row = await db.workType.findUniqueOrThrow({ where: { id: res.json.id } });
      expect(row).toMatchObject({ list, name: "Workshops", retiredAt: null, createdBy: PERSONAS.manager.sub });

      const lists = await call("GET", "/time-lists");
      expect(lists.json.workTypes[list].map((item: { name: string }) => item.name)).toContain("Workshops");
      const other = list === "project" ? "deal" : "project";
      expect(lists.json.workTypes[other].map((item: { name: string }) => item.name)).not.toContain("Workshops");
    });
  }

  it("refuses a caller without time-list:manage with 403 time_list_manage_required and changes nothing (AC-3.3)", async () => {
    for (const as of ["alice", "admin"] as const) {
      const res = await call("POST", "/work-types", { as, body: { list: "deal", name: "Workshops" } });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "time_list_manage_required" });
    }
    expect(await db.workType.count()).toBe(8);
  });

  it("fails closed when auth cannot answer: 503 authz_unavailable, nothing written", async () => {
    hosts.fail("auth.resolve", { status: 500 });
    const res = await call("POST", "/work-types", { as: "manager", body: { list: "deal", name: "Workshops" } });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("authz_unavailable");
    expect(await db.workType.count()).toBe(8);
  });

  it("needs a list that is project or deal, and no other member: 400 invalid_request", async () => {
    for (const body of [{ name: "Workshops" }, { list: "meeting", name: "Workshops" }, { list: null, name: "Workshops" }, { list: "deal", name: "Workshops", requiresNote: true }]) {
      const res = await call("POST", "/work-types", { as: "manager", body });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    expect(await db.workType.count()).toBe(8);
  });
});
