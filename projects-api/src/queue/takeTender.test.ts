/**
 * Taking a won public tender (specs/20261101-crm US-10, 2026-11-24, owner): the same queue and route, but the project is
 * made WITHOUT a purchase order — the funding body is its company, its project manager is chosen at the take, and it
 * is linked by `tenderDealId` (taken once). The CRM's deal page read is in system/purchaseOrders.routes.test.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { __setClockForTests } from "../lib/businessDay";
import { call, crm, db, makeDeal, resetWorld } from "../test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [{ id: "co-chips", name: "Chips Joint Undertaking", entity: "welld_ch", archived: false }];
});

const TENDER = () =>
  makeDeal({ id: "t-1", title: "Horizon Chips JU call", kind: "tender", company: { id: "co-chips", name: "Chips Joint Undertaking" } });
const terms = { startDate: "2027-01-01", terms: { positions: [{ profile: "Senior developer", plannedManDays: 200 }] } };
const body = (over: Record<string, unknown> = {}) => ({ name: "Chips JU project", type: "t_and_m", terms, projectManagerId: "user-pm-ch", ...over });
const take = (payload: unknown) => call("POST", "/queue/t-1/project", { as: "salesCh", body: payload });
const inQueue = async () => (await call("GET", "/queue", { as: "salesCh" })).json.items as { dealId: string; kind: string }[];

describe("a won tender", () => {
  it("is in the queue as a tender, and is taken as a project with its project manager and NO purchase order", async () => {
    crm.deals = [TENDER()];
    expect(await inQueue()).toEqual([expect.objectContaining({ dealId: "t-1", kind: "tender" })]);

    const res = await take(body());
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      company: { id: "co-chips" },
      projectManager: { id: "user-pm-ch" },
      awaitingProjectManager: false,
      purchaseOrder: null,
      tenderDealId: "t-1",
      terms: { type: "t_and_m" },
    });
    expect(await db.purchaseOrder.count()).toBe(0);
    // Taken once: out of the queue, and a second take is deal_taken.
    expect(await inQueue()).toEqual([]);
    const again = await take(body({ name: "Twice" }));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("deal_taken");
    expect(await db.project.count()).toBe(1);
  });

  // specs/20261112-project-hours T22 (AC-5.29): the tender's take answers through `toProjectView` as the deal's does.
  it("answers with its terms' asOf, the Zurich day the terms were derived for", async () => {
    try {
      __setClockForTests(() => new Date("2026-12-15T23:30:00Z")); // 00:30 on 16 December in Zurich
      crm.deals = [TENDER()];
      const res = await take(body());
      expect(res.status).toBe(201);
      expect(res.json.terms).toMatchObject({ type: "t_and_m", asOf: "2026-12-16" });
    } finally {
      __setClockForTests(null);
    }
  });

  it("refuses an ops-manager or a referent, and needs a project manager who can use Projects", async () => {
    crm.deals = [TENDER()];
    for (const [extra, field, code] of [
      [{ opsManagerId: "user-ops" }, "opsManagerId", "not_for_tenders"],
      [{ referentContactId: "c-1" }, "referentContactId", "not_for_tenders"],
      [{ projectManagerId: undefined }, "projectManagerId", "project_manager_required"],
    ] as const) {
      const res = await take(body(extra));
      expect(res.status, field).toBe(422);
      expect(res.json, field).toMatchObject({ code, field });
    }
    const outsider = await take(body({ projectManagerId: "user-outsider" }));
    expect(outsider.status).toBe(422);
    expect(await db.project.count()).toBe(0);
  });

  it("a standard deal refuses a project manager at the take", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await call("POST", "/queue/d-1/project", {
      as: "salesCh",
      body: { name: "X", type: "t_and_m", terms, opsManagerId: "user-ops", projectManagerId: "user-pm-ch" },
    });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "only_for_tenders", field: "projectManagerId" });
  });

});
