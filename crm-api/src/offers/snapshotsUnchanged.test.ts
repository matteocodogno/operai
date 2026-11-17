/**
 * Offers generated before the switch to the registry are not touched by it (specs/20261117-legal-entities T27; AC-6.4):
 * after the release and after a registry save, their stored PDF bytes (hash) and their snapshot JSON are what they were, and
 * they are still listed and downloadable. A new offer made after the save prints the new details, so the test is not a
 * world where nothing changed.
 *
 * "Before the switch" is made of three offers: a wizard offer and a legacy-template offer generated through the app and then
 * put back in the shape the old code stored (no `legalEntityVersion`: the key is new, additive, plan § Data model), and a
 * specs/20261101 summary offer (no `kind`) written as it was.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { bucket, call, db, makeReadyDeal, makeWizardTemplate, offerBody, registry, resetWorld, worldIssuer } from "../test-support/world";
import { env } from "../lib/env";

const switchWas = env.LETTERHEAD_SERVICE_ENABLED;
beforeEach(async () => {
  await resetWorld();
  env.LETTERHEAD_SERVICE_ENABLED = false;
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
});

/** The version of the world's default details, and the one a save makes of them. */
const BEFORE = worldIssuer("welld_ch").version;
const SAVED = BEFORE + 1;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function wizardOffer(dealId: string, entity: "welld_ch" | "welld_it") {
  const template = await makeWizardTemplate({ entity, name: `Unchanged ${crypto.randomUUID().slice(0, 6)}` });
  const created = await call("POST", `/deals/${dealId}/offer-draft`, { body: { templateId: template.id }, headers: { "If-None-Match": "*" } });
  expect(created.status).toBe(201);
  const generated = await call("POST", `/deals/${dealId}/offer-draft/generate`, { ifMatch: created.json.version });
  expect(generated.status).toBe(201);
  return generated.json.id as string;
}

async function legacyOffer(dealId: string, entity: "welld_ch" | "welld_it") {
  const res = await call("POST", `/deals/${dealId}/offers`, { body: await offerBody(dealId, entity, "Formazione") });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

/** The 018 summary offer, as specs/20261101-crm-sales-flow stored it: no `kind`, no `legalEntityVersion`. */
async function summaryOffer(dealId: string) {
  const bytes = await (async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    return doc.save();
  })();
  const objectKey = `offers/${dealId}/summary.pdf`;
  bucket.objects.set(objectKey, { bytes, contentType: "application/pdf", sizeBytes: bytes.byteLength });
  const row = await db.dealOffer.create({
    data: {
      dealId,
      number: 1,
      language: "it",
      priceCents: 9_000_050n,
      currency: "CHF",
      validityDays: 30,
      terms: null,
      snapshot: {
        language: "it",
        number: 1,
        reference: "OF-2026-ABC123-1",
        issuedOn: "2026-01-05",
        validUntil: "2026-02-04",
        issuer: { legalName: "Old Name SA", addressLines: ["Via Vecchia 1"], vatNumber: "CHE-0.0.0", iban: "CH00 0000 0000 0000 0000 0" },
        client: { name: "Acme", addressLines: [], contact: null },
        title: "Grid analytics",
        scope: { aiAssisted: false, manDaysTenths: 0, releases: [] },
        priceCents: 9_000_050,
        currency: "CHF",
        terms: null,
        preparedBy: null,
      },
      objectKey,
      sizeBytes: bytes.byteLength,
      createdBy: "user-admin",
    },
  });
  return row.id;
}

/** Puts a freshly generated snapshot back in the shape the code before this change stored. */
async function asBeforeTheChange(offerId: string) {
  const row = await db.dealOffer.findUniqueOrThrow({ where: { id: offerId } });
  const { legalEntityVersion, ...old } = row.snapshot as Record<string, unknown>;
  // The new code did store the key: otherwise this test would prove nothing about it.
  expect(legalEntityVersion).toBe(BEFORE);
  await db.dealOffer.update({ where: { id: offerId }, data: { snapshot: old as object } });
}

const witness = async (offerId: string) => {
  const row = await db.dealOffer.findUniqueOrThrow({ where: { id: offerId } });
  const object = bucket.objects.get(row.objectKey);
  return {
    snapshotJson: JSON.stringify(row.snapshot),
    pdfSha256: sha256(object!.bytes!),
    sizeBytes: row.sizeBytes,
    objectKey: row.objectKey,
    letterheadVersion: row.letterheadVersion,
    version: row.version,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
};

describe("an offer generated before the change (AC-6.4)", () => {
  it("keeps its PDF hash and its snapshot JSON after a registry save, and is still listed and downloadable", async () => {
    const wizardDeal = (await makeReadyDeal()).deal;
    const legacyDeal = (await makeReadyDeal({ entity: "welld_it" })).deal;
    const summaryDeal = (await makeReadyDeal()).deal;
    const offers = [
      { dealId: wizardDeal.id, id: await wizardOffer(wizardDeal.id, "welld_ch") },
      { dealId: legacyDeal.id, id: await legacyOffer(legacyDeal.id, "welld_it") },
      { dealId: summaryDeal.id, id: await summaryOffer(summaryDeal.id) },
    ];
    await asBeforeTheChange(offers[0]!.id);
    await asBeforeTheChange(offers[1]!.id);
    const before = await Promise.all(offers.map((offer) => witness(offer.id)));
    // They print what the registry held when they were made.
    expect(before[0]!.snapshotJson).toContain(worldIssuer("welld_ch").legalName);

    // A save: the next version, every printed value changed (IBAN print included), and the cache entry gone.
    for (const entity of ["welld_ch", "welld_it"] as const) {
      registry.set({
        ...worldIssuer(entity),
        version: SAVED,
        legalName: "Renamed SA",
        address: { it: ["Via Nuova 7", "6900 Lugano"], en: ["New Street 7", "6900 Lugano"] },
        vatNumber: "CHE-999.999.999 IVA",
        iban: "CH9300762011623852957",
        ibanPrint: "CH93 0076 2011 6238 5295 7",
      });
    }
    registry.invalidate();

    // A new offer made now prints the new details and says which version.
    const freshDeal = (await makeReadyDeal()).deal;
    const freshId = await wizardOffer(freshDeal.id, "welld_ch");
    const fresh = await db.dealOffer.findUniqueOrThrow({ where: { id: freshId } });
    expect((fresh.snapshot as any).issuer).toEqual({ legalName: "Renamed SA", addressLines: ["Via Nuova 7", "6900 Lugano"], vatNumber: "CHE-999.999.999 IVA", iban: "CH93 0076 2011 6238 5295 7" });
    expect((fresh.snapshot as any).legalEntityVersion).toBe(SAVED);

    // The old ones are as they were: bytes, snapshot, the row's own fields.
    const after = await Promise.all(offers.map((offer) => witness(offer.id)));
    expect(after).toEqual(before);
    expect(after[0]!.snapshotJson).not.toContain("legalEntityVersion");
    expect(after[0]!.snapshotJson).not.toContain("Renamed SA");

    // Still listed and downloadable.
    for (const offer of offers) {
      const list = await call("GET", `/deals/${offer.dealId}/offers`);
      expect(list.status).toBe(200);
      expect(list.json.items.map((item: { id: string }) => item.id)).toContain(offer.id);
      const download = await call("GET", `/deals/${offer.dealId}/offers/${offer.id}/download`);
      expect(download.status).toBe(200);
      expect(download.json.url).toContain((await witness(offer.id)).objectKey);
    }
  });

  it("is not re-rendered by anything a registry save does (the stored object is never put again)", async () => {
    const deal = (await makeReadyDeal()).deal;
    const id = await wizardOffer(deal.id, "welld_ch");
    const { objectKey } = await witness(id);
    const bytes = bucket.objects.get(objectKey)!.bytes;
    registry.set({ ...worldIssuer("welld_ch"), version: SAVED, legalName: "Renamed SA" });
    registry.invalidate();
    await call("GET", `/deals/${deal.id}/offers`);
    await call("GET", `/deals/${deal.id}/offers/${id}/download`);
    expect(bucket.objects.get(objectKey)!.bytes).toBe(bytes);
    expect(bucket.deleted).not.toContain(objectKey);
  });
});
