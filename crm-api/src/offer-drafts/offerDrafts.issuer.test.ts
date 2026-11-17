/**
 * The issuer's name, address and letterhead in the wizard (specs/20261115-crm-offer-wizard T62; AC-12.2, AC-12.4,
 * AC-12.7, AC-11.3, AC-11.7, AC-11.8; DD-54, DD-61): the context route's `issuerLegalName`, `issuerAddress`, `issuerAddressLines` and
 * `letterhead`, an incomplete issuer refused at generate only, the `no-store` letterhead link, and the snapshot rule.
 *
 * The issuer is the legal entities registry's (specs/20261117-legal-entities T26; AC-5.5, AC-6.2, AC-6.3, AC-7.3, plan E4): the
 * world's fake registry holds the details, the CRM's own profile row only the terms, the place of issue and the letterhead.
 */

// The test world first: it sets the environment the other modules read when they load.
import {
  bucket,
  call,
  db,
  DRAFT_SOURCE,
  makeDraftTemplate,
  makeReadyDeal,
  readyDealWithProfiles,
  registry,
  resetWorld,
  worldIssuer,
} from "../test-support/world";
import { completeEntity, incompleteEntity } from "../test-support/fakeRegistry";
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
  it("carries the registry's legal name, its address in both languages (issuerAddress) and the Italian lines (issuerAddressLines), letterhead: false without one", async () => {
    const { deal } = await readyDealWithProfiles();
    registry.set(worldIssuer("welld_ch"));
    registry.set(completeEntity("welld_ch", { legalName: "wellD SA", address: { it: ["Via Cantonale 1", "6900 Lugano", "Svizzera"], en: ["Via Cantonale 1", "6900 Lugano", "Switzerland"] } }));
    const res = await contextOf(deal.id);
    expect(res.status).toBe(200);
    expect(res.json.issuerLegalName).toBe("wellD SA");
    expect(res.json.issuerAddress).toEqual({ it: ["Via Cantonale 1", "6900 Lugano", "Svizzera"], en: ["Via Cantonale 1", "6900 Lugano", "Switzerland"] });
    expect(res.json.issuerAddressLines).toEqual(["Via Cantonale 1", "6900 Lugano", "Svizzera"]);
    expect(res.json.letterhead).toBe(false);
  });

  it("answers 200 for an incomplete entity, with the values as they are (an autosave is never refused)", async () => {
    const { deal } = await readyDealWithProfiles();
    registry.set(incompleteEntity("welld_ch", ["vatNumber", "address.en"], { address: { it: ["Via Nuova 9"], en: [] } }));
    const res = await contextOf(deal.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ issuerLegalName: "wellD SA", issuerAddress: { it: ["Via Nuova 9"], en: [] }, issuerAddressLines: ["Via Nuova 9"] });
  });

  it("answers 200 for a deal whose entity has no profile row: place Lugano, no letterhead (E4)", async () => {
    const { deal } = await makeReadyDeal();
    expect(await db.entityProfile.count()).toBe(0);
    const res = await contextOf(deal.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ issuerLegalName: "wellD SA", placeOfIssue: "Lugano", letterhead: false });
  });

  it("is 503 legal_entities_unavailable with Retry-After: 5 when the registry cannot be read", async () => {
    const { deal } = await readyDealWithProfiles();
    registry.unavailable();
    const res = await contextOf(deal.id);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("legal_entities_unavailable");
    expect(res.headers.get("Retry-After")).toBe("5");
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
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["issuerLegalName", "issuerAddress", "issuerAddressLines", "letterhead"]));
  });
});

describe("an incomplete issuer (AC-12.7, AC-6.3, AC-7.3; DD-61)", () => {
  it("leaves the context route answering and the draft saveable, with the name as the registry has it", async () => {
    const s = await draftFor();
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: "   " }));
    const context = await contextOf(s.dealId);
    expect(context.status).toBe(200);
    expect(context.json.issuerLegalName.trim()).toBe("");
    const saved = await call("PUT", `/deals/${s.dealId}/offer-draft`, {
      ifMatch: s.draft.version,
      body: { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers: s.draft.answers },
    });
    expect(saved.status).toBe(200);
  });

  it("refuses generate with 409 legal_entity_incomplete naming what is missing, and changes nothing: no number is used", async () => {
    const s = await draftFor();
    for (const [missing, patch] of [
      [["legalName"], { legalName: "" }],
      [["vatNumber", "address.en"], { vatNumber: "" }],
    ] as const) {
      registry.set(incompleteEntity("welld_ch", [...missing], patch));
      const res = await generate(s.dealId, s.draft.version);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: "legal_entity_incomplete", entity: "welld_ch", missing });
      expect(res.json.code).not.toBe("entity_profile_missing");
    }
    expect(await db.dealOffer.count()).toBe(0);
    expect(await db.offerDraft.count()).toBe(1);
    expect(await db.offerSequence.count()).toBe(0);
    expect([...bucket.objects.keys()].filter((key) => key.startsWith("offers/"))).toEqual([]);
    expect(bucket.reads).toEqual([]);
  });

  it("a blank legal name the registry calls complete is refused the same way (never entity_profile_missing)", async () => {
    const s = await draftFor();
    registry.set(completeEntity("welld_ch", { legalName: "  ", complete: true, missing: [] }));
    const res = await generate(s.dealId, s.draft.version);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "legal_entity_incomplete", entity: "welld_ch", missing: ["legalName"] });
  });

  it("generates again once the registry says complete", async () => {
    const s = await draftFor();
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: " " }));
    expect((await generate(s.dealId, s.draft.version)).status).toBe(409);
    registry.set(worldIssuer("welld_ch"));
    expect((await generate(s.dealId, s.draft.version)).status).toBe(201);
  });

  it("generates a complete entity that holds values today's rules refuse (Needs correction blocks nothing, E13)", async () => {
    const s = await draftFor();
    registry.set(completeEntity("welld_ch", { invalid: [{ field: "iban", reason: "iban_check_digits" }, { field: "address.it", reason: "too_many_lines", limit: 4 }] }));
    expect((await generate(s.dealId, s.draft.version)).status).toBe(201);
  });

  it("is 503 legal_entities_unavailable with Retry-After: 5 when the registry cannot be read, and changes nothing", async () => {
    const s = await draftFor();
    registry.unavailable();
    const res = await generate(s.dealId, s.draft.version);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("legal_entities_unavailable");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await db.dealOffer.count()).toBe(0);
    expect(await db.offerSequence.count()).toBe(0);
    expect(await db.offerDraft.count()).toBe(1);
  });

  it("starts a draft for an incomplete entity (an autosave is never refused) and answers 503 with Retry-After: 5 while the registry is down", async () => {
    const { deal } = await readyDealWithProfiles();
    const template = await makeDraftTemplate();
    registry.set(incompleteEntity("welld_ch", ["vatNumber"]));
    registry.unavailable();
    const down = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
    expect([down.status, down.json.code, down.headers.get("Retry-After")]).toEqual([503, "legal_entities_unavailable", "5"]);
    expect(await db.offerDraft.count()).toBe(0);
    registry.unavailable(false);
    const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
    expect(created.status).toBe(201);
    // ... and generate is where the incompleteness refuses, with the draft kept
    const refused = await generate(deal.id, created.json.version);
    expect([refused.status, refused.json.code]).toEqual([409, "legal_entity_incomplete"]);
    expect(await db.offerDraft.count()).toBe(1);
  });

  it("generates for a deal whose entity has no profile row: place Lugano, a plain page (E4)", async () => {
    const { deal } = await makeReadyDeal();
    const template = await makeDraftTemplate();
    const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
    expect(created.status).toBe(201);
    expect(await db.entityProfile.count()).toBe(0);
    const res = await generate(deal.id, created.json.version);
    expect(res.status).toBe(201);
    const [row] = await db.dealOffer.findMany({ where: { dealId: deal.id } });
    expect((row!.snapshot as { place: string }).place).toBe("Lugano");
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
  /** The registry's details change (a save in auth): the CRM's own profile is untouched. */
  const rename = async (legalName: string) => {
    registry.set(completeEntity("welld_ch", { legalName, address: { it: ["Via Nuova 9"], en: ["Via Nuova 9"] } }));
    return { status: 200 };
  };

  it("prints the registry's name and address, keeps them in the snapshot when the profile changes, and prints the current ones on a revision", async () => {
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

  it("an English offer prints address[en], an Italian one address[it] (AC-6.2)", async () => {
    registry.set(
      completeEntity("welld_ch", {
        address: { it: ["Via Cantonale 1", "6900 Lugano", "Svizzera"], en: ["Via Cantonale 1", "6900 Lugano", "Switzerland"] },
      }),
    );
    const { deal } = await readyDealWithProfiles();
    const made: string[] = [];
    for (const language of ["en", "it"] as const) {
      const template = await makeDraftTemplate({ language, source: ISSUER_SOURCE });
      // One deal, one offer at a time: the first is sent before the second is a revision.
      const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
      expect(created.status).toBe(201);
      const res = await generate(deal.id, created.json.version);
      expect(res.status).toBe(201);
      made.push(res.json.id);
      expect((await call("POST", `/deals/${deal.id}/offers/${res.json.id}/sent`)).status).toBe(200);
    }
    const rows = await db.dealOffer.findMany({ where: { dealId: deal.id }, orderBy: { number: "asc" } });
    expect(JSON.stringify(rows[0]!.snapshot)).toContain("Emittente: wellD SA / Via Cantonale 1, 6900 Lugano, Switzerland");
    expect(JSON.stringify(rows[1]!.snapshot)).toContain("Emittente: wellD SA / Via Cantonale 1, 6900 Lugano, Svizzera");
    expect((rows[0]!.snapshot as { issuer: { addressLines: string[] } }).issuer.addressLines).toEqual(["Via Cantonale 1", "6900 Lugano", "Switzerland"]);
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
