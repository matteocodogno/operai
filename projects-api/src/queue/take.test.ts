/**
 * Taking a deal from the to-start queue (specs/022 T7 as reshaped by T23; AC-1.2 – AC-1.6, AC-1.8,
 * AC-1.10, AC-3.1, AC-3.2, AC-3.5): `POST /queue/{dealId}/project` makes a new project with its terms
 * and its purchase order, with no project manager. Runs the ASSEMBLED app against the `*_test`
 * database; the CRM and EstimAI are the fakes of test-support/world.ts.
 *
 * Every refusal asserts that NOTHING was written: no project, no terms, no purchase order (the take is
 * one transaction), and that the deal is still in the queue where it was. T24 adds the gates
 * (`handoff:take` and `project:manage` for the deal's entity), the ops-manager check against auth's
 * live holders, the referent check against the deal company's CRM contacts and the audit line; T25 adds
 * the push to the ops-manager (AC-4.3), which a notify-api failure never turns into a failed take (AC-4.4).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "../lib/env";
import { createNotifier, resetNotifierForTests, setNotifierForTests, type NotifyEvent } from "../lib/notify";
import { serviceTokens } from "../lib/serviceToken";
import { bearerFor, call, crm, db, estimai, holders, makeContact, makeDeal, resetWorld, seedDealProject, SERVICE_JWT, type PersonaName } from "../test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [
    { id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false },
    { id: "co-zeta", name: "Zeta AG", entity: "welld_it", archived: false },
  ];
});

/** The `terms` member of a take, specs/021's contract shape: `{ startDate, endDate?, terms }` (specs/022 AC-1.8). */
const start = { startDate: "2026-12-01" };
const TERMS = {
  fixed_price: { ...start, terms: { deadline: "2027-03-31", maxEffortManDays: 55.5 } },
  fixed_price_with_man_days: { ...start, terms: { deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 } },
  maintenance: { ...start, terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null } },
  saas: { ...start, endDate: "2027-11-30" },
  t_and_m: { ...start, terms: { positions: [{ profile: "Senior developer", plannedManDays: 120 }] } },
} as const;

/** A take body: a T&M project by default, the ops-manager asked for, no referent. */
const body = (over: Record<string, unknown> = {}) => ({
  name: "Portal 2027",
  type: "t_and_m",
  terms: TERMS.t_and_m,
  opsManagerId: "user-ops",
  ...over,
});

const takeAsProject = (dealId: string, payload: unknown, as: PersonaName | null = "salesCh") =>
  call("POST", `/queue/${dealId}/project`, { as, body: payload });

const counts = async () => ({
  projects: await db.project.count(),
  terms: await db.projectTerms.count(),
  orders: await db.purchaseOrder.count(),
});
const NOTHING = { projects: 0, terms: 0, orders: 0 };
const ONE = { projects: 1, terms: 1, orders: 1 };
const inQueue = async (): Promise<string[]> =>
  (await call("GET", "/queue", { as: "salesCh" })).json.items.map((item: { dealId: string }) => item.dealId);

// ─── A new project from a deal ───────────────────────────────────────────────

describe("POST /queue/:dealId/project — a new project from a won deal (AC-1.2, AC-1.3, AC-1.8)", () => {
  it("creates a planned project with the deal's company and entity and NO project manager, its terms and its purchase order", async () => {
    crm.deals = [makeDeal({ id: "d-1", title: "Portal rebuild", estimate: { id: "est-1", name: "Portal estimate" } })];
    crm.contacts = [makeContact({ id: "contact-1", companyId: "co-acme" })];
    const res = await takeAsProject("d-1", body({ referentContactId: "contact-1" }));

    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toMatchObject({
      name: "Portal 2027",
      type: "t_and_m",
      state: "planned",
      entity: "welld_ch",
      company: { id: "co-acme", name: "Acme SA" },
      projectManager: null,
      awaitingProjectManager: true,
      startDate: "2026-12-01",
      endDate: null,
      version: 1,
      terms: {
        type: "t_and_m",
        startDate: "2026-12-01",
        endDate: null,
        terms: { positions: [{ profile: "Senior developer", plannedManDays: 120 }] },
        version: 1,
      },
      purchaseOrder: {
        id: expect.any(String),
        deal: { id: "d-1", title: "Portal rebuild", won: true },
        estimate: { id: "est-1" },
        bexioOrderId: null,
        // Only the id is stored; the Project view reads the referent's details from the CRM (T26).
        referent: expect.objectContaining({ id: "contact-1", status: "ok" }),
        opsManager: { id: "user-ops", name: "Name of user-ops", deleted: false },
        version: 1,
      },
    });

    const stored = await db.project.findUniqueOrThrow({ where: { id: res.json.id }, include: { terms: true, purchaseOrder: true } });
    // The person who took the deal is not made the project manager (D42).
    expect(stored).toMatchObject({ createdById: "user-sales-ch", projectManagerId: null, companyId: "co-acme", entity: "welld_ch", state: "planned" });
    expect(stored.terms).toMatchObject({ type: "t_and_m" });
    expect(stored.purchaseOrder).toMatchObject({
      dealId: "d-1",
      estimateId: "est-1",
      opsManagerId: "user-ops",
      referentContactId: "contact-1",
      createdById: "user-sales-ch",
      bexioOrderId: null,
    });
    expect(await counts()).toEqual(ONE);
  });

  it("makes the referent optional: `null` and absent both leave none on the purchase order", async () => {
    crm.deals = [makeDeal({ id: "d-1" }), makeDeal({ id: "d-2" })];
    const withNull = await takeAsProject("d-1", body({ referentContactId: null }));
    expect(withNull.status).toBe(201);
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-1" } })).toMatchObject({ opsManagerId: "user-ops", referentContactId: null });
    const without = await takeAsProject("d-2", body());
    expect(without.status).toBe(201);
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-2" } })).toMatchObject({ referentContactId: null });
    // No referent to check: the CRM is not asked for a contact (T26's "only when set" starts here).
    expect(crm.contactCalls).toBe(0);
  });

  it("makes the deal leave the queue (AC-1.3, AC-1.6)", async () => {
    crm.deals = [makeDeal({ id: "d-1" }), makeDeal({ id: "d-2" })];
    expect(await inQueue()).toContain("d-1");
    expect((await takeAsProject("d-1", body())).status).toBe(201);
    expect(await inQueue()).toEqual(["d-2"]);
  });

  it("takes the deal's entity, not the caller's: a wellD IT deal makes a wellD IT project", async () => {
    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    const res = await takeAsProject("d-it", body({ type: "maintenance", terms: TERMS.maintenance, opsManagerId: "user-ops-it" }), "salesIt");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" }, projectManager: null });
  });

  it.each(["t_and_m", "fixed_price", "maintenance", "saas"] as const)("accepts the client type %s, and its terms have that type (D40)", async (type) => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await takeAsProject("d-1", body({ type, terms: TERMS[type] }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ type, company: { id: "co-acme" }, terms: { type } });
    expect(await counts()).toEqual(ONE);
  });

  it("takes a saas deal as a licence project with its company and its licence period, SLA and hours optional (AC-5.1, AC-1.8)", async () => {
    crm.deals = [makeDeal({ id: "d-1", title: "Koordy licence" })];
    const res = await takeAsProject("d-1", body({ type: "saas", terms: TERMS.saas }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      type: "saas",
      company: { id: "co-acme", name: "Acme SA" },
      terms: { type: "saas", startDate: "2026-12-01", endDate: "2027-11-30", terms: { sla: null, hourPackage: null } },
    });
  });

  it("refuses the type internal: a project from a deal has a company and a purchase order", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await takeAsProject("d-1", body({ type: "internal", terms: start }));
    expect(res.status).toBe(400);
    expect(res.json.field).toBe("type");
    expect(await counts()).toEqual(NOTHING);
  });

  it("refuses a project manager in the body: 400, the take makes none (D42), and nothing is written", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await takeAsProject("d-1", body({ projectManagerId: "user-colleague" }));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect(await counts()).toEqual(NOTHING);
    expect(await inQueue()).toEqual(["d-1"]);
  });

  it.each([
    ["the ops-manager", { opsManagerId: undefined }, "opsManagerId"],
    ["a blank ops-manager", { opsManagerId: "" }, "opsManagerId"],
    ["the terms", { terms: undefined }, "terms"],
    ["terms without a start date", { terms: { terms: TERMS.t_and_m.terms } }, "terms.startDate"],
    ["terms with members beside the dates (they go in `terms.terms`)", { terms: { ...start, positions: [] } }, "terms"],
    ["a name", { name: "  " }, "name"],
    ["a referent that is not a string", { referentContactId: 7 }, "referentContactId"],
    ["an entity of the caller's choosing", { entity: "welld_it" }, ""],
    ["a state", { state: "active" }, ""],
  ])("is 400 `validation_failed` for %s", async (_label, over, field) => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await takeAsProject("d-1", body(over));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed", field });
    expect(await counts()).toEqual(NOTHING);
  });

  it("names a body error by its full path in the body (terms.startDate, terms.terms.deadline, terms.endDate)", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const badDate = await takeAsProject("d-1", body({ terms: { ...TERMS.t_and_m, startDate: "01/12/2026" } }));
    expect(badDate.status).toBe(400);
    expect(badDate.json.field).toBe("terms.startDate");

    const noDates = await takeAsProject("d-1", body({ terms: { terms: TERMS.t_and_m.terms } }));
    expect(noDates.status).toBe(400);
    expect(noDates.json.field).toBe("terms.startDate");

    const noDeadline = await takeAsProject("d-1", body({ type: "fixed_price", terms: { ...start, terms: { maxEffortManDays: 10 } } }));
    expect(noDeadline.status).toBe(400);
    expect(noDeadline.json.field).toBe("terms.terms.deadline");

    const noTerms = await takeAsProject("d-1", body({ type: "fixed_price", terms: { ...start } }));
    expect(noTerms.status).toBe(400);
    expect(noTerms.json.field).toBe("terms.terms.deadline");

    const endBeforeStart = await takeAsProject("d-1", body({ terms: { ...TERMS.t_and_m, endDate: "2026-11-01" } }));
    expect(endBeforeStart.status).toBe(400);
    expect(endBeforeStart.json.field).toBe("terms.endDate");

    const notAnObject = await takeAsProject("d-1", body({ terms: "soon" }));
    expect(notAnObject.status).toBe(400);
    expect(notAnObject.json.field).toBe("terms");

    const innerNotAnObject = await takeAsProject("d-1", body({ terms: { ...start, terms: "soon" } }));
    expect(innerNotAnObject.status).toBe(400);
    expect(innerNotAnObject.json.field).toBe("terms.terms");
    expect(await counts()).toEqual(NOTHING);
  });

  it("refuses maintenance terms with neither SLA nor hours, naming terms.terms", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await takeAsProject("d-1", body({ type: "maintenance", terms: { ...start, terms: { sla: null, hourPackage: null } } }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "maintenance_needs_sla_or_hours", field: "terms.terms" });
    expect(await counts()).toEqual(NOTHING);
  });
});

describe("POST /queue/:dealId/project — the man-days come from the estimate (AC-3.1, AC-3.2, AC-3.5)", () => {
  it("copies the estimate's man-days onto fixed price terms, and keeps the estimate id on the purchase order", async () => {
    estimai.estimates.set("est-1", { name: "Portal estimate", manDays: 42.5 });
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "Portal estimate" } })];
    const res = await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    expect(res.status).toBe(201);
    expect(estimai.lastAuthorization).toMatch(/^Bearer /);
    expect(res.json.terms.terms).toEqual({ estimatedManDays: 42.5, deadline: "2027-03-31", maxEffortManDays: 55.5 });
    expect(res.json.purchaseOrder.estimate).toEqual({ id: "est-1" });
    const stored = await db.projectTerms.findFirstOrThrow({ where: { project: { purchaseOrder: { dealId: "d-1" } } } });
    expect(stored.estimatedManDays?.toNumber()).toBe(42.5);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-1" } })).estimateId).toBe("est-1");
  });

  it("is a snapshot: a later change to the estimate does not change the terms (A6)", async () => {
    estimai.estimates.set("est-1", { name: "Portal estimate", manDays: 42.5 });
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "Portal estimate" } })];
    await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    estimai.estimates.set("est-1", { name: "Portal estimate", manDays: 99 });
    const stored = await db.projectTerms.findFirstOrThrow({ where: { project: { purchaseOrder: { dealId: "d-1" } } } });
    expect(stored.estimatedManDays?.toNumber()).toBe(42.5);
  });

  it.each([{ estimatedManDays: 40 }, { estimatedManDays: null }])(
    "refuses sending terms.terms.estimatedManDays (%o) for a deal with an estimate: 422 estimated_man_days_from_estimate, nothing written",
    async (extra) => {
      estimai.estimates.set("est-1", { name: "E", manDays: 42.5 });
      crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "E" } })];
      const res = await takeAsProject("d-1", body({ type: "fixed_price", terms: { ...start, terms: { ...TERMS.fixed_price.terms, ...extra } } }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "estimated_man_days_from_estimate", field: "terms.terms.estimatedManDays" });
      expect(await counts()).toEqual(NOTHING);
      expect(estimai.calls).toBe(0);
    },
  );

  it("keeps `estimatedManDays: null` and the estimate id when EstimAI does not know the estimate", async () => {
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-gone", name: "Gone" } })];
    const res = await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    expect(res.status).toBe(201);
    expect(res.json.terms.terms.estimatedManDays).toBeNull();
    expect(res.json.purchaseOrder.estimate).toEqual({ id: "est-gone" });
  });

  it("answers 503 estimai_unavailable and writes nothing when EstimAI is down", async () => {
    estimai.down = true;
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "E" } })];
    const res = await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("estimai_unavailable");
    expect(await counts()).toEqual(NOTHING);
    expect(await inQueue()).toEqual(["d-1"]);
  });

  it("does not ask EstimAI for a type that has no man-days: a down EstimAI does not stop a T&M take", async () => {
    estimai.down = true;
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "E" } })];
    const res = await takeAsProject("d-1", body());
    expect(res.status).toBe(201);
    expect(estimai.calls).toBe(0);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-1" } })).estimateId).toBe("est-1");
  });

  it("takes the man-days as typed when the deal has no estimate, or leaves them empty (AC-3.5)", async () => {
    crm.deals = [makeDeal({ id: "d-1" }), makeDeal({ id: "d-2" })];
    const typed = await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price_with_man_days }));
    expect(typed.status).toBe(201);
    expect(typed.json.terms.terms.estimatedManDays).toBe(40);
    expect(typed.json.purchaseOrder.estimate).toBeNull();
    expect(estimai.calls).toBe(0);
    const empty = await takeAsProject("d-2", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    expect(empty.status).toBe(201);
    expect(empty.json.terms.terms.estimatedManDays).toBeNull();
  });

  it("keeps the man-days server-owned afterwards: the terms edit refuses them (AC-3.1)", async () => {
    estimai.estimates.set("est-1", { name: "E", manDays: 42.5 });
    crm.deals = [makeDeal({ id: "d-1", estimate: { id: "est-1", name: "E" } })];
    const created = await takeAsProject("d-1", body({ type: "fixed_price", terms: TERMS.fixed_price }));
    const res = await call("PATCH", `/projects/${created.json.id}/terms`, {
      as: "pmCh",
      body: { terms: { deadline: "2027-04-30", maxEffortManDays: 60, estimatedManDays: 1 } },
      ifMatch: 1,
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("estimated_man_days_from_estimate");
  });
});

describe("POST /queue/:dealId/project — refusals leave nothing behind (AC-1.6)", () => {
  it("404 deal_not_found for a deal the CRM does not know", async () => {
    const res = await takeAsProject("d-nope", body());
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("deal_not_found");
    expect(await counts()).toEqual(NOTHING);
  });

  it("409 deal_not_won for a deal that is not won in the CRM now", async () => {
    crm.deals = [makeDeal({ id: "d-1", stage: "negotiation" })];
    const res = await takeAsProject("d-1", body());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("deal_not_won");
    expect(await counts()).toEqual(NOTHING);
  });

  it("409 deal_taken for a deal that already has a purchase order, and the first project is untouched", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    expect((await takeAsProject("d-1", body())).status).toBe(201);
    const second = await takeAsProject("d-1", body({ name: "Second" }));
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("deal_taken");
    expect(await counts()).toEqual(ONE);
  });

  it("409 deal_taken for a deal taken by a project made another way, whatever its state", async () => {
    crm.deals = [makeDeal({ id: "d-seed" })];
    await seedDealProject({ order: { dealId: "d-seed" }, project: { state: "closed" } });
    const res = await takeAsProject("d-seed", body());
    expect([res.status, res.json.code]).toEqual([409, "deal_taken"]);
    expect(await counts()).toEqual(ONE);
  });

  it("409 deal_taken for a taken deal even when it was reopened in the CRM since", async () => {
    const deal = makeDeal({ id: "d-1" });
    crm.deals = [deal];
    await takeAsProject("d-1", body());
    deal.stage = "negotiation";
    const res = await takeAsProject("d-1", body());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("deal_taken");
    expect(await counts()).toEqual(ONE);
  });

  it("two concurrent takes of one deal make exactly one project: one 201, one 409 deal_taken, nothing half-written", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const [a, b] = await Promise.all([takeAsProject("d-1", body()), takeAsProject("d-1", body({ name: "Other" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.code).toBe("deal_taken");
    expect(await counts()).toEqual(ONE);
  });

  it("an admin takes a deal of either entity", async () => {
    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    expect((await takeAsProject("d-it", body({ opsManagerId: "user-ops-it" }), "admin")).status).toBe(201);
  });

  it("503 crm_unavailable when crm-api is down, and nothing is written", async () => {
    crm.down = true;
    const res = await takeAsProject("d-1", body());
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("crm_unavailable");
    expect(await counts()).toEqual(NOTHING);
  });
});

// ─── Who may take (T24; AC-1.1, AC-1.2, AC-1.9, AC-1.11) ─────────────────────

describe("POST /queue/:dealId/project — `handoff:take` and `project:manage` for the deal's entity (AC-1.9, AC-1.11)", () => {
  it.each(["pmCh", "opsCh", "accounting", "viewer", "colleague"] as const)(
    "403 forbidden for %s, who holds `handoff:take` for no entity: nothing written, the deal still queued, the CRM not asked",
    async (as) => {
      crm.deals = [makeDeal({ id: "d-1" })];
      const res = await takeAsProject("d-1", body(), as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
      expect(crm.calls).toBe(0);
      expect(await counts()).toEqual(NOTHING);
      expect(await inQueue()).toEqual(["d-1"]);
    },
  );

  it("403 out_of_scope for a sales user of the other entity — who reads the whole queue but takes its own entity's deals only", async () => {
    crm.deals = [makeDeal({ id: "d-ch", entity: "welld_ch" })];
    expect(await inQueue()).toEqual(["d-ch"]);
    const res = await takeAsProject("d-ch", body(), "salesIt");
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("out_of_scope");
    expect(await counts()).toEqual(NOTHING);
    expect(holders.calls).toBe(0);
    expect(await inQueue()).toEqual(["d-ch"]);

    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    const other = await takeAsProject("d-it", body(), "salesCh");
    expect([other.status, other.json.code]).toEqual([403, "out_of_scope"]);
    expect(await counts()).toEqual(NOTHING);
  });

  it("is 403 without projects:access and 401 without a token", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    expect((await takeAsProject("d-1", body(), "outsider")).status).toBe(403);
    expect((await takeAsProject("d-1", body(), null)).status).toBe(401);
  });

  it("lets sales take its own entity's deal and an admin either entity's", async () => {
    crm.deals = [makeDeal({ id: "d-ch" }), makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    expect((await takeAsProject("d-ch", body(), "salesCh")).status).toBe(201);
    expect((await takeAsProject("d-it", body({ opsManagerId: "user-ops-it" }), "admin")).status).toBe(201);
  });
});

// ─── The ops-manager (T24; AC-4.1, AC-4.2) ───────────────────────────────────

describe("POST /queue/:dealId/project — the ops-manager is checked against auth's live list (AC-4.1, AC-4.2)", () => {
  beforeEach(() => {
    crm.deals = [makeDeal({ id: "d-1" })];
  });

  it("accepts a role holder of the deal's entity, asking auth with the CALLER's token", async () => {
    const res = await takeAsProject("d-1", body({ opsManagerId: "user-ops" }));
    expect(res.status).toBe(201);
    expect(holders.calls).toBe(1);
    expect(holders.lastAuthorization).toBe(await bearerFor("salesCh"));
    expect(new URLSearchParams(holders.lastQuery).get("entity")).toBe("welld_ch");
    expect(await counts()).toEqual(ONE);
  });

  it("accepts an admin in their place (AC-4.2: an entity with no ops-manager does not block)", async () => {
    holders.users.welld_ch = [{ id: "user-admin", name: "Ada Admin", unconditioned: true }];
    const res = await takeAsProject("d-1", body({ opsManagerId: "user-admin" }));
    expect(res.status).toBe(201);
    expect(res.json.purchaseOrder.opsManager.id).toBe("user-admin");
  });

  it("asks for the DEAL's entity, not the caller's", async () => {
    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    const res = await takeAsProject("d-it", body({ opsManagerId: "user-ops-it" }), "admin");
    expect(res.status).toBe(201);
    expect(new URLSearchParams(holders.lastQuery).get("entity")).toBe("welld_it");
  });

  it.each([
    ["an ops-manager of the other entity", "user-ops-it"],
    ["a user who holds no role at all", "user-colleague"],
    ["an id nobody knows", "user-nobody"],
  ])("422 ops_manager_invalid for %s: nothing written, the deal still queued", async (_label, opsManagerId) => {
    const res = await takeAsProject("d-1", body({ opsManagerId }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ status: 422, code: "ops_manager_invalid" });
    expect(await counts()).toEqual(NOTHING);
    expect(await inQueue()).toEqual(["d-1"]);
  });

  it("re-reads the list on every take: an ops-manager who lost the role since the picker was filled is refused", async () => {
    expect((await takeAsProject("d-1", body({ opsManagerId: "user-ops" }))).status).toBe(201);
    crm.deals = [makeDeal({ id: "d-2" })];
    holders.users.welld_ch = holders.users.welld_ch.filter((holder) => holder.id !== "user-ops");
    const res = await takeAsProject("d-2", body({ opsManagerId: "user-ops" }));
    expect([res.status, res.json.code]).toEqual([422, "ops_manager_invalid"]);
    expect(await counts()).toEqual(ONE);
  });

  it.each([
    ["is down", () => void (holders.down = true)],
    ["refuses the caller", () => void (holders.status = 403)],
    ["answers something unreadable", () => void (holders.body = { users: "nope" })],
  ])("503 identity_unavailable when auth %s — fail-closed, nothing written", async (_label, breakAuth) => {
    breakAuth();
    const res = await takeAsProject("d-1", body());
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "identity_unavailable" });
    expect(await counts()).toEqual(NOTHING);
    expect(await inQueue()).toEqual(["d-1"]);
  });
});

// ─── The referent (T24; AC-3.6, T18 M3, L1) ──────────────────────────────────

describe("POST /queue/:dealId/project — the referent is a live contact of the DEAL's company (AC-3.6)", () => {
  beforeEach(() => {
    crm.deals = [makeDeal({ id: "d-1", company: { id: "co-acme", name: "Acme SA" } })];
    crm.contacts = [
      makeContact({ id: "c-ok", companyId: "co-acme" }),
      makeContact({ id: "c-other", companyId: "co-zeta" }),
      makeContact({ id: "c-none", companyId: null }),
      makeContact({ id: "c-old", companyId: "co-acme", archived: true }),
    ];
  });

  it("stores a non-archived contact of the deal's company, and only its id", async () => {
    const res = await takeAsProject("d-1", body({ referentContactId: "c-ok" }));
    expect(res.status).toBe(201);
    const stored = await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-1" } });
    expect(stored.referentContactId).toBe("c-ok");
    expect(JSON.stringify(stored)).not.toMatch(/First|Last|example\.test/);
    expect(crm.lastAuthorization).toMatch(/^Bearer /);
  });

  it("derives the company from the live deal, never from the body: a `companyId` in the body is a 400", async () => {
    const res = await takeAsProject("d-1", body({ referentContactId: "c-other", companyId: "co-zeta" }));
    expect(res.status).toBe(400);
    expect(await counts()).toEqual(NOTHING);
  });

  it("422 referent_invalid with ONE identical body for a contact of another company, one with no company and an unknown one", async () => {
    const bodies = [];
    for (const referentContactId of ["c-other", "c-none", "c-unknown"]) {
      const res = await takeAsProject("d-1", body({ referentContactId }));
      expect(res.status).toBe(422);
      bodies.push({ ...res.json });
    }
    // The problem differs by nothing a caller could read: not by instance, not by a member.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ status: 422, code: "referent_invalid" });
    expect(Object.keys(bodies[0]).sort()).toEqual(["code", "detail", "instance", "status", "title", "type"]);
    expect(JSON.stringify(bodies[0])).not.toMatch(/c-other|c-none|c-unknown|co-zeta|co-acme/);
    expect(await counts()).toEqual(NOTHING);
    expect(await inQueue()).toEqual(["d-1"]);
  });

  it("422 referent_invalid for an archived contact of the right company", async () => {
    const res = await takeAsProject("d-1", body({ referentContactId: "c-old" }));
    expect([res.status, res.json.code]).toEqual([422, "referent_invalid"]);
    expect(await counts()).toEqual(NOTHING);
  });

  it.each(["c-ok,c-other", "c ok", "c-ok\n", "ü"])("422 referent_invalid for the id %j, which is not shaped like an id", async (referentContactId) => {
    const res = await takeAsProject("d-1", body({ referentContactId }));
    expect([res.status, res.json.code]).toEqual([422, "referent_invalid"]);
    expect(crm.contactCalls).toBe(0);
    expect(await counts()).toEqual(NOTHING);
  });

  it("503 crm_unavailable when crm-api cannot answer the contact check, and nothing is written", async () => {
    // The deal is read first (and answered); only the contacts route is down.
    crm.contactsDown = true;
    const res = await takeAsProject("d-1", body({ referentContactId: "c-ok" }));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("crm_unavailable");
    expect(await counts()).toEqual(NOTHING);
  });

  it("checks the ops-manager before the referent: with both wrong the answer is ops_manager_invalid", async () => {
    const res = await takeAsProject("d-1", body({ opsManagerId: "user-nobody", referentContactId: "c-other" }));
    expect(res.json.code).toBe("ops_manager_invalid");
  });
});

// ─── The audit line (T24; T18 L6) ────────────────────────────────────────────

describe("POST /queue/:dealId/project — one structured log line per take (T18 L6)", () => {
  it("logs the event kind, the project id and the actor id — and no contact data, name or opsManager", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    crm.contacts = [makeContact({ id: "c-ok", firstName: "Hidden", lastName: "Person", email: "hidden.person@example.test" })];
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    let res;
    try {
      res = await takeAsProject("d-1", body({ name: "Secret Portal Name", referentContactId: "c-ok" }));
    } finally {
      log.mockRestore();
    }
    expect(res.status).toBe(201);
    const audit = lines.filter((line) => line.includes("handoff.taken"));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!)).toEqual({ event: "handoff.taken", projectId: res.json.id, actorId: "user-sales-ch" });
    for (const line of lines) expect(line).not.toMatch(/Hidden|Person|hidden\.person|c-ok|Secret Portal/);
  });

  it("logs nothing for a refused take", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      await takeAsProject("d-1", body({ opsManagerId: "user-nobody" }));
    } finally {
      log.mockRestore();
    }
    expect(lines.filter((line) => line.includes("handoff.taken"))).toEqual([]);
  });
});

// ─── No attach ───────────────────────────────────────────────────────────────

describe("no attach, no purchase order on an existing project (AC-1.10, D39)", () => {
  it("has no `POST /queue/:dealId/attach` any more: 404, the deal stays in the queue", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const { project } = await seedDealProject({ order: { dealId: "d-other" } });
    const res = await call("POST", "/queue/d-1/attach", { as: "admin", body: { projectId: project.id, terms: TERMS.t_and_m } });
    expect(res.status).toBe(404);
    expect(await inQueue()).toEqual(["d-1"]);
    expect(await db.purchaseOrder.count()).toBe(1);
  });

  it("has no route that adds a purchase order to a project: the terms route and the Bexio route make none", async () => {
    const byHand = await db.project.create({
      data: { name: "By hand", type: "t_and_m", entity: "welld_ch", companyId: "co-acme", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
    });
    for (const [method, path] of [
      ["POST", `/projects/${byHand.id}/purchase-order`],
      ["PUT", `/projects/${byHand.id}/purchase-order`],
    ] as const) {
      expect((await call(method, path, { as: "admin", body: { dealId: "d-1" }, ifMatch: 1 })).status).toBe(404);
    }
    // `PATCH` is the referent's edit (T26): it exists, takes `referentContactId` only (a deal id is a 400) and
    // answers `purchase_order_not_found` for a hand-made project — it never makes an order.
    const patched = await call("PATCH", `/projects/${byHand.id}/purchase-order`, { as: "admin", body: { dealId: "d-1" }, ifMatch: 1 });
    expect(patched.status).toBe(400);
    const edit = await call("PATCH", `/projects/${byHand.id}/purchase-order`, { as: "admin", body: { referentContactId: null }, ifMatch: 1 });
    expect([edit.status, edit.json.code]).toEqual([404, "purchase_order_not_found"]);
    expect(await db.purchaseOrder.count()).toBe(0);
  });
});

// ─── The notification (T25; AC-4.3, AC-4.4) ──────────────────────────────────

/** Waits for something that happens after the response (the push is never awaited by it). */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2_000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("POST /queue/:dealId/project — the ops-manager is told, and only the ops-manager (AC-4.3)", () => {
  const events: NotifyEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    setNotifierForTests({
      async notify(event) {
        events.push(event);
      },
    });
    crm.deals = [makeDeal({ id: "d-1", title: "Portal rebuild" })];
  });
  afterEach(resetNotifierForTests);

  it("sends exactly one push, to the ops-manager of the take, in English, with a link to the new project", async () => {
    crm.contacts = [makeContact({ id: "contact-1", companyId: "co-acme" })];
    const res = await takeAsProject("d-1", body({ referentContactId: "contact-1" }));

    expect(res.status).toBe(201);
    expect(events).toEqual([
      {
        kind: "purchase_order_assigned",
        projectId: res.json.id,
        recipientId: "user-ops",
        severity: "info",
        title: "Purchase order assigned: Portal 2027",
        body: "Acme SA — pick the project manager of this project.",
        href: `/projects/${res.json.id}`,
      },
    ]);
  });

  it("tells the person the caller chose, not the caller, the referent or anybody else", async () => {
    const res = await takeAsProject("d-1", body({ opsManagerId: "user-admin" }), "salesCh");
    expect(res.status).toBe(201);
    expect(events.map((event) => event.recipientId)).toEqual(["user-admin"]);
  });

  it("goes out after the commit: the project and its purchase order are stored by then", async () => {
    let stored: { projects: number; orders: number } | undefined;
    setNotifierForTests({
      async notify() {
        stored = { projects: await db.project.count(), orders: await db.purchaseOrder.count() };
      },
    });
    expect((await takeAsProject("d-1", body())).status).toBe(201);
    await until(() => stored !== undefined, "the notifier");
    expect(stored).toEqual({ projects: 1, orders: 1 });
  });

  it("reaches notify-api as the service principal, as a `projects` notification of the contract's shape", async () => {
    const seen: { url: string; authorization: string | null; body: unknown }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    setNotifierForTests(createNotifier({ baseUrl: "http://notify.test", tokens: serviceTokens!, fetchImpl }));

    const res = await takeAsProject("d-1", body({ name: "Portal 2027" }));
    expect(res.status).toBe(201);
    await until(() => seen.length > 0, "the push");
    expect(seen).toEqual([
      {
        url: "http://notify.test/system/notifications",
        // The service token, never the caller's: a person taking a deal holds no `notifications.push`.
        authorization: `Bearer ${SERVICE_JWT}`,
        body: {
          recipientId: "user-ops",
          originApp: "projects",
          severity: "info",
          title: "Purchase order assigned: Portal 2027",
          body: "Acme SA — pick the project manager of this project.",
          link: { href: `/projects/${res.json.id}` },
        },
      },
    ]);
  });

  it.each([
    ["a deal that is not won", () => (crm.deals = [makeDeal({ id: "d-1", stage: "negotiation" })]), body(), 409],
    ["an ops-manager who may not receive it", () => {}, body({ opsManagerId: "user-nobody" }), 422],
    ["a referent of another company", () => (crm.contacts = [makeContact({ id: "c-other", companyId: "co-zeta" })]), body({ referentContactId: "c-other" }), 422],
    ["a body that is not valid", () => {}, body({ name: "" }), 400],
  ] as const)("sends nothing for a take refused for %s", async (_label, arrange, payload, status) => {
    arrange();
    const res = await takeAsProject("d-1", payload);
    expect(res.status).toBe(status);
    expect(events).toEqual([]);
  });

  it("sends nothing for a take refused to the wrong entity, or without the right", async () => {
    expect((await takeAsProject("d-1", body(), "salesIt")).status).toBe(403);
    expect((await takeAsProject("d-1", body(), "pmCh")).status).toBe(403);
    expect((await takeAsProject("d-1", body(), null)).status).toBe(401);
    expect(events).toEqual([]);
  });

  it("sends nothing when the CRM or auth cannot answer", async () => {
    holders.down = true;
    expect((await takeAsProject("d-1", body())).status).toBe(503);
    holders.down = false;
    crm.down = true;
    expect((await takeAsProject("d-1", body())).status).toBe(503);
    expect(events).toEqual([]);
  });

  it("sends one push for a deal taken twice: the second take is deal_taken and tells nobody", async () => {
    expect((await takeAsProject("d-1", body())).status).toBe(201);
    expect((await takeAsProject("d-1", body({ name: "Second" }))).status).toBe(409);
    expect(events).toHaveLength(1);
  });

  it("sends one push for two concurrent takes of one deal", async () => {
    const [a, b] = await Promise.all([takeAsProject("d-1", body()), takeAsProject("d-1", body({ name: "Other" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(events).toHaveLength(1);
  });
});

describe("POST /queue/:dealId/project — a notification that cannot be delivered changes nothing (AC-4.4)", () => {
  beforeEach(() => {
    crm.deals = [makeDeal({ id: "d-1" })];
  });
  afterEach(resetNotifierForTests);

  /** The take answered 201 with the project awaiting its project manager, and everything stored. */
  const expectTaken = async (res: Awaited<ReturnType<typeof takeAsProject>>) => {
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ state: "planned", projectManager: null, awaitingProjectManager: true });
    expect(await counts()).toEqual(ONE);
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { dealId: "d-1" } })).toMatchObject({ opsManagerId: "user-ops" });
  };

  /** A notify-api behind `fetchImpl`, reached through the real notifier and token provider. */
  const wireNotifyApi = (fetchImpl: typeof fetch, timeoutMs?: number) =>
    setNotifierForTests(createNotifier({ baseUrl: "http://notify.test", tokens: serviceTokens!, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) }));

  /** The console's error lines while `run` runs (the failure of a delivery is logged after the response). */
  const errorLines = () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    return { lines, restore: () => spy.mockRestore() };
  };

  it.each([401, 403, 500, 503])("still 201 when notify-api answers HTTP %i", async (status) => {
    let calls = 0;
    wireNotifyApi((async () => {
      calls++;
      return new Response("{}", { status });
    }) as unknown as typeof fetch);
    const errors = errorLines();
    try {
      await expectTaken(await takeAsProject("d-1", body()));
      await until(() => errors.lines.some((line) => line.includes(`HTTP ${status}`)), "the failure to be logged");
    } finally {
      errors.restore();
    }
    expect(calls).toBe(status === 401 ? 2 : 1);
  });

  it("still 201 when notify-api is unreachable", async () => {
    wireNotifyApi((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const errors = errorLines();
    try {
      await expectTaken(await takeAsProject("d-1", body()));
      await until(() => errors.lines.some((line) => line.includes("TypeError")), "the failure to be logged");
    } finally {
      errors.restore();
    }
  });

  it("still 201 when notify-api times out", async () => {
    const hangs = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      })) as typeof fetch;
    wireNotifyApi(hangs, 30);
    const errors = errorLines();
    try {
      await expectTaken(await takeAsProject("d-1", body()));
      await until(() => errors.lines.some((line) => line.includes("TimeoutError")), "the timeout to be logged");
    } finally {
      errors.restore();
    }
  });

  it("answers without waiting for a delivery that never finishes", async () => {
    setNotifierForTests({ notify: () => new Promise<void>(() => {}) });
    await expectTaken(await takeAsProject("d-1", body()));
  });

  it("still 201 when the notifier itself blows up", async () => {
    setNotifierForTests({
      notify() {
        throw new Error("boom");
      },
    });
    await expectTaken(await takeAsProject("d-1", body()));
  });

  it.each([
    ["unset", undefined],
    ["set, under NODE_ENV=test with no injected notifier", "http://notify.test"],
  ])("still 201, and calls notify-api for nobody, when NOTIFY_INTERNAL_URL is %s", async (_label, url) => {
    const configured = env.NOTIFY_INTERNAL_URL;
    env.NOTIFY_INTERNAL_URL = url;
    const notifyCalls = () =>
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((args) => String(args[0]).includes("/system/notifications")).length;
    const before = notifyCalls();
    try {
      resetNotifierForTests(); // nothing injected: the environment decides
      await expectTaken(await takeAsProject("d-1", body()));
      await Bun.sleep(30); // a push, were there one, starts right after the commit
    } finally {
      env.NOTIFY_INTERNAL_URL = configured;
    }
    expect(notifyCalls()).toBe(before);
  });

  it("logs no token, title, name or contact data when delivery fails", async () => {
    crm.contacts = [makeContact({ id: "c-ok", firstName: "Hidden", lastName: "Person", email: "hidden.person@example.test" })];
    wireNotifyApi((async () => new Response("{}", { status: 503 })) as unknown as typeof fetch);
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")].map((spy) => spy.mockImplementation(record));
    try {
      await expectTaken(await takeAsProject("d-1", body({ name: "Secret Portal Name", referentContactId: "c-ok" })));
      await until(() => lines.some((line) => line.includes("[notify]")), "the failure to be logged");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const failure = lines.filter((line) => line.includes("[notify]"));
    expect(failure).toHaveLength(1);
    expect(failure[0]).toContain("HTTP 503");
    for (const line of lines) {
      expect(line).not.toContain(SERVICE_JWT);
      expect(line).not.toMatch(/Bearer|Secret Portal|Purchase order assigned|Acme|Hidden|Person|hidden\.person|c-ok|user-ops/);
    }
  });
});
