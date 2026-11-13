/**
 * `POST /activity-host/v1/resolve` (specs/20261110-activities T4; AC-8.1, AC-8.3; ADR 20261110-activities-service-access-delegated-to-host): the host half of
 * "may THIS caller read the activities of these companies?", answered live from the caller's own
 * forwarded JWT. A `crm:access` holder gets `reader:true`, each company `open` (label, href,
 * `writable`, `may`) or `missing`, and the related contacts/deals OF THOSE COMPANIES only; anyone
 * else gets `reader:false` and nothing about any record. An `auth` outage is a 503 (fail closed).
 *
 * specs/029 T7 (AC-2.3, AC-2.10, AC-4.10; plan § API contracts, crm-api): the same route learns
 * `entityType: "deal"`, answered with the people `involved` in the deal (its owner, plus the
 * technical contact as the deal view reads it) so hours-api can decide who may book time on it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import {
  PERSONAS,
  app,
  call,
  db,
  makeCompany,
  makeDeal,
  markEstimateReady,
  resetWorld,
  type PersonaName,
} from "../test-support/world";

beforeEach(resetWorld);

const URL = "/activity-host/v1/resolve";
const resolve = (as: PersonaName | null, ids: string[], related?: Record<string, string[]>) =>
  call("POST", URL, { as, body: { entityType: "company", ids, ...(related ? { related } : {}) } });

const makeContact = (companyId: string | null, firstName = "Ada", lastName = "Rossi") =>
  db.contact.create({ data: { companyId, firstName, lastName, createdBy: "seed", updatedBy: "seed" } });

const subOf = (header: string): string =>
  (JSON.parse(Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf-8")) as { sub: string }).sub;

describe("salesTeam (specs/20261110-activities US-9)", () => {
  it("is true for a caller who manages deals of at least one entity, false for a reader who does not", async () => {
    for (const [as, expected] of [["salesCh", true], ["admin", true], ["managerNoMoney", true], ["consultant", false], ["outsider", false]] as const) {
      const res = await resolve(as, []);
      expect(res.status).toBe(200);
      expect((res.json as { salesTeam: boolean }).salesTeam).toBe(expected);
    }
  });
});

describe("a caller who holds crm:access", () => {
  it("opens an existing company with label, href, writable and may (AC-8.1)", async () => {
    const company = await makeCompany({ name: "Acme SA" });
    const res = await resolve("consultant", [company.id]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      reader: true,
      salesTeam: false,
      items: [
        {
          id: company.id,
          state: "open",
          writable: true,
          label: "Acme SA",
          href: `/crm/companies/${company.id}`,
          may: { write: true, manage: true },
        },
      ],
      related: [],
    });
  });

  it("answers `missing` for an unknown company, with no label or href (AC-8.3)", async () => {
    const res = await resolve("consultant", ["nope"]);
    expect(res.json).toEqual({ reader: true, salesTeam: false, items: [{ id: "nope", state: "missing" }], related: [] });
  });

  it("answers a mixed batch in the order asked, once per distinct id", async () => {
    const a = await makeCompany({ name: "A" });
    const b = await makeCompany({ name: "B" });
    const res = await resolve("consultant", [b.id, "nope", a.id, b.id]);
    expect(res.json.items.map((i: { id: string; state: string }) => [i.id, i.state])).toEqual([
      [b.id, "open"],
      ["nope", "missing"],
      [a.id, "open"],
    ]);
  });

  it("reads are open to every holder: a company outside the caller's entity still opens (ADR 20261101-crm-tool-shape-and-authorization)", async () => {
    const company = await makeCompany({ entity: "welld_it" });
    expect(PERSONAS.salesCh.entity).toBe("welld_ch");
    expect((await resolve("salesCh", [company.id])).json.items[0].state).toBe("open");
  });

  it("returns the related contacts and deals of the asked companies, with parentId, label and href", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id, { title: "Website" });
    const contact = await makeContact(company.id);
    const res = await resolve("consultant", [company.id], { contact: [contact.id], deal: [deal.id] });
    expect(res.json.related).toHaveLength(2);
    expect(res.json.related).toContainEqual({
      type: "deal",
      id: deal.id,
      parentId: company.id,
      label: "Website",
      href: `/crm/deals/${deal.id}`,
    });
    expect(res.json.related).toContainEqual({
      type: "contact",
      id: contact.id,
      parentId: company.id,
      label: "Ada Rossi",
      href: `/crm/contacts/${contact.id}`,
    });
  });

  it("omits a contact or deal of ANOTHER company, one without a company and one that does not exist", async () => {
    const mine = await makeCompany();
    const other = await makeCompany();
    const foreignDeal = await makeDeal(other.id);
    const foreignContact = await makeContact(other.id);
    const orphan = await makeContact(null);
    const res = await resolve("consultant", [mine.id], {
      contact: [foreignContact.id, orphan.id, "nope"],
      deal: [foreignDeal.id, "nope"],
    });
    expect(res.status).toBe(200);
    expect(res.json.related).toEqual([]);
  });

  it("omits related rows when the asked company is missing", async () => {
    const other = await makeCompany();
    const deal = await makeDeal(other.id);
    const res = await resolve("consultant", ["nope"], { deal: [deal.id] });
    expect(res.json.related).toEqual([]);
  });

  it("`ids: []` answers only `reader`, even when related ids are sent", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id);
    const res = await resolve("consultant", [], { deal: [deal.id] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reader: true, salesTeam: false, items: [], related: [] });
  });
});

// ─── entityType: "deal" (specs/029 T7) ───────────────────────────────────────

const resolveDeals = (as: PersonaName | null, ids: string[], extra: Record<string, unknown> = {}) =>
  call("POST", URL, { as, body: { entityType: "deal", ids, ...extra } });

/** A deal owned by `salesCh` (user-sales-ch), so the owner is neither the caller nor the admin. */
const makeOwnedDeal = async (overrides: Record<string, unknown> = {}) => {
  const company = await makeCompany();
  return makeDeal(company.id, { title: "Platform rebuild", ...overrides }, "salesCh");
};

describe("entityType: deal (specs/029 AC-2.3)", () => {
  it("opens a deal with label, href, writable and may, `involved` being its owner when no estimate is linked", async () => {
    const deal = await makeOwnedDeal({ title: "Website relaunch" });
    const res = await resolveDeals("consultant", [deal.id]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      reader: true,
      items: [
        {
          id: deal.id,
          state: "open",
          writable: true,
          label: "Website relaunch",
          href: `/crm/deals/${deal.id}`,
          may: { write: true, manage: true },
          involved: [PERSONAS.salesCh.sub],
        },
      ],
    });
  });

  it("adds the technical contact to `involved` once an estimate is linked, ready or not (AC-2.3)", async () => {
    const ready = await makeOwnedDeal();
    await markEstimateReady(ready.id, PERSONAS.tech.sub);
    const requested = await makeOwnedDeal();
    await db.dealEstimate.create({
      data: {
        dealId: requested.id,
        estimateId: "est-requested",
        estimateName: "Requested estimate",
        technicalUserId: PERSONAS.tech.sub,
        state: "requested",
        requestedBy: PERSONAS.admin.sub,
      },
    });
    const res = await resolveDeals("consultant", [ready.id, requested.id]);
    expect(res.json.items.map((i: { involved: string[] }) => i.involved)).toEqual([
      [PERSONAS.salesCh.sub, PERSONAS.tech.sub],
      [PERSONAS.salesCh.sub, PERSONAS.tech.sub],
    ]);
    // The same two people the deal view names: the owner and `estimate.technical`.
    const view = (await call("GET", `/deals/${ready.id}`, { as: "consultant" })).json;
    expect([view.owner.id, view.estimate.technical.id]).toEqual(res.json.items[0].involved);
  });

  it("answers a won and a lost deal `open` like any other: the deal may be in any stage (A13)", async () => {
    const won = await makeOwnedDeal();
    const lost = await makeOwnedDeal();
    await db.deal.update({ where: { id: won.id }, data: { stage: "won", closedAt: new Date() } });
    await db.deal.update({ where: { id: lost.id }, data: { stage: "lost", closedAt: new Date(), lostReason: "Budget" } });
    const res = await resolveDeals("consultant", [won.id, lost.id]);
    expect(res.json.items.map((i: { state: string; writable: boolean }) => [i.state, i.writable])).toEqual([
      ["open", true],
      ["open", true],
    ]);
  });

  it("answers `missing` for an unknown deal, with no label, href or involved", async () => {
    const res = await resolveDeals("consultant", ["nope"]);
    expect(res.json).toEqual({ reader: true, items: [{ id: "nope", state: "missing" }] });
  });

  it("answers a mixed batch in the order asked, once per distinct id", async () => {
    const a = await makeOwnedDeal({ title: "A" });
    const b = await makeOwnedDeal({ title: "B" });
    const res = await resolveDeals("consultant", [b.id, "nope", a.id, b.id]);
    expect(res.json.items.map((i: { id: string; state: string }) => [i.id, i.state])).toEqual([
      [b.id, "open"],
      ["nope", "missing"],
      [a.id, "open"],
    ]);
  });

  it("opens a deal of another entity for any holder: reads are open and entity scope plays no part (ADR-0052)", async () => {
    const company = await makeCompany({ entity: "welld_it" });
    const deal = await makeDeal(company.id, { entity: "welld_it" }, "admin");
    expect(PERSONAS.salesCh.entity).toBe("welld_ch");
    const res = await resolveDeals("salesCh", [deal.id]);
    expect(res.json.items[0]).toMatchObject({ state: "open", involved: [PERSONAS.admin.sub] });
  });

  it("`ids: []` answers only `reader`", async () => {
    expect((await resolveDeals("consultant", [])).json).toEqual({ reader: true, items: [] });
  });

  it("lists a person once when the owner is also the technical contact", async () => {
    const deal = await makeOwnedDeal();
    await markEstimateReady(deal.id, PERSONAS.salesCh.sub);
    expect((await resolveDeals("consultant", [deal.id])).json.items[0].involved).toEqual([PERSONAS.salesCh.sub]);
  });

  it("an override row with no estimate (estimateId \"\") adds no technical contact, and the deal view shows none either (AC-2.3)", async () => {
    const deal = await makeOwnedDeal();
    const overridden = await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "Framework contract" } });
    expect(overridden.status).toBe(200);
    // The premise: the row exists, names the overriding admin in `technicalUserId`, and links nothing.
    expect(await db.dealEstimate.findUniqueOrThrow({ where: { dealId: deal.id } })).toMatchObject({
      estimateId: "",
      technicalUserId: PERSONAS.admin.sub,
    });
    expect((await call("GET", `/deals/${deal.id}`, { as: "consultant" })).json.estimate).toBeNull();

    const res = await resolveDeals("consultant", [deal.id]);
    expect(res.json.items[0].involved).toEqual([PERSONAS.salesCh.sub]);
  });

  it("an unlinked estimate whose override stays no longer counts its old technical contact", async () => {
    const deal = await makeOwnedDeal();
    await markEstimateReady(deal.id, PERSONAS.tech.sub);
    expect((await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "Framework contract" } })).status).toBe(200);
    // Still linked and overridden: the deal view shows the technical contact, so `involved` does too.
    expect((await resolveDeals("consultant", [deal.id])).json.items[0].involved).toEqual([PERSONAS.salesCh.sub, PERSONAS.tech.sub]);

    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(200);
    // The unlink keeps the row (and its stale `technicalUserId`) for the override's sake.
    expect(await db.dealEstimate.findUniqueOrThrow({ where: { dealId: deal.id } })).toMatchObject({
      estimateId: "",
      technicalUserId: PERSONAS.tech.sub,
    });
    expect((await resolveDeals("consultant", [deal.id])).json.items[0].involved).toEqual([PERSONAS.salesCh.sub]);
  });
});

describe("a caller without crm:access", () => {
  it("gets `reader:false` and nothing about any record (AC-8.3)", async () => {
    const company = await makeCompany({ name: "Secret SA" });
    const deal = await makeDeal(company.id, { title: "Secret deal" });
    const res = await resolve("outsider", [company.id, "nope"], { deal: [deal.id] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reader: false, salesTeam: false, items: [], related: [] });
    expect(JSON.stringify(res.json)).not.toContain("Secret");
  });

  it("`ids: []` still answers `reader:false`", async () => {
    expect((await resolve("outsider", [])).json).toEqual({ reader: false, salesTeam: false, items: [], related: [] });
  });

  it("for a deal gets `reader:false` and nothing: the same body whether the deal exists or not, no title, owner or technical contact (AC-2.10, AC-4.10)", async () => {
    const deal = await makeOwnedDeal({ title: "Secret deal" });
    await markEstimateReady(deal.id, PERSONAS.tech.sub);
    const real = await resolveDeals("outsider", [deal.id]);
    const unknown = await resolveDeals("outsider", ["nope"]);
    expect(real.status).toBe(200);
    expect(real.json).toEqual({ reader: false, items: [] });
    expect(unknown.json).toEqual(real.json);
    expect(JSON.stringify(real.json)).not.toContain("Secret");
    expect(JSON.stringify(real.json)).not.toContain(PERSONAS.salesCh.sub);
    expect(JSON.stringify(real.json)).not.toContain(PERSONAS.tech.sub);
    expect((await resolveDeals("outsider", [])).json).toEqual({ reader: false, items: [] });
  });

  it("is a reader for a deal exactly when it is one for a company: `crm:access` alone, no deal:manage needed", async () => {
    const deal = await makeOwnedDeal();
    expect(PERSONAS.consultant.permissions.some((p) => p.resource === "deal")).toBe(false);
    expect((await resolveDeals("consultant", [deal.id])).json.items[0].state).toBe("open");
  });

  it("stops being a reader the moment the grant goes: a new perm_epoch is a fresh live resolve", async () => {
    const company = await makeCompany();
    expect((await resolve("consultant", [company.id])).json.reader).toBe(true);
    const harness = setupTestAuth();
    try {
      harness.setResolve(async (header) => ({ sub: subOf(header), epoch: 1, permissions: [], entity: "welld_ch", jobTitle: null }));
      const token = await harness.signToken({ sub: PERSONAS.consultant.sub, email: "c@welld.test", permEpoch: 1 });
      const res = await app.request(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "company", ids: [company.id] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reader: false, salesTeam: false, items: [], related: [] });
    } finally {
      harness.setResolve(async (header) => {
        const persona = Object.values(PERSONAS).find((p) => p.sub === subOf(header))!;
        return { sub: persona.sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
  });
});

describe("failure modes", () => {
  it("401 without a token", async () => {
    expect((await resolve(null, ["x"])).status).toBe(401);
  });

  it("503 when `auth` cannot resolve the caller: fail closed, never a reader", async () => {
    const company = await makeCompany();
    const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
    __resetAuthzCacheForTests();
    const harness = setupTestAuth();
    try {
      harness.setResolve(async () => {
        throw new Error("auth down");
      });
      const res = await resolve("admin", [company.id]);
      expect(res.status).toBe(503);
      expect(res.json.reader).toBeUndefined();
    } finally {
      harness.setResolve(async (header) => {
        const persona = Object.values(PERSONAS).find((p) => p.sub === subOf(header))!;
        return { sub: persona.sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
  });

  it("deal: 503 when `auth` cannot resolve the caller: fail closed, never a reader and no deal answered", async () => {
    const deal = await makeOwnedDeal();
    const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
    __resetAuthzCacheForTests();
    const harness = setupTestAuth();
    try {
      harness.setResolve(async () => {
        throw new Error("auth down");
      });
      const res = await resolveDeals("admin", [deal.id]);
      expect(res.status).toBe(503);
      expect(res.json.reader).toBeUndefined();
      expect(res.json.items).toBeUndefined();
    } finally {
      harness.setResolve(async (header) => {
        const persona = Object.values(PERSONAS).find((p) => p.sub === subOf(header))!;
        return { sub: persona.sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
  });

  it("deal: 401 without a token", async () => {
    expect((await resolveDeals(null, ["x"])).status).toBe(401);
  });

  it("deal: 422 for 26 ids, 25 are fine", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    const over = await resolveDeals("consultant", ids(26));
    expect(over.status).toBe(422);
    expect(over.json.field).toBe("ids");
    const ok = await resolveDeals("consultant", ids(25));
    expect(ok.status).toBe(200);
    expect(ok.json.items).toHaveLength(25);
  });

  it("deal: 422 when `related` is sent, even an empty one: it belongs to companies only", async () => {
    const deal = await makeOwnedDeal();
    const withRelated = await resolveDeals("consultant", [deal.id], { related: { deal: [deal.id] } });
    expect(withRelated.status).toBe(422);
    expect(withRelated.json.items).toBeUndefined();
    expect((await resolveDeals("consultant", [deal.id], { related: {} })).status).toBe(422);
    // The refusal does not depend on the grant: a non-reader is told the same, and nothing else.
    expect((await resolveDeals("outsider", [deal.id], { related: {} })).status).toBe(422);
  });

  it("deal: 422 for an empty, oversized or NUL-carrying id, a missing `ids` or an extra key", async () => {
    expect((await resolveDeals("consultant", [""])).status).toBe(422);
    expect((await resolveDeals("consultant", ["x".repeat(65)])).status).toBe(422);
    const nul = await resolveDeals("consultant", ["ok", "de\u0000al"]);
    expect(nul.status).toBe(422);
    expect(nul.json.field).toBe("ids.1");
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "deal" } })).status).toBe(422);
    expect((await resolveDeals("consultant", ["x"], { extra: 1 })).status).toBe(422);
  });

  it("422 for 26 ids, 25 are fine", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    const over = await resolve("consultant", ids(26));
    expect(over.status).toBe(422);
    expect(over.json.field).toBe("ids");
    const ok = await resolve("consultant", ids(25));
    expect(ok.status).toBe(200);
    expect(ok.json.items).toHaveLength(25);
  });

  it("422 for more than 100 related ids of a type, 100 are fine", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    expect((await resolve("consultant", ["x"], { contact: ids(101) })).status).toBe(422);
    expect((await resolve("consultant", ["x"], { deal: ids(101) })).status).toBe(422);
    expect((await resolve("consultant", ["x"], { contact: ids(100), deal: ids(100) })).status).toBe(200);
  });

  it("422 for an empty or oversized id, an unknown entity type, a missing field or an extra key", async () => {
    expect((await resolve("consultant", [""])).status).toBe(422);
    expect((await resolve("consultant", ["x".repeat(65)])).status).toBe(422);
    expect((await resolve("consultant", ["x"], { project: ["p"] })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "project", ids: ["x"] } })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { ids: ["x"] } })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "company" } })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "company", ids: [], extra: 1 } })).status).toBe(422);
  });

  it("422 for a NUL character in any id: Postgres text cannot hold it, so it is refused before the lookup, never a 500 (security re-review)", async () => {
    const nul = "co\u0000mpany";
    const asked = await resolve("consultant", [nul]);
    expect(asked.status).toBe(422);
    expect(asked.json.field).toBe("ids.0");
    expect((await resolve("consultant", ["x"], { contact: [nul] })).status).toBe(422);
    expect((await resolve("consultant", ["x"], { deal: ["ok", nul] })).status).toBe(422);
    // A caller without the grant is refused the same way: validation runs before the grant is read.
    expect((await resolve("outsider", [nul])).status).toBe(422);
  });

  it("a validation failure for a caller without crm:access still reveals nothing", async () => {
    const res = await resolve("outsider", Array.from({ length: 26 }, (_, i) => `id-${i}`));
    expect(res.status).toBe(422);
    expect(res.json.items).toBeUndefined();
  });
});
