/**
 * The CRM's entity settings keep only the CRM's own values (specs/20261117-legal-entities T29; AC-6.1): the offer terms and the
 * place of issue. The issuer's legal details live in the registry in auth. The four legacy keys (`legalName`, `addressLines`,
 * `vatNumber`, `iban`) are accepted and ignored until the contract step (plan, step 6) so an old crm-ui still saves during the
 * switch push; the columns stay in the table and are neither read nor changed here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, resetWorld } from "../test-support/world";

const LEGACY = ["legalName", "addressLines", "vatNumber", "iban"] as const;
const OWN = { offerTermsEn: "Payment within 30 days.", offerTermsIt: "Pagamento a 30 giorni.", placeOfIssue: "Zug" };
const LEGACY_VALUES = { legalName: "Old Name SA", addressLines: ["Old street 1", "6900 Lugano"], vatNumber: "CHE-1", iban: "CH00 0000" };

const put = (body: unknown, entity = "welld_ch", as: "admin" | "salesCh" = "admin") => call("PUT", `/entity-profiles/${entity}`, { as, body });
const row = (entity = "welld_ch") => db.entityProfile.findUniqueOrThrow({ where: { entity: entity as "welld_ch" } });

beforeEach(resetWorld);

describe("PUT /entity-profiles/{entity} with only the CRM's own values", () => {
  it("creates the row, takes the column defaults for the retired columns, and answers without the legal keys", async () => {
    const res = await put(OWN);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ entity: "welld_ch", ...OWN, letterhead: null });
    for (const key of LEGACY) expect(res.json).not.toHaveProperty(key);
    expect(await row()).toMatchObject({ legalName: "", addressLines: [], vatNumber: null, iban: null, ...OWN });
  });

  it("updates the row, replacing the terms and place whole as before", async () => {
    await put(OWN);
    const res = await put({ offerTermsEn: "Net 60.", placeOfIssue: "  " });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ offerTermsEn: "Net 60.", offerTermsIt: null, placeOfIssue: null });
    expect(await row()).toMatchObject({ offerTermsEn: "Net 60.", offerTermsIt: null, placeOfIssue: null });
  });

  it("an empty body is a valid save of nothing but the defaults", async () => {
    expect((await put({})).status).toBe(200);
    expect(await row()).toMatchObject({ offerTermsEn: null, offerTermsIt: null, placeOfIssue: null });
  });

  it("an update leaves the retired columns exactly as they were (nothing is dropped or blanked)", async () => {
    await put(OWN);
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: LEGACY_VALUES });
    expect((await put({ ...OWN, placeOfIssue: "Lugano" })).status).toBe(200);
    expect(await row()).toMatchObject({ ...LEGACY_VALUES, placeOfIssue: "Lugano" });
  });

  it("keeps the guards: 401 without a token, 403 out of scope, 403 for a reader", async () => {
    expect((await call("PUT", "/entity-profiles/welld_ch", { as: null, body: OWN })).status).toBe(401);
    expect((await put(OWN, "welld_it", "salesCh")).json.code).toBe("out_of_scope");
    expect((await call("PUT", "/entity-profiles/welld_ch", { as: "consultant", body: OWN })).status).toBe(403);
    expect(await db.entityProfile.count()).toBe(0);
  });
});

describe("the four legacy keys are accepted and not stored", () => {
  it("on a new row: 200, the columns take their defaults, the answer has none of them", async () => {
    const res = await put({ ...OWN, ...LEGACY_VALUES });
    expect(res.status).toBe(200);
    for (const key of LEGACY) expect(res.json).not.toHaveProperty(key);
    expect(await row()).toMatchObject({ legalName: "", addressLines: [], vatNumber: null, iban: null, ...OWN });
  });

  it("on an existing row: the stored values stay, whatever an old crm-ui sends", async () => {
    await put(OWN);
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: LEGACY_VALUES });
    const res = await put({ ...OWN, legalName: "Changed", addressLines: ["x"], vatNumber: null, iban: "" });
    expect(res.status).toBe(200);
    expect(await row()).toMatchObject(LEGACY_VALUES);
  });

  it("whatever they hold: null, the wrong type, an empty or oversized value is no refusal", async () => {
    for (const legacy of [
      { legalName: null, addressLines: null, vatNumber: null, iban: null },
      { legalName: 5, addressLines: "not a list", vatNumber: { a: 1 }, iban: [] },
      { legalName: "", addressLines: [], vatNumber: "", iban: "" },
      { legalName: "x".repeat(5_000), addressLines: Array.from({ length: 20 }, () => "line"), vatNumber: "y".repeat(500), iban: "z".repeat(500) },
    ]) {
      expect((await put({ ...OWN, ...legacy })).status).toBe(200);
    }
    expect(await row()).toMatchObject({ legalName: "", addressLines: [], ...OWN });
  });

  it("each key alone is accepted too", async () => {
    for (const key of LEGACY) expect((await put({ ...OWN, [key]: LEGACY_VALUES[key] })).status).toBe(200);
  });

  it("the own fields beside them are still validated", async () => {
    const res = await put({ ...LEGACY_VALUES, placeOfIssue: "x".repeat(101) });
    expect(res.status).toBe(422);
  });
});

describe("any other unknown key is refused as before", () => {
  it("422, naming nothing stored", async () => {
    for (const extra of [{ foo: 1 }, { legalname: "typo" }, { vat: "CHE-1" }, { entity: "welld_it" }, { letterheadKey: "k" }, { updatedBy: "x" }]) {
      const res = await put({ ...OWN, ...extra });
      expect(res.status).toBe(422);
    }
    expect(await db.entityProfile.count()).toBe(0);
  });

  it("is refused even beside the legacy keys", async () => {
    expect((await put({ ...OWN, ...LEGACY_VALUES, foo: 1 })).status).toBe(422);
    expect(await db.entityProfile.count()).toBe(0);
  });
});

describe("GET /entity-profiles", () => {
  it("has no legalName, addressLines, vatNumber or iban, even where the retired columns hold values", async () => {
    await put(OWN);
    await put(OWN, "welld_it");
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: LEGACY_VALUES });
    const res = await call("GET", "/entity-profiles");
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(2);
    for (const item of res.json.items) {
      for (const key of LEGACY) expect(item).not.toHaveProperty(key);
      expect(Object.keys(item).sort()).toEqual(["entity", "letterhead", "offerTermsEn", "offerTermsIt", "placeOfIssue", "updatedAt"]);
    }
    expect(JSON.stringify(res.json)).not.toContain("Old Name SA");
  });

  it("says in OpenAPI that the answer has none of them and that the body's legacy keys are deprecated", async () => {
    const doc = (await call("GET", "/openapi.json", { as: null })).json;
    const body = doc.paths["/entity-profiles/{entity}"].put.requestBody.content["application/json"].schema;
    for (const key of LEGACY) expect(body.properties[key].deprecated).toBe(true);
    const profile = doc.paths["/entity-profiles"].get.responses["200"].content["application/json"].schema.properties.items.items;
    for (const key of LEGACY) expect(profile.properties).not.toHaveProperty(key);
  });
});

describe("the letterhead routes without a profile row (E4)", () => {
  it("start and confirm still answer 409 entity_profile_missing, and the read 404", async () => {
    const start = await call("POST", "/entity-profiles/welld_ch/letterhead");
    expect(start.status).toBe(409);
    expect(start.json).toMatchObject({ code: "entity_profile_missing", entity: "welld_ch" });
    const key = `letterheads/welld_ch/${crypto.randomUUID()}.pdf`;
    const confirm = await call("POST", "/entity-profiles/welld_ch/letterhead/confirm", { body: { key } });
    expect(confirm.status).toBe(409);
    expect(confirm.json).toMatchObject({ code: "entity_profile_missing", entity: "welld_ch" });
    expect((await call("GET", "/entity-profiles/welld_ch/letterhead")).status).toBe(404);
    expect(await db.entityProfile.count()).toBe(0);
  });

  it("a row made by the new PUT is enough to start an upload", async () => {
    await put(OWN);
    expect((await call("POST", "/entity-profiles/welld_ch/letterhead")).status).toBe(201);
  });
});
