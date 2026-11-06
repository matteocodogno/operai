/**
 * The referent on a purchase order (specs/022 T26; AC-3.6, AC-3.7, AC-3.8, S6; T18 M1, M3, M5, L1, L6, L7):
 * the picker `GET /projects/:id/purchase-order/contacts`, the edit `PATCH /projects/:id/purchase-order`, and
 * the referent in the echoes. The live read on `GET /projects/:id` is tested with the project page
 * (src/projects/projects.test.ts). Runs the ASSEMBLED app against the `*_test` database; auth and the CRM are
 * the fakes of test-support/world.ts. Every contact is synthetic (T18 L2).
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { call, crm, db, makeContact, makeDeal, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [
    { id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false },
    { id: "co-zeta", name: "Zeta AG", entity: "welld_it", archived: false },
  ];
  crm.deals = [makeDeal({ id: "deal-seed", title: "Website" })];
});

/** A project made from a deal of Acme in wellD CH, whose purchase order names `referentContactId` (default none). */
const fixture = (referentContactId: string | null = null, project: Parameters<typeof seedDealProject>[0] = {}) =>
  seedDealProject({ ...project, order: { ...project.order, referentContactId } });

/** A hand-made project (no purchase order, ever), of Acme. */
const handMade = () =>
  db.project.create({
    data: { name: "By hand", type: "t_and_m", entity: "welld_ch", companyId: "co-acme", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });

const referentIdOf = async (orderId: string) => (await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).referentContactId;

// ─── The picker ──────────────────────────────────────────────────────────────

describe("GET /projects/:id/purchase-order/contacts — the project company's contacts (AC-3.6, T18 M1)", () => {
  const contactsOf = (projectId: string, as: PersonaName | null = "pmCh") => call("GET", `/projects/${projectId}/purchase-order/contacts`, { as });

  it("lists the PROJECT company's non-archived contacts as { id, name, jobTitle }: no email, phone, company or archived flag", async () => {
    crm.contacts = [
      makeContact({ id: "c-b", firstName: "Bea", lastName: "Baker", jobTitle: "CFO" }),
      makeContact({ id: "c-a", firstName: "Abe", lastName: "Adams", jobTitle: null }),
      makeContact({ id: "c-old", firstName: "Old", lastName: "Archived", archived: true }),
      makeContact({ id: "c-zeta", companyId: "co-zeta", firstName: "Zed", lastName: "Other" }),
      makeContact({ id: "c-none", companyId: null, firstName: "Nora", lastName: "Nobody" }),
    ];
    const { project } = await fixture();
    const res = await contactsOf(project.id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: "c-a", name: "Abe Adams", jobTitle: null },
        { id: "c-b", name: "Bea Baker", jobTitle: "CFO" },
      ],
    });
    // The company is the project's, asked of the CRM in its `companyId` mode: never `ids`, never a bulk export.
    expect(crm.contactCalls).toBe(1);
    expect(crm.lastContactsQuery).toBe("?companyId=co-acme");
  });

  it("never takes the company from the request: a company id in the query is ignored", async () => {
    crm.contacts = [makeContact({ id: "c-zeta", companyId: "co-zeta" })];
    const { project } = await fixture();
    const res = await call("GET", `/projects/${project.id}/purchase-order/contacts?companyId=co-zeta`, { as: "pmCh" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [] });
    expect(crm.lastContactsQuery).toBe("?companyId=co-acme");
  });

  it("is `no-store`: a contact list is personal data and is never kept (T18 M5)", async () => {
    const { project } = await fixture();
    expect((await contactsOf(project.id)).headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    { persona: "pmCh", status: 200 },
    { persona: "salesCh", status: 200 },
    { persona: "opsCh", status: 200 },
    { persona: "admin", status: 200 },
  ] as const)("is open to $persona, who manages wellD CH projects: $status", async ({ persona, status }) => {
    const { project } = await fixture();
    expect((await contactsOf(project.id, persona)).status).toBe(status);
  });

  it.each(["viewer", "colleague", "accounting"] as const)("refuses %s, who manages nothing: 403 forbidden, no CRM call", async (persona) => {
    const { project } = await fixture();
    const res = await contactsOf(project.id, persona);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect(crm.contactCalls).toBe(0);
  });

  it("refuses a manager of the other entity: 403 out_of_scope, no CRM call", async () => {
    const { project } = await fixture();
    for (const persona of ["salesIt"] as const) {
      const res = await contactsOf(project.id, persona);
      expect({ persona, status: res.status }).toEqual({ persona, status: 403 });
      expect(res.json).toMatchObject({ code: "out_of_scope" });
    }
    expect(crm.contactCalls).toBe(0);
  });

  it("lets the other entity's manager read a project of THEIR entity, and an admin either", async () => {
    const it = await fixture(null, { project: { entity: "welld_it", companyId: "co-zeta", name: "IT" }, order: { dealId: "deal-it" } });
    expect((await contactsOf(it.project.id, "salesIt")).status).toBe(200);
    expect((await contactsOf(it.project.id, "admin")).status).toBe(200);
    expect((await contactsOf(it.project.id, "pmCh")).status).toBe(403);
  });

  it("answers 404 for an unknown project and 404 `purchase_order_not_found` for a hand-made one", async () => {
    const unknown = await contactsOf("no-such-project");
    expect(unknown.status).toBe(404);
    const project = await handMade();
    const res = await contactsOf(project.id);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "purchase_order_not_found" });
    expect(crm.contactCalls).toBe(0);
  });

  it("answers 503 `crm_unavailable` when the CRM cannot answer: never an empty picker", async () => {
    const { project } = await fixture();
    crm.contactsDown = true;
    const res = await contactsOf(project.id);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "crm_unavailable" });
  });

  it("reads the CRM again at every call: nothing is cached", async () => {
    const { project } = await fixture();
    expect((await contactsOf(project.id)).json.items).toEqual([]);
    crm.contacts = [makeContact({ id: "c-new", firstName: "New", lastName: "Joiner" })];
    expect((await contactsOf(project.id)).json.items).toEqual([{ id: "c-new", name: "New Joiner", jobTitle: "Purchasing lead" }]);
    expect(crm.contactCalls).toBe(2);
  });
});

// ─── The edit ────────────────────────────────────────────────────────────────

describe("PATCH /projects/:id/purchase-order — set, change or clear the referent (AC-3.6, AC-3.7)", () => {
  /** `ifMatch: null` sends no If-Match header at all (an omitted argument would take the default, version 1). */
  const patch = (projectId: string, body: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string | null = 1) =>
    call("PATCH", `/projects/${projectId}/purchase-order`, { as, body, ...(ifMatch === null ? {} : { ifMatch }) });

  beforeEach(() => {
    crm.contacts = [
      makeContact({ id: "c-1", firstName: "Rita", lastName: "Referent", email: "rita@example.test" }),
      makeContact({ id: "c-2", firstName: "Sam", lastName: "Second" }),
    ];
  });

  it("sets it: 200 with the PurchaseOrder and its live referent, a new ETag and version, `no-store`; only the id is stored", async () => {
    const { project, order } = await fixture();
    const res = await patch(project.id, { referentContactId: "c-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({
      id: order.id,
      deal: { id: "deal-seed", title: "Website", won: true },
      estimate: null,
      bexioOrderId: null,
      referent: { id: "c-1", status: "ok", name: "Rita Referent", jobTitle: "Purchasing lead", email: "rita@example.test", phone: "+41 00 000 00 00" },
      opsManager: { id: "user-ops", name: "Name of user-ops", deleted: false },
      version: 2,
    });
    const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.referentContactId).toBe("c-1");
    expect(JSON.stringify(row)).not.toMatch(/Rita|rita@example|Purchasing lead/);
  });

  it("shows on the project page at the next read", async () => {
    const { project } = await fixture();
    await patch(project.id, { referentContactId: "c-1" });
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(page.json.purchaseOrder.referent).toMatchObject({ id: "c-1", status: "ok", name: "Rita Referent" });
  });

  it("changes it to another contact, and clears it with null — each a new version (AC-3.7)", async () => {
    const { project, order } = await fixture("c-1");
    const changed = await patch(project.id, { referentContactId: "c-2" });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ version: 2, referent: { id: "c-2", name: "Sam Second" } });
    expect(await referentIdOf(order.id)).toBe("c-2");

    const cleared = await patch(project.id, { referentContactId: null }, "pmCh", 2);
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ version: 3, referent: null });
    expect(await referentIdOf(order.id)).toBeNull();
  });

  it("clears without asking the CRM: it works while the CRM is down, and makes no contacts call", async () => {
    const { project, order } = await fixture("c-1");
    crm.down = true;
    const res = await patch(project.id, { referentContactId: null });
    expect(res.status).toBe(200);
    expect(res.json.referent).toBeNull();
    expect(crm.contactCalls).toBe(0);
    expect(await referentIdOf(order.id)).toBeNull();
  });

  it("leaves the project, its terms and the Bexio order id alone", async () => {
    const { project, terms, order } = await fixture(null, { order: { bexioOrderId: "AB-1" } });
    await patch(project.id, { referentContactId: "c-1" });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ version: 1 });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).toMatchObject({ version: 1 });
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ bexioOrderId: "AB-1", version: 2 });
  });

  describe("who may (AC-3.7)", () => {
    it.each(["pmCh", "salesCh", "opsCh", "admin"] as const)("%s, who manages wellD CH projects, may set it on a wellD CH project", async (persona) => {
      const { project, order } = await fixture();
      const res = await patch(project.id, { referentContactId: "c-1" }, persona);
      expect({ persona, status: res.status }).toEqual({ persona, status: 200 });
      expect(await referentIdOf(order.id)).toBe("c-1");
    });

    it.each(["viewer", "colleague", "accounting", "outsider"] as const)("%s is refused 403 and nothing changes", async (persona) => {
      const { project, order } = await fixture("c-2");
      const res = await patch(project.id, { referentContactId: "c-1" }, persona);
      expect({ persona, status: res.status }).toEqual({ persona, status: 403 });
      expect(await referentIdOf(order.id)).toBe("c-2");
      expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ version: 1 });
    });

    it("refuses a manager of the other entity: 403 out_of_scope, nothing changes and the CRM is not asked", async () => {
      const { project, order } = await fixture("c-2");
      for (const persona of ["salesIt"] as const) {
        const res = await patch(project.id, { referentContactId: "c-1" }, persona);
        expect({ persona, status: res.status }).toEqual({ persona, status: 403 });
        expect(res.json).toMatchObject({ code: "out_of_scope" });
      }
      expect(await referentIdOf(order.id)).toBe("c-2");
      expect(crm.contactCalls).toBe(0);
    });

    it("answers 401 without a token", async () => {
      const { project } = await fixture();
      expect((await patch(project.id, { referentContactId: "c-1" }, null)).status).toBe(401);
    });
  });

  describe("an invalid contact: 422 `referent_invalid`, one identical body, nothing stored (AC-3.6, T18 M3, L1)", () => {
    const cases: { what: string; setup: () => void; id: string }[] = [
      { what: "an unknown contact", setup: () => undefined, id: "c-nobody" },
      { what: "a contact of another company", setup: () => crm.contacts.push(makeContact({ id: "c-zeta", companyId: "co-zeta" })), id: "c-zeta" },
      { what: "a contact with no company", setup: () => crm.contacts.push(makeContact({ id: "c-none", companyId: null })), id: "c-none" },
      { what: "an archived contact", setup: () => crm.contacts.push(makeContact({ id: "c-arch", archived: true })), id: "c-arch" },
      { what: "an id that is not shaped like one", setup: () => undefined, id: "c-1,c-2" },
    ];

    it.each(cases)("refuses $what", async ({ setup, id }) => {
      setup();
      const { project, order } = await fixture("c-2");
      const res = await patch(project.id, { referentContactId: id });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ status: 422, code: "referent_invalid" });
      expect(await referentIdOf(order.id)).toBe("c-2");
      expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ version: 1 });
    });

    it("gives every reason the same body, and never echoes the id, a name or a company", async () => {
      const { project } = await fixture();
      const bodies: string[] = [];
      for (const { setup, id } of cases) {
        setup();
        const res = await patch(project.id, { referentContactId: id });
        expect(res.status).toBe(422);
        bodies.push(JSON.stringify(res.json));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toMatch(/c-zeta|c-none|c-arch|c-nobody|co-zeta|co-acme|Acme|Zeta/);
    });

    it("checks against the PROJECT's company, live: a contact the CRM has since moved to another company is refused", async () => {
      // c-1 is Acme's now; the project is Acme's, so it is valid ...
      const { project } = await fixture();
      expect((await patch(project.id, { referentContactId: "c-1" })).status).toBe(200);
      // ... and once the CRM moves it to another company it is not.
      crm.contacts.find((contact) => contact.id === "c-1")!.companyId = "co-zeta";
      const res = await patch(project.id, { referentContactId: "c-1" }, "pmCh", 2);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "referent_invalid" });
    });
  });

  it("answers 503 `crm_unavailable` when the CRM cannot answer, and stores nothing", async () => {
    const { project, order } = await fixture("c-2");
    crm.contactsDown = true;
    const res = await patch(project.id, { referentContactId: "c-1" });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "crm_unavailable" });
    expect(await referentIdOf(order.id)).toBe("c-2");
  });

  it("answers 428 without If-Match, and 409 `version_conflict` with the current version for a stale one", async () => {
    const { project, order } = await fixture();
    const missing = await patch(project.id, { referentContactId: "c-1" }, "pmCh", null);
    expect(missing.status).toBe(428);
    expect(missing.json).toMatchObject({ code: "precondition_required" });
    expect((await patch(project.id, { referentContactId: "c-1" }, "pmCh", 'W/"1"')).status).toBe(428);

    expect((await patch(project.id, { referentContactId: "c-1" })).status).toBe(200);
    const stale = await patch(project.id, { referentContactId: "c-2" }, "pmCh", 1);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect(await referentIdOf(order.id)).toBe("c-1");
  });

  it("lets only one of two saves of the same version win (compare-and-set)", async () => {
    const { project, order } = await fixture();
    const [first, second] = await Promise.all([
      patch(project.id, { referentContactId: "c-1" }),
      patch(project.id, { referentContactId: "c-2" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ version: 2 });
  });

  it("answers 404 for an unknown project and 404 `purchase_order_not_found` for a hand-made one", async () => {
    expect((await patch("no-such-project", { referentContactId: null })).status).toBe(404);
    const project = await handMade();
    const res = await patch(project.id, { referentContactId: "c-1" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "purchase_order_not_found" });
    expect(crm.contactCalls).toBe(0);
  });

  it.each([
    { what: "no referentContactId member", body: {} },
    { what: "a number", body: { referentContactId: 42 } },
    { what: "an empty id", body: { referentContactId: "" } },
    { what: "an id of 65 characters", body: { referentContactId: "x".repeat(65) } },
    { what: "an unknown member", body: { referentContactId: "c-1", bexioOrderId: "AB-1" } },
  ])("refuses $what: 400, unchanged", async ({ body }) => {
    const { project, order } = await fixture("c-2");
    const res = await patch(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect(await referentIdOf(order.id)).toBe("c-2");
  });

  describe("one structured log line per set or clear: kind, project id, actor id — no contact data (T18 L6)", () => {
    /** The console's log and error lines while `run` runs. */
    async function logged(run: () => Promise<unknown>): Promise<string[]> {
      const lines: string[] = [];
      const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")].map((spy) => spy.mockImplementation(record));
      try {
        await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return lines;
    }

    it("logs a set, a change and a clear, one line each, with the kind, the project and the actor", async () => {
      const { project } = await fixture();
      const lines = await logged(async () => {
        await patch(project.id, { referentContactId: "c-1" }, "pmCh", 1);
        await patch(project.id, { referentContactId: "c-2" }, "salesCh", 2);
        await patch(project.id, { referentContactId: null }, "admin", 3);
      });
      const audit = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(audit).toEqual([
        { event: "referent.set", projectId: project.id, actorId: "user-pm-ch" },
        { event: "referent.set", projectId: project.id, actorId: "user-sales-ch" },
        { event: "referent.cleared", projectId: project.id, actorId: "user-admin" },
      ]);
      for (const line of lines) expect(line).not.toMatch(/Rita|Referent|rita@example|Sam|Second|c-1|c-2|Purchasing lead/);
    });

    it("logs nothing for a refused write", async () => {
      const { project } = await fixture();
      const lines = await logged(async () => {
        await patch(project.id, { referentContactId: "c-nobody" });
        await patch(project.id, { referentContactId: "c-1" }, "viewer");
        await patch(project.id, { referentContactId: "c-1" }, "pmCh", 9);
      });
      expect(lines.filter((line) => line.includes("referent."))).toEqual([]);
    });
  });
});

describe("the API document", () => {
  it("describes the referent routes (they are mounted under the projects router, not in index.ts)", async () => {
    const doc = (await call("GET", "/openapi.json", { as: null })).json;
    expect(Object.keys(doc.paths["/projects/{id}/purchase-order/contacts"])).toEqual(["get"]);
    expect(Object.keys(doc.paths["/projects/{id}/purchase-order"])).toEqual(["patch"]);
    expect(doc.paths["/projects/{id}/purchase-order"].patch.responses["422"].description).toContain("referent_invalid");
  });
});

// ─── The other answers that carry the order ──────────────────────────────────

describe("the Bexio echo carries the live referent, `no-store` (T26, T18 M5)", () => {
  it("shows the referent on the PurchaseOrder the Bexio route answers with", async () => {
    crm.contacts = [makeContact({ id: "c-1", firstName: "Rita", lastName: "Referent" })];
    const { project } = await fixture("c-1");
    const res = await call("PUT", `/projects/${project.id}/purchase-order/bexio-order`, {
      as: "accounting",
      body: { bexioOrderId: "AB-1" },
      ifMatch: 1,
    });
    expect(res.status).toBe(200);
    expect(res.json.referent).toMatchObject({ id: "c-1", status: "ok", name: "Rita Referent" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("every answer that carries a Project is `no-store` (T26, T18 M5)", () => {
  it("is so on the rename, which answers with the project and its live referent", async () => {
    crm.contacts = [makeContact({ id: "c-1", firstName: "Rita", lastName: "Referent" })];
    const { project } = await fixture("c-1", { project: { projectManagerId: "user-pm-ch" } });
    const res = await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { name: "Renamed" }, ifMatch: 1 });
    expect(res.status).toBe(200);
    expect(res.json.purchaseOrder.referent).toMatchObject({ id: "c-1", status: "ok", name: "Rita Referent" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
