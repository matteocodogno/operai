/**
 * The to-start queue (specs/022 T6; AC-1.1, AC-1.6, AC-2.1, AC-2.2): `GET /queue` lists the CRM's won
 * deals without a purchase order, newest win first, read live. Runs the ASSEMBLED app against the
 * `*_test` database; the CRM is the fake of test-support/world.ts. A taken deal is seeded straight in
 * the database with its purchase order (the take itself is tested in take.test.ts). specs/022 T24: the
 * queue is read by `handoff:take` holders only (sales, admin), under any entity.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, crm, makeDeal, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";

beforeEach(resetWorld);

/** A purchase order on a fresh project: the deal now has one and so leaves the queue. */
async function takeInDb(dealId: string): Promise<void> {
  await seedDealProject({ type: "t_and_m", project: { name: `Project of ${dealId}` }, order: { dealId } });
}

const queue = (query = "", as: PersonaName | null = "salesCh") =>
  call("GET", `/queue${query}`, { as });

describe("GET /queue — a won deal waits for someone to take it (AC-1.1)", () => {
  it("lists a won deal with title, company, entity, won date and estimate, and no amount", async () => {
    crm.deals = [
      makeDeal({
        id: "d-1",
        title: "Portal rebuild",
        entity: "welld_it",
        company: { id: "co-zeta", name: "Zeta AG" },
        wonAt: "2026-11-02T10:00:00.000Z",
        estimate: { id: "est-7", name: "Portal estimate" },
      }),
    ];
    const res = await queue();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        {
          dealId: "d-1",
          title: "Portal rebuild",
          entity: "welld_it",
          company: { id: "co-zeta", name: "Zeta AG" },
          wonAt: "2026-11-02T10:00:00.000Z",
          estimate: { id: "est-7", name: "Portal estimate" },
        },
      ],
      truncated: false,
    });
    // D14: nothing money-like, owner or notes can leak, whatever the CRM sends.
    expect(JSON.stringify(res.json)).not.toMatch(/amount|currency|price|owner|notes/i);
  });

  it("shows a deal without an estimate with `estimate: null`", async () => {
    crm.deals = [makeDeal({ id: "d-1" })];
    const res = await queue();
    expect(res.json.items[0].estimate).toBeNull();
  });

  it("lists the newest win first", async () => {
    crm.deals = [
      makeDeal({ id: "d-old", wonAt: "2026-10-01T09:00:00.000Z" }),
      makeDeal({ id: "d-new", wonAt: "2026-11-03T09:00:00.000Z" }),
      makeDeal({ id: "d-mid", wonAt: "2026-10-20T09:00:00.000Z" }),
    ];
    const res = await queue();
    expect(res.json.items.map((item: { dealId: string }) => item.dealId)).toEqual(["d-new", "d-mid", "d-old"]);
  });

  it("lists only won deals: a deal that is not won is not in the queue", async () => {
    crm.deals = [makeDeal({ id: "d-won" }), makeDeal({ id: "d-lost", stage: "lost" }), makeDeal({ id: "d-lead", stage: "lead" })];
    const res = await queue();
    expect(res.json.items.map((item: { dealId: string }) => item.dealId)).toEqual(["d-won"]);
  });
});

describe("GET /queue — a deal feeds at most one project (AC-1.6)", () => {
  it("omits a deal that already has a purchase order", async () => {
    crm.deals = [makeDeal({ id: "d-taken" }), makeDeal({ id: "d-free" })];
    await takeInDb("d-taken");
    const res = await queue();
    expect(res.json.items.map((item: { dealId: string }) => item.dealId)).toEqual(["d-free"]);
  });
});

describe("GET /queue — a reopened deal leaves and comes back (AC-2.1, AC-2.2)", () => {
  it("drops a deal the CRM reopened, and lists it again once it is won again", async () => {
    const deal = makeDeal({ id: "d-1" });
    crm.deals = [deal];
    expect((await queue()).json.items).toHaveLength(1);

    deal.stage = "negotiation";
    expect((await queue()).json.items).toHaveLength(0);

    deal.stage = "won";
    expect((await queue()).json.items.map((item: { dealId: string }) => item.dealId)).toEqual(["d-1"]);
  });
});

describe("GET /queue — search and entity filter", () => {
  beforeEach(() => {
    crm.deals = [
      makeDeal({ id: "d-1", title: "Portal rebuild", company: { id: "co-acme", name: "Acme SA" }, entity: "welld_ch" }),
      makeDeal({ id: "d-2", title: "Data migration", company: { id: "co-zeta", name: "Zeta AG" }, entity: "welld_it" }),
      makeDeal({ id: "d-3", title: "Support 2027", company: { id: "co-acme", name: "Acme SA" }, entity: "welld_it" }),
    ];
  });
  const ids = (res: { json: { items: { dealId: string }[] } }) => res.json.items.map((item) => item.dealId).sort();

  it("`q` matches the title, case-insensitively", async () => {
    expect(ids(await queue("?q=PORTAL"))).toEqual(["d-1"]);
  });

  it("`q` matches the company name, case-insensitively", async () => {
    expect(ids(await queue("?q=zeta"))).toEqual(["d-2"]);
    expect(ids(await queue("?q=acme"))).toEqual(["d-1", "d-3"]);
  });

  it("a blank `q` filters nothing", async () => {
    expect(ids(await queue("?q=%20%20"))).toEqual(["d-1", "d-2", "d-3"]);
  });

  it("`entity` keeps the deals of that entity", async () => {
    expect(ids(await queue("?entity=welld_it"))).toEqual(["d-2", "d-3"]);
    expect(ids(await queue("?entity=welld_ch"))).toEqual(["d-1"]);
  });

  it("`q` and `entity` are ANDed", async () => {
    expect(ids(await queue("?q=acme&entity=welld_it"))).toEqual(["d-3"]);
  });

  it("an unknown `entity` is a 400", async () => {
    expect((await queue("?entity=welld_xx")).status).toBe(400);
  });
});

describe("GET /queue — the CRM's cap and the CRM's absence", () => {
  it("passes `truncated` through when the CRM holds more won deals than it returns", async () => {
    crm.wonLimit = 2;
    crm.deals = [makeDeal(), makeDeal(), makeDeal()];
    const res = await queue();
    expect(res.json.items).toHaveLength(2);
    expect(res.json.truncated).toBe(true);
  });

  it("answers 503 `crm_unavailable` when crm-api is down", async () => {
    crm.down = true;
    const res = await queue();
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("crm_unavailable");
  });
});

describe("GET /queue — who may read it: `handoff:take`, sales and admin only (AC-1.1, AC-1.9)", () => {
  it("lets `sales` of either entity and an admin read it", async () => {
    crm.deals = [makeDeal()];
    for (const as of ["salesCh", "salesIt", "admin"] as const) {
      expect({ as, status: (await queue("", as)).status }).toEqual({ as, status: 200 });
    }
  });

  it("shows a sales user the whole queue, the other entity's deals included", async () => {
    crm.deals = [makeDeal({ id: "d-ch", entity: "welld_ch" }), makeDeal({ id: "d-it", entity: "welld_it" })];
    for (const as of ["salesCh", "salesIt"] as const) {
      const res = await queue("", as);
      expect({ as, ids: res.json.items.map((item: { dealId: string }) => item.dealId).sort() }).toEqual({ as, ids: ["d-ch", "d-it"] });
    }
  });

  it.each(["pmCh", "opsCh", "accounting", "viewer", "colleague"] as const)(
    "refuses %s, a holder of projects:access without handoff:take, with 403 `forbidden` — before asking the CRM",
    async (as) => {
      crm.deals = [makeDeal()];
      const res = await queue("", as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
      expect(crm.calls).toBe(0);
    },
  );

  it("is 403 without projects:access", async () => {
    expect((await queue("", "outsider")).status).toBe(403);
  });

  it("is 401 without a token", async () => {
    expect((await queue("", null)).status).toBe(401);
  });
});
