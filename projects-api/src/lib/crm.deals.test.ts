/**
 * crm-api client for CRM deals (specs/022 T5; AC-1.1, AC-2.1, AC-2.2, ADR-0060): `wonDeals()` is
 * the source of the to-start queue, `dealsById(ids)` of a purchase order's deal. Both read crm-api as
 * ITSELF (a service JWT), live, and throw `CrmUnavailableError` when crm-api cannot answer. The
 * CRM is the fake of test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { authSystem, crm, makeDeal, resetWorld, SERVICE_JWT } from "../test-support/world";
import { CrmUnavailableError, dealsById, wonDeals } from "./crm";
import { serviceTokens } from "./serviceToken";

beforeEach(resetWorld);

describe("wonDeals() — the to-start queue's source (AC-1.1)", () => {
  it("lists the won deals, newest win first, as summaries with company, entity, won date and estimate", async () => {
    const older = makeDeal({ id: "d-old", title: "Older", wonAt: "2026-11-01T09:00:00.000Z" });
    const newer = makeDeal({
      id: "d-new",
      title: "Newer",
      entity: "welld_it",
      company: { id: "co-zeta", name: "Zeta AG" },
      wonAt: "2026-11-03T09:00:00.000Z",
      estimate: { id: "est-9", name: "Zeta estimate" },
    });
    crm.deals = [older, makeDeal({ id: "d-lost", stage: "lost" }), newer];

    const { items, truncated } = await wonDeals();

    expect(truncated).toBe(false);
    expect(items).toEqual([
      {
        id: "d-new",
        title: "Newer",
        stage: "won",
        entity: "welld_it",
        company: { id: "co-zeta", name: "Zeta AG" },
        wonAt: "2026-11-03T09:00:00.000Z",
        estimate: { id: "est-9", name: "Zeta estimate" },
      },
      { id: "d-old", title: "Older", stage: "won", entity: "welld_ch", company: { id: "co-acme", name: "Acme SA" }, wonAt: "2026-11-01T09:00:00.000Z", estimate: null },
    ]);
  });

  it("reads as the service principal, not as anyone's user token", async () => {
    await wonDeals();
    expect(crm.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
  });

  it("passes `truncated` through when crm-api cut the list", async () => {
    crm.deals = [makeDeal(), makeDeal(), makeDeal()];
    crm.wonLimit = 2;
    const { items, truncated } = await wonDeals();
    expect(items).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("is live: a reopened deal is gone on the next read, and back once won again (AC-2.1, AC-2.2)", async () => {
    const deal = makeDeal({ id: "d-1" });
    crm.deals = [deal];
    expect((await wonDeals()).items.map((d) => d.id)).toEqual(["d-1"]);
    deal.stage = "negotiation";
    expect((await wonDeals()).items).toEqual([]);
    deal.stage = "won";
    expect((await wonDeals()).items.map((d) => d.id)).toEqual(["d-1"]);
  });

  it("throws CrmUnavailableError when crm-api is down or auth cannot mint the credential", async () => {
    crm.down = true;
    await expect(wonDeals()).rejects.toBeInstanceOf(CrmUnavailableError);
    crm.down = false;
    serviceTokens!.invalidate(SERVICE_JWT); // the provider caches a token for minutes; start without one
    authSystem.down = true;
    await expect(wonDeals()).rejects.toBeInstanceOf(CrmUnavailableError);
  });
});

describe("dealsById(ids) — a purchase order's deal, live (AC-2.3)", () => {
  it("returns the asked deals keyed by id, in any stage, with `wonAt` only while won", async () => {
    crm.deals = [
      makeDeal({ id: "d-won", wonAt: "2026-11-02T10:00:00.000Z" }),
      makeDeal({ id: "d-reopened", stage: "negotiation" }),
      makeDeal({ id: "d-other" }),
    ];

    const found = await dealsById(["d-won", "d-reopened", "d-unknown"]);

    expect([...found.keys()].sort()).toEqual(["d-reopened", "d-won"]);
    expect(found.get("d-won")).toMatchObject({ id: "d-won", stage: "won", wonAt: "2026-11-02T10:00:00.000Z" });
    expect(found.get("d-reopened")).toMatchObject({ id: "d-reopened", stage: "negotiation", wonAt: null });
    expect(crm.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
  });

  it("sees a deal reopened and won again, with no caching in between (AC-2.3, AC-2.4)", async () => {
    const deal = makeDeal({ id: "d-1" });
    crm.deals = [deal];
    expect((await dealsById(["d-1"])).get("d-1")?.stage).toBe("won");
    deal.stage = "negotiation";
    expect((await dealsById(["d-1"])).get("d-1")?.stage).toBe("negotiation");
    deal.stage = "won";
    expect((await dealsById(["d-1"])).get("d-1")?.stage).toBe("won");
  });

  it("asks nothing for no ids, and once per 100 distinct ids otherwise (crm-api's cap)", async () => {
    expect((await dealsById([])).size).toBe(0);
    expect(crm.dealCalls).toBe(0);

    crm.deals = Array.from({ length: 150 }, (_, i) => makeDeal({ id: `d-${i}` }));
    const found = await dealsById([...crm.deals.map((d) => d.id), "d-0", "d-1"]);
    expect(found.size).toBe(150);
    expect(crm.dealCalls).toBe(2);
  });

  it("throws CrmUnavailableError when crm-api cannot answer", async () => {
    crm.down = true;
    await expect(dealsById(["d-1"])).rejects.toBeInstanceOf(CrmUnavailableError);
  });
});
