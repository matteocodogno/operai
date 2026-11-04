/**
 * `POST /meeting-host/v1/resolve` (specs/021 T7; AC-1.5, AC-5.6, AC-5.7, AC-11.5;
 * ADR-0059): "may THIS caller open these deals?", answered live from the caller's
 * own forwarded JWT. A caller without `crm:access` gets `closed` for deals that
 * exist and `missing` for the rest (a 200, not a 403, so one call answers a mixed
 * batch); a holder gets `open` + title + href, and `hostVisible` mirrors
 * `deal:financials`. An `auth` outage is a 503 (fail closed).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import { PERSONAS, app, call, makeCompany, makeDeal, resetWorld, type PersonaName } from "../test-support/world";

beforeEach(resetWorld);

const URL = "/meeting-host/v1/resolve";
const resolve = (as: PersonaName | null, ids: string[], extra: Record<string, unknown> = {}) =>
  call("POST", URL, { as, body: { entityType: "deal", ids, ...extra } });

const subOf = (header: string): string =>
  (JSON.parse(Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf-8")) as { sub: string }).sub;

describe("a caller who holds crm:access", () => {
  it("opens an existing deal with its title and href (AC-1.5)", async () => {
    const deal = await makeDeal((await makeCompany()).id, { title: "Platform rebuild" });
    const res = await resolve("consultant", [deal.id]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [{ id: deal.id, state: "open", title: "Platform rebuild", href: `/crm/deals/${deal.id}`, hostVisible: false }],
    });
  });

  it("answers `missing` for an id that is no deal, with no title, href or hostVisible (AC-11.5)", async () => {
    const res = await resolve("consultant", ["nope"]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [{ id: "nope", state: "missing" }] });
  });

  it("answers a mixed batch in one call, in the order asked, once per distinct id", async () => {
    const company = await makeCompany();
    const a = await makeDeal(company.id, { title: "A" });
    const b = await makeDeal(company.id, { title: "B" });
    const res = await resolve("consultant", [b.id, "nope", a.id, b.id]);
    expect(res.json.items.map((i: { id: string; state: string }) => [i.id, i.state])).toEqual([
      [b.id, "open"],
      ["nope", "missing"],
      [a.id, "open"],
    ]);
  });

  it("reads are open to every holder: a deal outside the caller's entity scope still opens (ADR-0052)", async () => {
    const deal = await makeDeal((await makeCompany({ entity: "welld_it" })).id, { entity: "welld_it" });
    expect(PERSONAS.salesCh.entity).toBe("welld_ch");
    expect((await resolve("salesCh", [deal.id])).json.items[0].state).toBe("open");
  });

  it("hostVisible follows deal:financials alone (AC-5.6)", async () => {
    const deal = await makeDeal((await makeCompany()).id);
    const visible = async (as: PersonaName) => (await resolve(as, [deal.id])).json.items[0].hostVisible;
    expect(await visible("consultant")).toBe(false);
    expect(await visible("tech")).toBe(false);
    expect(await visible("managerNoMoney")).toBe(false);
    expect(await visible("salesCh")).toBe(true);
    expect(await visible("admin")).toBe(true);
  });
});

describe("a caller without crm:access", () => {
  it("gets `closed` for a deal that exists and `missing` for one that does not, never a title (AC-5.7)", async () => {
    const deal = await makeDeal((await makeCompany()).id, { title: "Secret deal" });
    const res = await resolve("outsider", [deal.id, "nope"]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: deal.id, state: "closed" },
        { id: "nope", state: "missing" },
      ],
    });
    expect(JSON.stringify(res.json)).not.toContain("Secret deal");
  });

  it("stops opening the moment the grant goes: a new perm_epoch is a fresh live resolve (AC-5.7)", async () => {
    const deal = await makeDeal((await makeCompany()).id);
    expect((await resolve("consultant", [deal.id])).json.items[0].state).toBe("open");
    const harness = setupTestAuth();
    try {
      harness.setResolve(async (header) => ({ sub: subOf(header), epoch: 1, permissions: [], entity: "welld_ch", jobTitle: null }));
      const token = await harness.signToken({ sub: PERSONAS.consultant.sub, email: "c@welld.test", permEpoch: 1 });
      const res = await app.request(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "deal", ids: [deal.id] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [{ id: deal.id, state: "closed" }] });
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

  it("503 when `auth` cannot resolve the caller: fail closed, never an `open` (AC-11.5)", async () => {
    const deal = await makeDeal((await makeCompany()).id);
    const harness = setupTestAuth();
    try {
      harness.setResolve(async () => {
        throw new Error("auth down");
      });
      const res = await resolve("admin", [deal.id]);
      expect(res.status).toBe(503);
      expect(res.json.items).toBeUndefined();
    } finally {
      harness.setResolve(async (header) => {
        const persona = Object.values(PERSONAS).find((p) => p.sub === subOf(header))!;
        return { sub: persona.sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
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

  it("422 for no ids, an empty or oversized id, an unknown entity type, a missing field or an extra key", async () => {
    expect((await resolve("consultant", [])).status).toBe(422);
    expect((await resolve("consultant", [""])).status).toBe(422);
    expect((await resolve("consultant", ["x".repeat(65)])).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "company", ids: ["x"] } })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { ids: ["x"] } })).status).toBe(422);
    expect((await call("POST", URL, { as: "consultant", body: { entityType: "deal" } })).status).toBe(422);
    expect((await resolve("consultant", ["x"], { includeMoney: true })).status).toBe(422);
  });

  it("a validation failure for a caller without crm:access still reveals nothing about any deal", async () => {
    const res = await resolve("outsider", []);
    expect(res.status).toBe(422);
    expect(res.json.items).toBeUndefined();
  });
});
