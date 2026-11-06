/**
 * What the take's form asks the server for (specs/022 T24; AC-1.2, AC-3.6, AC-4.1, AC-4.2, T18 M1):
 *   GET /queue/:dealId/ops-managers  the people who may be the purchase order's ops-manager, from auth
 *   GET /queue/:dealId/contacts      the deal company's CRM contacts, for the referent
 * Both are gated like the take (`handoff:take` and `project:manage` for the DEAL's entity), derive the
 * entity and the company from the live deal, and read auth and the CRM live. Runs the ASSEMBLED app
 * against the `*_test` database; auth's holders list and the CRM are the fakes of test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { bearerFor, call, crm, holders, makeContact, makeDeal, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.deals = [makeDeal({ id: "d-ch", entity: "welld_ch", company: { id: "co-acme", name: "Acme SA" } })];
});

const opsManagers = (dealId: string, as: PersonaName | null = "salesCh") => call("GET", `/queue/${dealId}/ops-managers`, { as });
const contacts = (dealId: string, as: PersonaName | null = "salesCh", query = "") => call("GET", `/queue/${dealId}/contacts${query}`, { as });

const holder = (id: string, unconditioned = false) => ({ id, name: `Name ${id}`, unconditioned });

// ─── The gate, shared by both routes ─────────────────────────────────────────

describe.each([
  ["GET /queue/:dealId/ops-managers", opsManagers],
  ["GET /queue/:dealId/contacts", contacts],
] as const)("%s — gated like the take (AC-1.9, AC-1.11)", (_name, ask) => {
  it.each(["pmCh", "opsCh", "accounting", "viewer", "colleague"] as const)(
    "403 forbidden for %s, who holds `handoff:take` for no entity — before the CRM or auth is asked",
    async (as) => {
      const res = await ask("d-ch", as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
      expect(crm.calls).toBe(0);
      expect(holders.calls).toBe(0);
    },
  );

  it("403 out_of_scope for a sales user of the other entity — the deal's entity decides, and nothing is looked up for them", async () => {
    const res = await ask("d-ch", "salesIt");
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("out_of_scope");
    expect(holders.calls).toBe(0);
    expect(crm.contactCalls).toBe(0);
  });

  it("is 403 without projects:access and 401 without a token", async () => {
    expect((await ask("d-ch", "outsider")).status).toBe(403);
    expect((await ask("d-ch", null)).status).toBe(401);
  });

  it("is 404 deal_not_found for a deal the CRM does not know", async () => {
    const res = await ask("d-nope");
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("deal_not_found");
  });

  it("is 503 crm_unavailable when crm-api cannot say what the deal is", async () => {
    crm.down = true;
    const res = await ask("d-ch");
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("crm_unavailable");
  });

  it("is open to sales of the deal's entity and to an admin", async () => {
    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    expect((await ask("d-it", "salesIt")).status).toBe(200);
    expect((await ask("d-it", "admin")).status).toBe(200);
  });
});

// ─── The ops-manager candidates ──────────────────────────────────────────────

describe("GET /queue/:dealId/ops-managers — role holders and admins, admins last (AC-4.1, AC-4.2)", () => {
  it("lists the holders for the deal's entity as { id, name, admin } with `admin` = unconditioned, and nothing else", async () => {
    holders.users.welld_ch = [holder("u-ann"), holder("u-ben")];
    const res = await opsManagers("d-ch");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: "u-ann", name: "Name u-ann", admin: false },
        { id: "u-ben", name: "Name u-ben", admin: false },
      ],
      prefillId: null,
    });
  });

  it("puts admins last, keeping auth's name order inside each group", async () => {
    holders.users.welld_ch = [holder("u-ada", true), holder("u-ann"), holder("u-aaron", true), holder("u-ben")];
    const res = await opsManagers("d-ch");
    expect(res.json.items.map((item: { id: string; admin: boolean }) => [item.id, item.admin])).toEqual([
      ["u-ann", false],
      ["u-ben", false],
      ["u-ada", true],
      ["u-aaron", true],
    ]);
  });

  describe("prefillId — the only role holder, admins not counted (AC-4.1)", () => {
    it("none: no role holder and no admin → nothing listed, nothing prefilled", async () => {
      holders.users.welld_ch = [];
      expect((await opsManagers("d-ch")).json).toEqual({ items: [], prefillId: null });
    });

    it("one: exactly one role holder, with or without admins → prefilled with that person", async () => {
      holders.users.welld_ch = [holder("u-ann"), holder("u-admin", true)];
      expect((await opsManagers("d-ch")).json.prefillId).toBe("u-ann");
      holders.users.welld_ch = [holder("u-ann")];
      expect((await opsManagers("d-ch")).json.prefillId).toBe("u-ann");
    });

    it("two: several role holders → nothing prefilled, a choice is required", async () => {
      holders.users.welld_ch = [holder("u-ann"), holder("u-ben"), holder("u-admin", true)];
      const res = await opsManagers("d-ch");
      expect(res.json.prefillId).toBeNull();
      expect(res.json.items).toHaveLength(3);
    });

    it("admins only: an entity with no ops-manager → the admins are offered, none is prefilled", async () => {
      holders.users.welld_ch = [holder("u-admin", true)];
      const res = await opsManagers("d-ch");
      expect(res.json).toEqual({ items: [{ id: "u-admin", name: "Name u-admin", admin: true }], prefillId: null });
    });
  });

  it("asks auth live with the CALLER's token for the DEAL's entity, on every request", async () => {
    crm.deals = [makeDeal({ id: "d-it", entity: "welld_it", company: { id: "co-zeta", name: "Zeta AG" } })];
    await opsManagers("d-it", "admin");
    expect(holders.lastAuthorization).toBe(await bearerFor("admin"));
    expect(new URLSearchParams(holders.lastQuery).get("entity")).toBe("welld_it");
    await opsManagers("d-it", "admin");
    expect(holders.calls).toBe(2);
  });

  it("is never cached", async () => {
    expect((await opsManagers("d-ch")).headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["is down", () => void (holders.down = true)],
    ["refuses the caller", () => void (holders.status = 403)],
    ["answers something unreadable", () => void (holders.body = { users: "nope" })],
  ])("503 identity_unavailable when auth %s — never an empty picker", async (_label, breakAuth) => {
    breakAuth();
    const res = await opsManagers("d-ch");
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "identity_unavailable" });
  });
});

// ─── The referent contacts ───────────────────────────────────────────────────

describe("GET /queue/:dealId/contacts — the DEAL's company's contacts, for the referent (AC-3.6, T18 M1)", () => {
  beforeEach(() => {
    crm.contacts = [
      makeContact({ id: "c-baker", firstName: "Zed", lastName: "Baker", jobTitle: null }),
      makeContact({ id: "c-archer", firstName: "Ann", lastName: "Archer", jobTitle: "CTO" }),
      makeContact({ id: "c-old", firstName: "Old", lastName: "Archer", archived: true }),
      makeContact({ id: "c-zeta", companyId: "co-zeta", lastName: "Zeta" }),
      makeContact({ id: "c-none", companyId: null, lastName: "Nobody" }),
    ];
  });

  it("lists the deal company's non-archived contacts as { id, name, jobTitle }, sorted, and no other company's", async () => {
    const res = await contacts("d-ch");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: "c-archer", name: "Ann Archer", jobTitle: "CTO" },
        { id: "c-baker", name: "Zed Baker", jobTitle: null },
      ],
    });
  });

  it("carries no email, phone, company or archived flag", async () => {
    const res = await contacts("d-ch");
    expect(JSON.stringify(res.json)).not.toMatch(/example\.test|\+41|email|phone|companyId|archived/);
  });

  it("derives the company from the live deal: the client never names one, and a `companyId` it sends is ignored", async () => {
    const res = await contacts("d-ch", "salesCh", "?companyId=co-zeta");
    expect(res.status).toBe(200);
    expect(res.json.items.map((item: { id: string }) => item.id)).toEqual(["c-archer", "c-baker"]);
    expect(crm.lastContactsQuery).toBe("?companyId=co-acme");
  });

  it("reads as the service principal, live every time, and is never cached (T18 M5)", async () => {
    const first = await contacts("d-ch");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(crm.lastAuthorization).toMatch(/^Bearer /);
    await contacts("d-ch");
    expect(crm.contactCalls).toBe(2);
  });

  it("is 409 deal_taken for a deal that already has a purchase order", async () => {
    await seedDealProject({ order: { dealId: "d-ch" } });
    const res = await contacts("d-ch");
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("deal_taken");
    expect(crm.contactCalls).toBe(0);
  });

  it("is 409 deal_not_won for a deal that is no longer won, and gives its company's contacts to nobody", async () => {
    crm.deals = [makeDeal({ id: "d-reopened", stage: "negotiation" })];
    const res = await contacts("d-reopened");
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("deal_not_won");
    expect(crm.contactCalls).toBe(0);
  });

  it("is 503 crm_unavailable when the contacts cannot be read", async () => {
    crm.contactsDown = true;
    const res = await contacts("d-ch");
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("crm_unavailable");
  });
});
