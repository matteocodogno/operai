/**
 * `GET /activities?ids=` (specs/029-time-tracking T6; AC-2.7, AC-2.9, AC-4.10; plan § API
 * contracts "activities-api (changed)").
 *
 * hours-api asks one question of activities-api: "which of these activities does THIS PERSON
 * still read, and what are they?". The answer is the existing `Activity` view, the host of every
 * id is asked as the caller (ADR-0081), and an id the caller cannot read, an id whose entity the
 * host no longer knows and an id that never existed are one and the same thing: omitted. hours-api
 * reads that omission as "deleted, or not yours" (AC-2.9, D47), so nothing here may tell the
 * three apart, and nothing may be left out silently for any other reason (a page cut, a host
 * that did not answer).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { RESOLVE_BATCH_SIZE } from "../hosts/client";
import { bearerOf, call, db, hosts, makeCompany, makeDeal, makeProject, resetWorld, type PersonaName } from "../test-support/world";

beforeEach(resetWorld);

type Item = { id: string; subject: string };

const noteOn = async (companyId: string, subject: string, extra: Record<string, unknown> = {}) =>
  (await call("POST", "/activities", { as: "consultant", body: { type: "note", subject, companyId, ...extra } })).json as Item;

const taskOn = async (projectId: string, subject: string) =>
  (await call("POST", "/activities", { as: "manager", body: { type: "task", subject, projectId } })).json as Item;

const byIds = (ids: readonly string[], as: PersonaName | null = "bob") => call("GET", `/activities?ids=${ids.join(",")}`, { as });

/** The same activity row, written straight to the table: for the cases that need many or orphaned ones. */
const rawActivity = (hostApp: "crm" | "projects", hostId: string, subject: string, occurredAt = new Date()) =>
  db.activity.create({
    data:
      hostApp === "crm"
        ? { kind: "pre_sales", type: "note", hostApp, hostType: "company", hostId, subject, occurredAt, authorUserId: "user-consultant" }
        : { kind: "operational", type: "task", hostApp, hostType: "project", hostId, subject, occurredAt, authorUserId: "user-manager", assigneeUserId: "user-pm" },
  });

describe("activities of both hosts in one call (AC-2.7)", () => {
  it("returns each as the existing view, every host asked as the caller about its own entities", async () => {
    const company = makeCompany("Acme SA");
    const deal = makeDeal(company.id, "Grid analytics");
    const project = makeProject("Smart meter rollout");
    const pre = await noteOn(company.id, "Call about the offer", { dealId: deal.id });
    const op = await taskOn(project.id, "Install the gateways");
    hosts.crm.resolves.length = 0;
    hosts.projects.resolves.length = 0;

    const res = await byIds([pre.id, op.id]);

    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    // Not a second shape: exactly what the existing list answers for the same activities.
    const viaCompany = (await call("GET", `/activities?companyId=${company.id}`, { as: "bob" })).json.items[0];
    const viaProject = (await call("GET", `/activities?projectId=${project.id}`, { as: "bob" })).json.items[0];
    const sorted = [...res.json.items].sort((a: Item, b: Item) => a.id.localeCompare(b.id));
    expect(sorted).toEqual([viaCompany, viaProject].sort((a, b) => a.id.localeCompare(b.id)));
    expect(res.json.items.find((a: Item) => a.id === pre.id)).toMatchObject({
      kind: "pre_sales",
      company: { id: company.id, name: "Acme SA" },
      deal: { id: deal.id, title: "Grid analytics" },
      project: null,
    });
    expect(res.json.items.find((a: Item) => a.id === op.id)).toMatchObject({
      kind: "operational",
      project: { id: project.id, name: "Smart meter rollout" },
      company: null,
    });
  });

  it("asks each host once, with the caller's own token and only the ids that live there", async () => {
    const company = makeCompany();
    const project = makeProject();
    const pre = await noteOn(company.id, "A note");
    const op = await taskOn(project.id, "A task");
    hosts.crm.resolves.length = 0;
    hosts.projects.resolves.length = 0;

    expect((await byIds([pre.id, op.id], "bob")).status).toBe(200);

    const bob = await bearerOf("bob");
    expect(hosts.crm.resolves).toHaveLength(1);
    expect(hosts.crm.resolves[0]).toMatchObject({ authorization: bob, body: { entityType: "company", ids: [company.id] } });
    expect(hosts.projects.resolves).toHaveLength(1);
    expect(hosts.projects.resolves[0]).toMatchObject({ authorization: bob, body: { entityType: "project", ids: [project.id] } });
  });

  it("a call whose ids all live in one host does not ask the other", async () => {
    const company = makeCompany();
    const pre = await noteOn(company.id, "A note");
    hosts.projects.resolves.length = 0;
    // The other host being down is nothing to this lookup.
    hosts.projects.mode = { status: 503 };

    const res = await byIds([pre.id]);

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(hosts.projects.resolves).toHaveLength(0);
  });

  it("the view's `may` is the caller's, not the author's (design G4)", async () => {
    const project = makeProject();
    const op = await taskOn(project.id, "A task");
    const asManager = await byIds([op.id], "manager");
    const asViewer = await byIds([op.id], "viewer");
    expect(asManager.json.items[0].may).toMatchObject({ edit: true, delete: true });
    expect(asViewer.json.items[0].may).toMatchObject({ edit: false, delete: false });
  });

  it("lists them newest first like every other list, whatever the order of the ids", async () => {
    const company = makeCompany();
    const old = await rawActivity("crm", company.id, "Old", new Date("2026-01-01T00:00:00Z"));
    const mid = await rawActivity("crm", company.id, "Mid", new Date("2026-06-01T00:00:00Z"));
    const recent = await rawActivity("crm", company.id, "Recent", new Date("2026-11-01T00:00:00Z"));

    const res = await byIds([mid.id, old.id, recent.id]);

    expect(res.json.items.map((a: Item) => a.subject)).toEqual(["Recent", "Mid", "Old"]);
  });

  it("an id given twice is one activity", async () => {
    const company = makeCompany();
    const note = await noteOn(company.id, "A note");
    const res = await byIds([note.id, note.id]);
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.total).toBe(1);
  });

  it("can be narrowed by `type`, which every list accepts", async () => {
    const company = makeCompany();
    const note = await noteOn(company.id, "A note");
    const task = (await call("POST", "/activities", { as: "consultant", body: { type: "task", subject: "A task", companyId: company.id } })).json as Item;
    const res = await call("GET", `/activities?ids=${note.id},${task.id}&type=task`, { as: "bob" });
    expect(res.json.items.map((a: Item) => a.id)).toEqual([task.id]);
  });
});

describe("what is omitted, and that it cannot be told apart (AC-2.9, AC-4.10)", () => {
  it("an id that never existed, one whose entity the host no longer knows and one the caller may not read are all omitted", async () => {
    const company = makeCompany();
    const kept = await noteOn(company.id, "Kept");
    // A company the CRM has since lost: the activity is still in the table, the host says `missing`.
    const orphan = await rawActivity("crm", "co-gone", "About a lost company");
    // A project of the second host, read by a caller who has no access to Projects at all.
    const project = makeProject();
    const hidden = await taskOn(project.id, "Hidden from bob");
    hosts.projects.setReader("user-bob", false);

    const never = await byIds([kept.id, "act-never-existed"]);
    const lost = await byIds([kept.id, orphan.id]);
    const unreadable = await byIds([kept.id, hidden.id]);

    for (const res of [never, lost, unreadable]) {
      expect(res.status).toBe(200);
      expect(res.json.items.map((a: Item) => a.id)).toEqual([kept.id]);
    }
    // Not a status, a header-free body or a count apart: the three answers are one answer.
    expect(lost.json).toEqual(never.json);
    expect(unreadable.json).toEqual(never.json);
  });

  it("when nothing is left the answer is the same empty page whichever way it came about", async () => {
    const company = makeCompany();
    const orphan = await rawActivity("crm", "co-gone", "About a lost company");
    const note = await noteOn(company.id, "Not for the outsider");

    const never = await byIds(["act-never-existed"]);
    const lost = await byIds([orphan.id]);
    // `outsider` reads neither host: every id is theirs to not see.
    const outsider = await byIds([note.id], "outsider");

    for (const res of [never, lost, outsider]) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    }
  });

  it("a caller who reads one host and not the other gets the activities of the first, not a refusal", async () => {
    const company = makeCompany();
    const project = makeProject();
    const pre = await noteOn(company.id, "In the CRM");
    const op = await taskOn(project.id, "In Projects");
    hosts.crm.setReader("user-bob", false);

    const res = await byIds([pre.id, op.id]);

    expect(res.status).toBe(200);
    expect(res.json.items.map((a: Item) => a.id)).toEqual([op.id]);
    expect(res.json.total).toBe(1);
  });

  it("the caller's own host answer decides: another caller reads what this one cannot", async () => {
    const company = makeCompany();
    const note = await noteOn(company.id, "A note");
    hosts.crm.setReader("user-bob", false);
    expect((await byIds([note.id], "bob")).json.items).toEqual([]);
    expect((await byIds([note.id], "colleague")).json.items).toHaveLength(1);
  });

  it("an activity whose deal the host no longer lists is still returned, with the deal's id and no title", async () => {
    const company = makeCompany();
    const row = await db.activity.create({
      data: {
        kind: "pre_sales",
        type: "note",
        hostApp: "crm",
        hostType: "company",
        hostId: company.id,
        dealId: "dl-unlisted",
        subject: "About a deal",
        occurredAt: new Date(),
        authorUserId: "user-consultant",
      },
    });
    const res = await byIds([row.id]);
    expect(res.json.items[0].deal).toEqual({ id: "dl-unlisted", title: null });
  });
});

describe("the filter's limits", () => {
  it("accepts 50 ids and refuses 51", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `act-${i}`);
    expect((await byIds(fifty)).status).toBe(200);
    const refused = await byIds([...fifty, "act-50"]);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ field: "ids" });
  });

  it("counts what was sent, not what is distinct: 51 copies of one id are refused too", async () => {
    expect((await byIds(Array.from({ length: 51 }, () => "act-1"))).status).toBe(422);
  });

  it("is exactly one of five filters: `ids` next to any other is a 422", async () => {
    for (const other of ["companyId=c", "contactId=c", "dealId=d", "projectId=p"]) {
      const res = await call("GET", `/activities?ids=a,b&${other}`, { as: "bob" });
      expect(res.status).toBe(422);
    }
    expect((await call("GET", "/activities", { as: "bob" })).status).toBe(422);
  });

  it("refuses an empty element, an id of 65 characters and a NUL, naming the field", async () => {
    for (const ids of ["a,,b", "a,b,", ",a", "x".repeat(65), "a%00b"]) {
      const res = await call("GET", `/activities?ids=${ids}`, { as: "bob" });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ field: "ids" });
    }
  });

  it("takes one comma-separated `ids`, not the parameter repeated (a second one would be silently dropped otherwise)", async () => {
    const company = makeCompany();
    const a = await noteOn(company.id, "A");
    const b = await noteOn(company.id, "B");
    const repeated = await call("GET", `/activities?ids=${a.id}&ids=${b.id}`, { as: "bob" });
    expect(repeated.status).toBe(422);
    expect(repeated.json).toMatchObject({ field: "ids" });
  });

  it("an `ids` left empty is no filter at all, as an empty `companyId` always was", async () => {
    expect((await call("GET", "/activities?ids=", { as: "bob" })).status).toBe(422);
    const company = makeCompany();
    expect((await call("GET", `/activities?ids=&companyId=${company.id}`, { as: "bob" })).status).toBe(200);
  });

  it("needs a token", async () => {
    expect((await byIds(["a"], null)).status).toBe(401);
  });
});

describe("the whole answer, in one page", () => {
  it("returns all 50 matches when 50 are asked for, without a pageSize (the default of 25 must not cut them)", async () => {
    const projects = Array.from({ length: 50 }, (_, i) => makeProject(`Project ${i}`));
    const rows = await Promise.all(projects.map((p, i) => rawActivity("projects", p.id, `Task ${i}`, new Date(2026, 0, 1 + i))));
    hosts.projects.resolves.length = 0;

    const res = await byIds(rows.map((r) => r.id));

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(50);
    expect(res.json.total).toBe(50);
    expect(res.json).toMatchObject({ page: 1, pageSize: 50 });
    // 50 projects are two resolve calls of the host's 25.
    expect(hosts.projects.resolves.map((r) => r.body.ids.length)).toEqual([RESOLVE_BATCH_SIZE, RESOLVE_BATCH_SIZE]);
  });

  it("ignores page and pageSize: a caller who sends them still gets every readable match, and the page says so", async () => {
    const company = makeCompany();
    const rows = await Promise.all(Array.from({ length: 30 }, (_, i) => rawActivity("crm", company.id, `Note ${i}`, new Date(2026, 0, 1 + i))));

    const res = await call("GET", `/activities?ids=${rows.map((r) => r.id).join(",")}&page=2&pageSize=5`, { as: "bob" });

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(30);
    expect(res.json).toMatchObject({ total: 30, page: 1, pageSize: 50 });
  });
});

describe("a host that cannot answer (AC-8.2 as today)", () => {
  it("is a 503 `host_unavailable`, and nothing partial, whichever host it is", async () => {
    const company = makeCompany();
    const project = makeProject();
    const pre = await noteOn(company.id, "In the CRM");
    const op = await taskOn(project.id, "In Projects");

    hosts.crm.mode = { status: 503 };
    const crmDown = await byIds([pre.id, op.id]);
    hosts.crm.mode = {};
    hosts.projects.mode = { malformed: true };
    const projectsDown = await byIds([pre.id, op.id]);

    for (const res of [crmDown, projectsDown]) {
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "host_unavailable" });
      expect(res.json.items).toBeUndefined();
    }
  });

  it("a host that says 'not a reader' does not hide another host that cannot answer: the lookup is refused", async () => {
    const company = makeCompany();
    const project = makeProject();
    const pre = await noteOn(company.id, "In the CRM");
    const op = await taskOn(project.id, "In Projects");
    hosts.crm.setReader("user-bob", false);
    hosts.projects.mode = { status: 500 };

    const res = await byIds([pre.id, op.id]);

    expect(res.status).toBe(503);
  });
});
