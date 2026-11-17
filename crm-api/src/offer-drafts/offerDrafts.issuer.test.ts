/**
 * The issuer's name, address and letterhead in the wizard (specs/20261115-crm-offer-wizard T62; AC-12.2, AC-12.4,
 * AC-12.7, AC-11.3, AC-11.7, AC-11.8; DD-54, DD-61): the context route's `issuerLegalName`, `issuerAddressLines` and
 * `letterhead`, a blank legal name refused at generate only, the `no-store` letterhead link, and the snapshot rule.
 */

// The test world first: it sets the environment the other modules read when they load.
import {
  bucket,
  call,
  db,
  DRAFT_SOURCE,
  ENTITY_PROFILE,
  setRetiredLegalColumns,
  makeDraftTemplate,
  readyDealWithProfiles,
  resetWorld,
} from "../test-support/world";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { resetLetterheadMemoForTests } from "../entity-profiles/letterheadUse";

beforeEach(resetWorld);
afterEach(() => spyOn(console, "log").mockRestore());

const noMatch = { "If-None-Match": "*" };
const contextOf = (dealId: string) => call("GET", `/deals/${dealId}/offer-wizard/context`);
const generate = (dealId: string, version: number) => call("POST", `/deals/${dealId}/offer-draft/generate`, { ifMatch: version });

/** A template that prints the issuer's name and address in a section of the offer. */
const ISSUER_SOURCE = `${DRAFT_SOURCE.replace("Epiche: [EPICI]", "Epiche: [EPICI]\n\nEmittente: [EMITTENTE] / [INDIRIZZO]")}\n@@field EMITTENTE\nsource: issuer\n\n@@field INDIRIZZO\nsource: issuerAddress\n`;

async function draftFor(source?: string) {
  const { deal } = await readyDealWithProfiles();
  const template = await makeDraftTemplate(source ? { source } : {});
  const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  return { dealId: deal.id, draft: created.json };
}

describe("the context route's issuer and letterhead (AC-12.2, AC-11.3)", () => {
  it("carries the profile's legal name, its address lines as saved and letterhead: false without one", async () => {
    const { deal } = await readyDealWithProfiles();
    const res = await contextOf(deal.id);
    expect(res.status).toBe(200);
    expect(res.json.issuerLegalName).toBe("wellD SA");
    expect(res.json.issuerAddressLines).toEqual(["Via Example 1", "6900 Lugano"]);
    expect(res.json.letterhead).toBe(false);
  });

  it("says letterhead: true once the profile has one, and never carries a link or the key (AC-11.3)", async () => {
    const { deal } = await readyDealWithProfiles();
    const key = "letterheads/welld_ch/11111111-1111-4111-8111-111111111111.pdf";
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: key, letterheadAt: new Date(), letterheadBy: "user-admin" } });
    const res = await contextOf(deal.id);
    expect(res.json.letterhead).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain(key);
    expect(JSON.stringify(res.json)).not.toMatch(/https?:/);
  });

  it("is in the OpenAPI schema of the route", async () => {
    const doc = await call("GET", "/openapi.json", { as: null });
    const schema = doc.json.paths["/deals/{id}/offer-wizard/context"].get.responses["200"].content["application/json"].schema;
    const properties = schema.properties ?? schema.allOf?.flatMap((part: { properties?: object }) => Object.keys(part.properties ?? {}));
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["issuerLegalName", "issuerAddressLines", "letterhead"]));
  });
});

describe("a blank legal name (AC-12.7, DD-61)", () => {
  it("leaves the context route answering and the draft saveable, with the name as stored", async () => {
    const s = await draftFor();
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { legalName: "   " } });
    const context = await contextOf(s.dealId);
    expect(context.status).toBe(200);
    expect(context.json.issuerLegalName.trim()).toBe("");
    const saved = await call("PUT", `/deals/${s.dealId}/offer-draft`, {
      ifMatch: s.draft.version,
      body: { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers: s.draft.answers },
    });
    expect(saved.status).toBe(200);
  });

  it("refuses generate with 409 entity_profile_missing, like an absent profile, and changes nothing", async () => {
    const s = await draftFor();
    for (const legalName of ["", "  \t "]) {
      await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { legalName } });
      const res = await generate(s.dealId, s.draft.version);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: "entity_profile_missing", entity: "welld_ch" });
    }
    expect(await db.dealOffer.count()).toBe(0);
    expect(await db.offerDraft.count()).toBe(1);
    expect([...bucket.objects.keys()].filter((key) => key.startsWith("offers/"))).toEqual([]);
    expect(bucket.reads).toEqual([]);
  });

  it("generates again once the name is set", async () => {
    const s = await draftFor();
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { legalName: " " } });
    expect((await generate(s.dealId, s.draft.version)).status).toBe(409);
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { legalName: "wellD SA" } });
    expect((await generate(s.dealId, s.draft.version)).status).toBe(201);
  });
});

describe("GET /entity-profiles/{entity}/letterhead (AC-11.7, AC-11.8, DD-54)", () => {
  const KEY = "letterheads/welld_ch/22222222-2222-4222-8222-222222222222.pdf";
  // The link route checks the stored file once per key (T71, DD-76): the bucket holds a real one-page A4 letterhead.
  const withLetterhead = async () => {
    resetLetterheadMemoForTests();
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]).drawLine({ start: { x: 10, y: 10 }, end: { x: 100, y: 10 } });
    const bytes = await doc.save();
    bucket.objects.set(KEY, { bytes, contentType: "application/pdf", sizeBytes: bytes.byteLength });
    return db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: KEY, letterheadAt: new Date(), letterheadBy: "user-admin" } });
  };

  it("answers the link with Cache-Control: no-store", async () => {
    await readyDealWithProfiles();
    await withLetterhead();
    const res = await call("GET", "/entity-profiles/welld_ch/letterhead", { as: "salesCh" });
    expect(res.status).toBe(200);
    expect(res.json.url).toContain("22222222-2222-4222-8222-222222222222.pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never writes the link to a log", async () => {
    await readyDealWithProfiles();
    await withLetterhead();
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const res = await call("GET", "/entity-profiles/welld_ch/letterhead");
    const logged = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    expect(logged).toContain("GET /entity-profiles/welld_ch/letterhead 200");
    expect(logged).not.toContain(res.json.url);
    expect(logged).not.toContain("22222222-2222");
    error.mockRestore();
  });
});

describe("the issuer's text in a generated offer (AC-12.4)", () => {
  const stored = async (dealId: string) => JSON.stringify((await db.dealOffer.findMany({ where: { dealId }, orderBy: { number: "asc" } })).map((row) => row.snapshot));
  const rename = async (legalName: string) => {
    await setRetiredLegalColumns("welld_ch", { legalName, addressLines: ["Via Nuova 9"] });
    return call("PUT", "/entity-profiles/welld_ch", { body: { offerTermsEn: ENTITY_PROFILE.offerTermsEn, offerTermsIt: ENTITY_PROFILE.offerTermsIt } });
  };

  it("prints the profile's name and address, keeps them in the snapshot when the profile changes, and prints the current ones on a revision", async () => {
    const s = await draftFor(ISSUER_SOURCE);
    const made = await generate(s.dealId, s.draft.version);
    expect(made.status).toBe(201);
    expect(await stored(s.dealId)).toContain("Emittente: wellD SA / Via Example 1, 6900 Lugano");

    expect((await rename("wellD Nuova SA")).status).toBe(200);
    const afterRename = await stored(s.dealId);
    expect(afterRename).toContain("Emittente: wellD SA / Via Example 1, 6900 Lugano");
    expect(afterRename).not.toContain("wellD Nuova SA");

    // the sent offer is revised: the revision is written today, with today's name and address
    expect((await call("POST", `/deals/${s.dealId}/offers/${made.json.id}/sent`)).status).toBe(200);
    const revision = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "revision", offerId: made.json.id } }, headers: noMatch });
    expect(revision.status).toBe(201);
    const revised = await generate(s.dealId, revision.json.version);
    expect(revised.status).toBe(201);
    const rows = await db.dealOffer.findMany({ where: { dealId: s.dealId }, orderBy: { number: "asc" } });
    expect(JSON.stringify(rows[0]!.snapshot)).toContain("Emittente: wellD SA / Via Example 1, 6900 Lugano");
    expect(JSON.stringify(rows[1]!.snapshot)).toContain("Emittente: wellD Nuova SA / Via Nuova 9");
    expect(JSON.stringify(rows[1]!.snapshot)).not.toContain("Emittente: wellD SA /");
  });

  it("an edit of an unsent offer prints the current name and address", async () => {
    const s = await draftFor(ISSUER_SOURCE);
    const made = await generate(s.dealId, s.draft.version);
    expect(made.status).toBe(201);
    expect((await rename("wellD Nuova SA")).status).toBe(200);
    const edit = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: made.json.id } }, headers: noMatch });
    expect(edit.status).toBe(201);
    expect((await generate(s.dealId, edit.json.version)).status).toBe(200);
    expect(await stored(s.dealId)).toContain("Emittente: wellD Nuova SA / Via Nuova 9");
  });
});
