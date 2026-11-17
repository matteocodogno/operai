import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { bucket, call, db, estimai, estimaiNotice, makeCompany, makeDeal, offerBody, resetWorld, setRetiredLegalColumns } from "../test-support/world";
import { setStorageForTests } from "../lib/storage";
import { deflatedRun, objStmBombPdf } from "../test-support/pdfBuild";

/** specs/20261101-crm-sales-flow US-4 (list, download, delete) on the specs/20261102-crm-offer-document generate flow. */
const YEAR = new Date().getUTCFullYear();

const PROFILE = {
  legalName: "wellD SA",
  addressLines: ["Via Example 1", "6900 Lugano"],
  vatNumber: "CHE-123.456.789 MWST",
  iban: "CH00 0000 0000 0000 0000 0",
  offerTermsEn: "Payment within 30 days.",
  offerTermsIt: "Pagamento a 30 giorni.",
};

const act = (id: string, epic: string, md: number, release: string) => ({ id, epic, o: md, ml: md, p: md, release });

async function pdfBytes(pages = 1, size: [number, number] = [595.28, 841.89]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size).drawLine({ start: { x: 50, y: 50 }, end: { x: 200, y: 50 } });
  return doc.save();
}

/** A qualified deal with a ready estimate: Phase 1 = 10 md (Auth), Phase 2 = 20 md (Reports, Billing). */
async function readyDeal(
  overrides: { entity?: "welld_ch" | "welld_it"; amountCents?: number | null; title?: string } = {},
  companyOverrides: Record<string, unknown> = {},
) {
  const entity = overrides.entity ?? "welld_ch";
  const company = await makeCompany({
    name: `Acme ${crypto.randomUUID().slice(0, 6)}`,
    entity,
    legalName: "Acme Holding SA",
    street: "Via Roma 1",
    postalCode: "6900",
    city: "Lugano",
    country: "CH",
    ...companyOverrides,
  });
  const deal = await makeDeal(
    company.id,
    { stage: "qualified", title: overrides.title ?? "Grid analytics", amountCents: overrides.amountCents === undefined ? 9_000_050 : overrides.amountCents, entity },
    "admin",
  );
  await call("POST", `/deals/${deal.id}/estimate`, { as: "admin", body: { technicalUserId: "user-tech" } });
  const estimate = [...estimai.estimates.values()].at(-1)!;
  estimate.content = {
    params: { aiGain: 0.3 },
    releases: [
      { id: "r1", name: "Phase 1" },
      { id: "r2", name: "Phase 2" },
    ],
    // estimai-ui stores the release NAME on an activity
    acts: [act("1", "Auth", 10, "Phase 1"), act("2", "Reports", 12, "Phase 2"), act("3", "Billing", 8, "Phase 2")],
  };
  await estimaiNotice(deal.id);
  return { deal, company };
}

/** The API keeps no legal details any more (T29); the document paths read the retired columns until T26, so they are set beside it. */
const putProfile = async (entity: "welld_ch" | "welld_it" = "welld_ch") => {
  const { legalName, addressLines, vatNumber, iban, ...own } = PROFILE;
  const res = await call("PUT", `/entity-profiles/${entity}`, { as: "admin", body: own });
  await setRetiredLegalColumns(entity, { legalName: entity === "welld_it" ? "wellD Srl" : legalName, addressLines, vatNumber, iban });
  return res;
};
const generate = (dealId: string, body: unknown, as: "salesCh" | "admin" = "admin") =>
  call("POST", `/deals/${dealId}/offers`, { as, body });
/** specs/20261102-crm-offer-document US-7: a next revision needs the previous offer sent. */
const markSent = (dealId: string, offerId: string) => call("POST", `/deals/${dealId}/offers/${offerId}/sent`);
/** Generates, then marks it sent, so the deal's next generation is a revision. */
const generateSent = async (dealId: string, body: unknown) => {
  const res = await generate(dealId, body);
  if (res.status === 201) await markSent(dealId, res.json.id);
  return res;
};
const body = (dealId: string, name = "Training", overrides: Record<string, unknown> = {}, entity: "welld_ch" | "welld_it" = "welld_ch") =>
  offerBody(dealId, entity, name, overrides);

async function storeAttachment(dealId: string, over: Partial<{ fileName: string; contentType: string; sizeBytes: number; bytes: Uint8Array | null; status: "stored" | "pending" }> = {}) {
  const bytes = over.bytes === undefined ? await pdfBytes() : over.bytes;
  const row = await db.dealAttachment.create({
    data: {
      dealId,
      fileName: over.fileName ?? "annex.pdf",
      contentType: over.contentType ?? "application/pdf",
      sizeBytes: over.sizeBytes ?? bytes?.byteLength ?? 1,
      objectKey: `attachments/${dealId}/${crypto.randomUUID()}/annex.pdf`,
      status: over.status ?? "stored",
      uploadedBy: "user-admin",
    },
  });
  if (bytes) bucket.objects.set(row.objectKey, { bytes, contentType: row.contentType, sizeBytes: row.sizeBytes });
  return row;
}

describe("offer draft (specs/20261102-crm-offer-document AC-3.1)", () => {
  beforeEach(resetWorld);

  it("needs a ready estimate, the entity profile and an active template of the deal's entity", async () => {
    const company = await makeCompany();
    const bare = await makeDeal(company.id, {}, "admin");
    const list = await call("GET", "/offer-templates?entity=welld_ch", { as: "admin" });
    const template = list.json.items[0];
    expect((await call("GET", `/deals/${bare.id}/offers/draft?templateId=${template.id}`)).json.code).toBe("estimate_not_ready");

    const { deal } = await readyDeal();
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=${template.id}`)).json).toMatchObject({
      code: "entity_profile_missing",
    });
    await putProfile();
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=${template.id}`)).status).toBe(200);
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=nope`)).status).toBe(404);
    expect((await call("GET", `/deals/${deal.id}/offers/draft`)).status).toBe(422);

    const other = await call("GET", "/offer-templates?entity=welld_it", { as: "admin" });
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=${other.json.items[0].id}`)).status).toBe(404);

    await call("POST", `/offer-templates/${template.id}/archive`, { ifMatch: template.version });
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=${template.id}`)).json.code).toBe("template_archived");
    // deal:manage is needed, and in scope
    expect((await call("GET", `/deals/${deal.id}/offers/draft?templateId=${template.id}`, { as: "consultant" })).status).toBe(403);
  });

  it("builds the client block from the company, in the template's language", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const en = await body(deal.id, "Training");
    expect(en.clientLines).toEqual(["Acme Holding SA", "Via Roma 1", "6900 Lugano", "Switzerland"]);
    const it = await body(deal.id, "Formazione");
    expect(it.clientLines.at(-1)).toBe("Svizzera");
    const { deal: plain } = await readyDeal({}, { legalName: null, street: null, postalCode: null, city: "Bern", country: "XK" });
    const draft = await body(plain.id, "Training");
    expect(draft.clientLines).toHaveLength(3);
    expect(draft.clientLines[1]).toBe("Bern");
    expect(draft.clientLines[2]).toBe("Kosovo");
  });

  it("resolves the placeholders from the deal, the issuer, the client and the estimate", async () => {
    const { deal } = await readyDeal({ title: "{epics} Grid" });
    await putProfile();
    const draft = await body(deal.id, "MVP without maintenance");
    const text = JSON.stringify(draft);
    expect(draft.opening).toContain("wellD SA");
    expect(draft.opening).toContain("Acme Holding SA");
    const [objectSection, timingSection] = [draft.sections[1], draft.sections[2]];
    // epics: distinct, numbered, in the estimate's order
    expect(objectSection.body).toContain("1. Auth\n2. Reports\n3. Billing");
    // phases: a bullet per release with its epics
    expect(timingSection.body).toContain("- Phase 1: Auth\n- Phase 2: Reports, Billing");
    expect(timingSection.body).toContain("| Phase | Estimated working months |");
    expect(timingSection.body).toMatch(/\| Phase 1 \| \d+( - \d+)? \|/);
    expect(draft.sections[8].body).toContain("wellD SA");
    // validity
    expect(draft.sections[6].body).toBe("This offer is valid for 30 calendar days.");
    expect(draft.validityDays).toBe(30);
    // single pass: a deal title that looks like a placeholder stays as typed
    expect(draft.costLines[0].description).toBe("{epics} Grid, as per subject of the supply, fixed price");
    expect(text).not.toContain("{issuer}");
    expect(text).not.toContain("{client}");
    expect(text).not.toContain("{validityDays}");
  });

  it("fills man-days (AI-assisted on request) into the text and the quantity", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const consulting = await body(deal.id, "Consulting by the day");
    // 10 + 12 + 8 = 30
    expect(consulting.sections[1].body).toContain("**30 man-days**");
    expect(consulting.costLines).toEqual([
      { description: "Specialist consulting in man-days", kind: "one_off", unitCents: 120_000, quantity: 30 },
    ]);
    expect(consulting.costColumns).toEqual({ position: true, unit: true });
    const list = await call("GET", "/offer-templates?entity=welld_ch");
    const id = list.json.items.find((t: { name: string }) => t.name === "Consulting by the day").id;
    const ai = await call("GET", `/deals/${deal.id}/offers/draft?templateId=${id}&aiAssisted=true`);
    expect(ai.json).toMatchObject({ manDays: 21, aiAssisted: true });
    expect(ai.json.costLines[0].quantity).toBe(21);
  });

  it("expands a per-phase line into one per release, splitting the deal amount by man-days", async () => {
    const { deal } = await readyDeal({ amountCents: 9_000_050 });
    await putProfile();
    const draft = await body(deal.id, "Phased fixed price");
    // 10 : 20 of 90 000.50 → 30 000.17 rounds to 30 000 whole units; the remainder goes last
    expect(draft.costLines).toEqual([
      { description: "Phase 1", kind: "one_off", unitCents: 3_000_000, quantity: 1 },
      { description: "Phase 2", kind: "one_off", unitCents: 6_000_050, quantity: 1 },
    ]);
    expect(draft.costLines.reduce((s: number, l: { unitCents: number }) => s + l.unitCents, 0)).toBe(9_000_050);
    expect(draft.showTotal).toBe(false);
  });

  it("a deal with no amount yet leaves the lines priced from it blank, for the user to fill", async () => {
    const { deal } = await readyDeal({ amountCents: null });
    await putProfile();
    const phased = await body(deal.id, "Phased fixed price");
    expect(phased.costLines.map((l: { unitCents?: number | null }) => l.unitCents ?? null)).toEqual([null, null]);
  });

  it("puts the deal amount on the deal line", async () => {
    const { deal } = await readyDeal({ amountCents: 123_400 });
    await putProfile();
    const draft = await body(deal.id, "Training");
    expect(draft.costLines).toEqual([{ description: "Grid analytics, fixed price", kind: "one_off", unitCents: 123_400, quantity: 1 }]);
    expect(draft.showTotal).toBe(true);
  });
});

describe("offer generation (specs/20261102-crm-offer-document US-1, US-3, US-4)", () => {
  beforeEach(resetWorld);

  it("needs a ready estimate and the entity's profile", async () => {
    const company = await makeCompany();
    const bare = await makeDeal(company.id, {}, "admin");
    expect((await generate(bare.id, { templateId: "x" })).status).toBe(422);
    const { deal } = await readyDeal();
    await putProfile();
    const good = await body(deal.id);
    expect((await generate(bare.id, good)).json.code).toBe("estimate_not_ready");
    expect((await generate(deal.id, { ...good, templateId: "missing" })).status).toBe(404);
    // entity scope: a CH salesperson cannot generate for an IT deal
    const it = await readyDeal({ entity: "welld_it" });
    expect((await generate(it.deal.id, good, "salesCh")).json.code).toBe("out_of_scope");
  });

  it("a deal an admin let go without an estimate gets an offer with no scope, no man-days and no annex (specs/20261101-crm-sales-flow AC-3.7)", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id, { amountCents: 1_500_000 }, "admin");
    await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "Fixed-price service" } });
    await putProfile();
    const list = await call("GET", "/offer-templates?entity=welld_ch", { as: "admin" });
    const template = list.json.items.find((t: { name: string }) => t.name === "Fixed-price project");
    const draft = await call("GET", `/deals/${deal.id}/offers/draft?templateId=${template.id}`);
    expect(draft.status).toBe(200);
    expect(draft.json).toMatchObject({ manDays: 0, annex: false });
    expect(JSON.stringify(draft.json.sections)).not.toContain("|");
    const res = await generate(deal.id, { ...(await body(deal.id, "Fixed-price project")), annex: true });
    expect(res.status).toBe(201);
    expect(estimai.estimates.size).toBe(0);
  });

  it("generates the price, the yearly figure and the snapshot", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const res = await generate(
      deal.id,
      await body(deal.id, "Fixed-price project", {
        costLines: [
          { description: "Build", kind: "one_off", unitCents: 8_000_000, quantity: 1 },
          { description: "Hosting", kind: "yearly", unitCents: 250_000, quantity: 1 },
          { description: "Support", kind: "one_off", unitCents: 1_000_050, quantity: 1 },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      number: 1,
      reference: `0001/${YEAR}`,
      language: "en",
      priceCents: 9_000_050,
      yearlyCents: 250_000,
      currency: "CHF",
      validityDays: 30,
      aiAssisted: false,
      templateName: "Fixed-price project",
      deleted: false,
    });
    // annex on by default for this template: 10 + 12 + 8 md → 300 tenths
    expect(res.json.manDaysTenths).toBe(300);
    const row = await db.dealOffer.findFirstOrThrow({ where: { dealId: deal.id } });
    expect(row).toMatchObject({ sequenceYear: YEAR, sequenceNo: 1, terms: null });
    expect(row.snapshot).toMatchObject({
      kind: "contract",
      reference: `0001/${YEAR}`,
      place: "Lugano",
      template: { name: "Fixed-price project" },
      costs: { oneOffCents: 9_000_050, yearlyCents: 250_000 },
    });
    const pdf = [...bucket.objects.values()].find((o) => o.contentType === "application/pdf" && o.bytes)!;
    expect(new TextDecoder().decode(pdf.bytes!.slice(0, 5))).toBe("%PDF-");
  });

  it("uses the entity's place of issue and letterhead when set", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    await call("PUT", "/entity-profiles/welld_ch", { body: { ...PROFILE, placeOfIssue: "Zug" } });
    const key = `letterheads/welld_ch/${crypto.randomUUID()}.pdf`;
    bucket.objects.set(key, { bytes: await pdfBytes(), contentType: "application/pdf", sizeBytes: 100 });
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: key, letterheadBy: "user-admin", letterheadAt: new Date() } });
    const res = await generate(deal.id, await body(deal.id));
    expect(res.status).toBe(201);
    expect(bucket.reads).toContain(key);
    expect((await db.dealOffer.findFirstOrThrow({ where: { dealId: deal.id } })).snapshot).toMatchObject({ place: "Zug" });
    // a PUT keeps the letterhead
    expect((await call("GET", "/entity-profiles")).json.items[0].letterhead).not.toBeNull();
  });

  describe("numbering (D-5)", () => {
    it("takes the next number per entity and year; later versions of a deal add r1, r2…", async () => {
      const a = await readyDeal();
      const b = await readyDeal();
      await putProfile();
      expect((await generateSent(a.deal.id, await body(a.deal.id))).json.reference).toBe(`0001/${YEAR}`);
      expect((await generate(b.deal.id, await body(b.deal.id))).json.reference).toBe(`0002/${YEAR}`);
      const again = await generateSent(a.deal.id, await body(a.deal.id));
      expect(again.json).toMatchObject({ number: 2, reference: `0001/${YEAR}r1` });
      expect((await generate(a.deal.id, await body(a.deal.id))).json.reference).toBe(`0001/${YEAR}r2`);
      // a number is only taken by a deal's FIRST offer
      expect((await db.offerSequence.findFirstOrThrow()).last).toBe(2);
    });

    it("counts per entity", async () => {
      const ch = await readyDeal();
      const it = await readyDeal({ entity: "welld_it" });
      await putProfile();
      await putProfile("welld_it");
      expect((await generate(ch.deal.id, await body(ch.deal.id))).json.reference).toBe(`0001/${YEAR}`);
      const itBody = await body(it.deal.id, "Training", {}, "welld_it");
      expect((await generate(it.deal.id, itBody)).json.reference).toBe(`0001/${YEAR}`);
    });

    it("never hands out the same number twice when deals generate at once", async () => {
      const deals = await Promise.all([readyDeal(), readyDeal(), readyDeal()]);
      await putProfile();
      const bodies = await Promise.all(deals.map((d) => body(d.deal.id)));
      const results = await Promise.all(deals.map((d, i) => generate(d.deal.id, bodies[i])));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => r.json.reference)).size).toBe(3);
      expect(results.map((r) => r.json.reference).sort()).toEqual([`0001/${YEAR}`, `0002/${YEAR}`, `0003/${YEAR}`]);
    });

    it("keeps a deal's number and year across a year change, and a deleted revision leaves its gap", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const first = await generateSent(deal.id, await body(deal.id));
      await db.dealOffer.update({ where: { id: first.json.id }, data: { sequenceYear: YEAR - 1, sequenceNo: 17 } });
      const second = await generate(deal.id, await body(deal.id));
      expect(second.json.reference).toBe(`0017/${YEAR - 1}r1`);
      expect((await call("DELETE", `/deals/${deal.id}/offers/${second.json.id}`)).status).toBe(204);
      const third = await generate(deal.id, await body(deal.id));
      expect(third.json.reference).toBe(`0017/${YEAR - 1}r2`);
      // the counter of the current year was not touched by the revisions
      expect(await db.offerSequence.count({ where: { year: YEAR } })).toBe(1);
    });

    it("a deal whose earlier offers were all deleted unsent takes a new number, from the numbering setting", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const first = await generate(deal.id, await body(deal.id));
      expect(first.json.reference).toBe(`0001/${YEAR}`);
      expect((await call("DELETE", `/deals/${deal.id}/offers/${first.json.id}`)).status).toBe(204);
      expect((await call("PUT", "/offer-sequences/welld_ch", { body: { year: YEAR, next: 42 } })).status).toBe(200);
      const second = await generate(deal.id, await body(deal.id));
      expect(second.json.reference).toBe(`0042/${YEAR}`);
      // a further version keeps the new number; the deleted 0001 stays a gap
      await markSent(deal.id, second.json.id);
      expect((await generate(deal.id, await body(deal.id))).json.reference).toBe(`0042/${YEAR}r1`);
    });

    it("a deleted offer the client received still holds the deal's number", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const first = await generateSent(deal.id, await body(deal.id));
      expect((await call("DELETE", `/deals/${deal.id}/offers/${first.json.id}`)).status).toBe(204);
      expect((await generate(deal.id, await body(deal.id))).json.reference).toBe(`0001/${YEAR}r1`);
    });

    it("does not burn a number when the generation fails", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const bad = await storeAttachment(deal.id, { bytes: new TextEncoder().encode("not a pdf"), fileName: "broken.pdf" });
      const failed = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [bad.id] }));
      expect(failed.status).toBe(422);
      expect((await generate(deal.id, await body(deal.id))).json.reference).toBe(`0001/${YEAR}`);
    });
  });

  describe("cost table (AC-1.5, AC-3.3, D-14)", () => {
    const lines = (...ls: object[]) => ({ costLines: ls });

    it("computes totals, a percentage discount (rounded half up once) and the stored price", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const res = await generate(
        deal.id,
        await body(deal.id, "Consulting by the day", {
          costLines: [
            { description: "Days", kind: "one_off", unitCents: 123_457, quantity: 3 },
            { description: "Fixed", kind: "one_off", unitCents: 5, quantity: 1 },
            { description: "Scontistica 10%", kind: "discount", percentBp: 1_000, quantity: 1 },
            { description: "Retainer", kind: "yearly", unitCents: 10_000, quantity: 2 },
          ],
        }),
      );
      // one-off 370 371 + 5 = 370 376 ; 10% = 37 037.6 → 37 038 ; price 333 338
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ priceCents: 333_338, yearlyCents: 20_000 });
      const costs = ((await db.dealOffer.findFirstOrThrow()).snapshot as { costs: { lines: { totalCents: number }[] } }).costs;
      expect(costs.lines.map((l) => l.totalCents)).toEqual([370_371, 5, 37_038, 20_000]);
    });

    it("rounds a percentage exactly half up", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      // 25 cents × 10% = 2.5 → 3
      const res = await generate(
        deal.id,
        await body(deal.id, "Training", {
          ...lines(
            { description: "A", kind: "one_off", unitCents: 25, quantity: 1 },
            { description: "d", kind: "discount", percentBp: 1_000, quantity: 1 },
          ),
        }),
      );
      expect(res.json.priceCents).toBe(22);
    });

    it("a fixed discount reduces the price; discounts may not exceed the one-off lines", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const ok = await generate(
        deal.id,
        await body(deal.id, "Training", {
          ...lines(
            { description: "A", kind: "one_off", unitCents: 1_000_000, quantity: 1 },
            { description: "d", kind: "discount", unitCents: 240_000, quantity: 1 },
          ),
        }),
      );
      expect(ok.json.priceCents).toBe(760_000);
      await markSent(deal.id, ok.json.id);
      const over = await generate(
        deal.id,
        await body(deal.id, "Training", {
          ...lines(
            { description: "A", kind: "one_off", unitCents: 100, quantity: 1 },
            { description: "d", kind: "discount", unitCents: 101, quantity: 1 },
          ),
        }),
      );
      expect(over.status).toBe(422);
      expect(over.json.code).toBe("discounts_exceed_one_off");
      // a yearly line does not count towards what a discount may take
      const yearly = await generate(
        deal.id,
        await body(deal.id, "Training", {
          ...lines(
            { description: "A", kind: "one_off", unitCents: 100, quantity: 1 },
            { description: "Y", kind: "yearly", unitCents: 500, quantity: 1 },
            { description: "d", kind: "discount", unitCents: 150, quantity: 1 },
          ),
        }),
      );
      expect(yearly.json.code).toBe("discounts_exceed_one_off");
    });

    it("handles amounts beyond 2^53 / quantity safely", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const res = await generate(
        deal.id,
        await body(deal.id, "Consulting by the day", {
          costLines: [{ description: "Huge", kind: "one_off", unitCents: 10_000_000_000_000, quantity: 100_000 }],
        }),
      );
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("cost_total_too_large");
    });

    it("validates the limits of AC-3.3", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const good = await body(deal.id);
      const section = { heading: "H", body: "", costs: false };
      const costsSection = { heading: "Costs", body: "", costs: true };
      const refused = async (overrides: Record<string, unknown>) => (await generate(deal.id, { ...good, ...overrides })).status;
      expect(await refused({ sections: [section] })).toBe(422); // no costs section
      expect(await refused({ sections: [costsSection, costsSection] })).toBe(422); // two
      expect(await refused({ sections: [costsSection, ...Array.from({ length: 15 }, () => section)] })).toBe(422); // 16
      expect(await refused({ sections: [{ ...costsSection, heading: "x".repeat(121) }] })).toBe(422);
      expect(await refused({ sections: [{ ...costsSection, body: "x".repeat(20_001) }] })).toBe(422);
      expect(await refused({ sections: [{ ...costsSection, body: "x ".repeat(10_000) }] })).toBe(201);
      expect(await refused({ opening: "x".repeat(5_001) })).toBe(422);
      expect(await refused({ clientLines: [] })).toBe(422);
      expect(await refused({ clientLines: Array.from({ length: 9 }, () => "x") })).toBe(422);
      expect(await refused({ clientLines: ["x".repeat(201)] })).toBe(422);
      expect(await refused({ costLines: [] })).toBe(422);
      expect(await refused({ costLines: [{ description: "y", kind: "yearly", unitCents: 1, quantity: 1 }] })).toBe(422); // no one-off
      expect(await refused({ costLines: Array.from({ length: 11 }, () => ({ description: "a", kind: "one_off", unitCents: 1, quantity: 1 })) })).toBe(422);
      expect(await refused({ costLines: [{ description: "a", kind: "one_off", unitCents: 1, quantity: 2 }] })).toBe(422); // no unit column
      expect(await refused({ costColumns: { position: true, unit: true }, costLines: [{ description: "a", kind: "one_off", unitCents: 1, quantity: 100_001 }] })).toBe(422);
      expect(await refused({ costLines: [{ description: "a", kind: "one_off", unitCents: -1, quantity: 1 }] })).toBe(422);
      expect(await refused({ costLines: [{ description: "a", kind: "one_off", percentBp: 100, quantity: 1 }] })).toBe(422);
      expect(await refused({ costLines: [{ description: "a", kind: "one_off", unitCents: 1, quantity: 1 }, { description: "d", kind: "discount", percentBp: 10_001, quantity: 1 }] })).toBe(422);
      expect(await refused({ contactIds: ["1", "2", "3", "4", "5", "6"] })).toBe(422);
      expect(await refused({ priceCents: 1 })).toBe(422); // dropped fields
      expect(await refused({ language: "en" })).toBe(422);
    });
  });

  describe("contacts and attachments", () => {
    it("takes contacts of the deal's company only", async () => {
      const { deal, company } = await readyDeal();
      await putProfile();
      const mine = await call("POST", "/contacts", { body: { firstName: "Ada", lastName: "Lovelace", companyId: company.id } });
      const other = await makeCompany();
      const foreign = await call("POST", "/contacts", { body: { firstName: "Eve", lastName: "Other", companyId: other.id } });
      expect((await generate(deal.id, await body(deal.id, "Training", { contactIds: [foreign.json.id] }))).json.code).toBe("contact_not_in_company");
      expect((await generate(deal.id, await body(deal.id, "Training", { contactIds: ["ghost"] }))).json.code).toBe("contact_not_in_company");
      const ok = await generate(deal.id, await body(deal.id, "Training", { contactIds: [mine.json.id] }));
      expect(ok.status).toBe(201);
      expect((await db.dealOffer.findFirstOrThrow()).snapshot).toMatchObject({ contacts: ["Ada Lovelace"] });
    });

    it("appends this deal's stored PDFs, in the requested order", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const a = await storeAttachment(deal.id, { fileName: "a.pdf", bytes: await pdfBytes(2) });
      const b = await storeAttachment(deal.id, { fileName: "b.pdf", bytes: await pdfBytes(1) });
      const res = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [b.id, a.id] }));
      expect(res.status).toBe(201);
      expect(bucket.reads).toEqual([b.objectKey, a.objectKey]);
      const snapshot = (await db.dealOffer.findFirstOrThrow()).snapshot as { attachments: { fileName: string }[] };
      expect(snapshot.attachments.map((x) => x.fileName)).toEqual(["b.pdf", "a.pdf"]);
      const offer = [...bucket.objects.entries()].find(([k]) => k.startsWith("offers/"))![1];
      const doc = await PDFDocument.load(offer.bytes!);
      // the contract pages, then 2 + 1 appended pages
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    });

    it("refuses another deal's file, a pending, deleted or non-PDF one, a duplicate and more than five", async () => {
      const { deal } = await readyDeal();
      const { deal: other } = await readyDeal();
      await putProfile();
      const foreign = await storeAttachment(other.id);
      const pending = await storeAttachment(deal.id, { status: "pending" });
      const gone = await storeAttachment(deal.id);
      await db.dealAttachment.update({ where: { id: gone.id }, data: { deletedAt: new Date(), deletedBy: "user-admin" } });
      const word = await storeAttachment(deal.id, { contentType: "image/png", fileName: "pic.png" });
      const good = await storeAttachment(deal.id);
      for (const id of [foreign.id, pending.id, gone.id, "ghost"]) {
        expect((await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [id] }))).json.code).toBe("attachment_invalid");
      }
      const notPdf = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [word.id] }));
      expect(notPdf.json).toMatchObject({ code: "attachment_not_pdf", fileName: "pic.png" });
      expect((await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [good.id, good.id] }))).status).toBe(422);
      expect((await generate(deal.id, await body(deal.id, "Training", { attachmentIds: Array.from({ length: 6 }, (_, i) => `a${i}`) }))).status).toBe(422);
      expect(bucket.reads).toEqual([]);
    });

    it("checks the total size from the database BEFORE reading any object (ADR 20261102-crm-api-reads-attachment-bytes-for-offer-annexes)", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const big1 = await storeAttachment(deal.id, { sizeBytes: 12 * 1024 * 1024 });
      const big2 = await storeAttachment(deal.id, { sizeBytes: 9 * 1024 * 1024 });
      const res = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [big1.id, big2.id] }));
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("attachments_too_large");
      expect(bucket.reads).toEqual([]);
      // exactly 20 MiB is allowed (the fake bucket holds small bytes: only the bound is under test)
      const edge = await storeAttachment(deal.id, { sizeBytes: 20 * 1024 * 1024 });
      expect((await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [edge.id] }))).status).toBe(201);
    });

    it("fails the whole generation with 422 naming a file that cannot be read", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const bad = await storeAttachment(deal.id, { fileName: "scan.pdf", bytes: new TextEncoder().encode("not a pdf") });
      const res = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [bad.id] }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "attachment_unreadable", fileName: "scan.pdf" });
      expect(await db.dealOffer.count()).toBe(0);
      expect([...bucket.objects.keys()].some((k) => k.startsWith("offers/"))).toBe(false);
      // an object missing from the bucket is the same answer
      const missing = await storeAttachment(deal.id, { fileName: "lost.pdf", bytes: null, sizeBytes: 10 });
      const lost = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [missing.id] }));
      expect(lost.json).toMatchObject({ code: "attachment_unreadable", fileName: "lost.pdf" });
    });
  });

  describe("a deal PDF is bounded before pdf-lib loads it (security M-7)", () => {
    it("422 attachment_unreadable naming the file for an object-stream bomb, with PDFDocument.load never called on it", async () => {
      const { deal } = await readyDeal();
      await putProfile();
      const bomb = objStmBombPdf(await deflatedRun(16)); // about 16 KB, 16 MiB inflated: over the 8 MiB non-image cap
      const bad = await storeAttachment(deal.id, { fileName: "bomb.pdf", bytes: bomb });
      const load = spyOn(PDFDocument, "load");
      try {
        const res = await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [bad.id] }));
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ code: "attachment_unreadable", fileName: "bomb.pdf" });
        expect(load.mock.calls.some(([bytes]) => bytes === bomb || (bytes as Uint8Array).byteLength === bomb.byteLength)).toBe(false);
      } finally {
        load.mockRestore();
      }
      expect(await db.dealOffer.count()).toBe(0);
      // a good annex next to it is untouched by the check
      const good = await storeAttachment(deal.id, { fileName: "good.pdf" });
      expect((await generate(deal.id, await body(deal.id, "Training", { attachmentIds: [good.id] }))).status).toBe(201);
    });
  });

  it("refuses a template archived meanwhile and answers 503 without storage", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const good = await body(deal.id);
    setStorageForTests(null);
    expect((await generate(deal.id, good)).json).toMatchObject({ status: 503, code: "storage_unconfigured" });
    setStorageForTests((await import("../test-support/world")).memoryStorage);
    const t = (await call("GET", `/offer-templates/${good.templateId}`)).json;
    await call("POST", `/offer-templates/${t.id}/archive`, { ifMatch: t.version });
    expect((await generate(deal.id, good)).json.code).toBe("template_archived");
  });

  it("accepts a large body: fifteen sections of 20 000 characters", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const big = Array.from({ length: 15 }, (_, i) => ({ heading: `S${i}`, body: "é ".repeat(10_000), costs: i === 5 }));
    expect((await generate(deal.id, await body(deal.id, "Training", { sections: big }))).status).toBe(201);
  });
});

describe("offer list, download and delete", () => {
  beforeEach(resetWorld);

  it("downloads through a presigned link named after the reference; deleting keeps the number used", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const offer = (await generate(deal.id, await body(deal.id))).json;
    const link = await call("GET", `/deals/${deal.id}/offers/${offer.id}/download`, { as: "admin" });
    expect(link.json.url).toContain("?signed");

    expect((await call("DELETE", `/deals/${deal.id}/offers/${offer.id}`, { as: "managerNoMoney" })).status).toBe(403);
    expect((await call("DELETE", `/deals/${deal.id}/offers/${offer.id}`, { as: "admin" })).status).toBe(204);
    expect(bucket.deleted).toHaveLength(1);
    expect((await call("GET", `/deals/${deal.id}/offers/${offer.id}/download`, { as: "admin" })).status).toBe(404);
    const next = await generate(deal.id, await body(deal.id));
    expect(next.json.number).toBe(2);
    const list = await call("GET", `/deals/${deal.id}/offers`, { as: "admin" });
    expect(list.json.items.map((o: { number: number; deleted: boolean }) => [o.number, o.deleted])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it("keeps listing and downloading specs/20261101-crm-sales-flow offers (OF-… reference, legacy snapshot)", async () => {
    const { deal } = await readyDeal();
    const legacy = {
      language: "en",
      number: 1,
      reference: "OF-2026-ABC123-1",
      issuedOn: "2026-10-01",
      validUntil: "2026-10-31",
      issuer: { legalName: "wellD SA", addressLines: [], vatNumber: null, iban: null },
      client: { name: "Acme", addressLines: [], contact: null },
      title: "Grid analytics",
      scope: { aiAssisted: true, releases: [], manDaysTenths: 156 },
      priceCents: 8_500_050,
      currency: "CHF",
      terms: null,
      preparedBy: null,
    };
    const row = await db.dealOffer.create({
      data: {
        dealId: deal.id,
        number: 1,
        language: "en",
        priceCents: 8_500_050n,
        currency: "CHF",
        validityDays: 30,
        snapshot: legacy,
        objectKey: `offers/${deal.id}/legacy.pdf`,
        sizeBytes: 10,
        createdBy: "user-admin",
      },
    });
    const list = await call("GET", `/deals/${deal.id}/offers`);
    expect(list.json.items[0]).toMatchObject({
      reference: "OF-2026-ABC123-1",
      priceCents: 8_500_050,
      yearlyCents: 0,
      aiAssisted: true,
      manDaysTenths: 156,
      validUntil: "2026-10-31",
      templateName: null,
    });
    expect((await call("GET", `/deals/${deal.id}/offers/${row.id}/download`)).status).toBe(200);
    // a new offer on the same deal starts the new numbering at the entity's counter, with no revision
    await putProfile();
    const fresh = await generate(deal.id, await body(deal.id));
    expect(fresh.json).toMatchObject({ number: 2, reference: `0001/${YEAR}` });
  });
});

describe("entity profiles", () => {
  beforeEach(resetWorld);

  it("are written by deal:manage over that entity only, with the place of issue", async () => {
    expect((await call("PUT", "/entity-profiles/welld_it", { as: "salesCh", body: PROFILE })).json.code).toBe("out_of_scope");
    const saved = await call("PUT", "/entity-profiles/welld_ch", { as: "salesCh", body: { ...PROFILE, placeOfIssue: " Lugano " } });
    expect(saved.json).toMatchObject({ entity: "welld_ch", placeOfIssue: "Lugano", letterhead: null });
    const list = await call("GET", "/entity-profiles", { as: "salesCh" });
    expect(list.json.items).toHaveLength(1);
  });
});

describe("edit until sent, then revise (specs/20261102-crm-offer-document US-7)", () => {
  beforeEach(resetWorld);

  const form = (dealId: string, offerId: string) => call("GET", `/deals/${dealId}/offers/${offerId}/form`);
  const put = (dealId: string, offerId: string, payload: unknown, ifMatch?: number) =>
    call("PUT", `/deals/${dealId}/offers/${offerId}`, { body: payload, ...(ifMatch !== undefined ? { ifMatch } : {}) });

  it("a new revision is refused while the newest offer has not been sent (AC-7.1)", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const first = await generate(deal.id, await body(deal.id));
    expect(first.json.sent).toBeNull();
    const refused = await generate(deal.id, await body(deal.id));
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "offer_not_sent", offerId: first.json.id });
    await markSent(deal.id, first.json.id);
    expect((await generate(deal.id, await body(deal.id))).json.reference).toBe(`0001/${YEAR}r1`);
  });

  it("an unsent offer is edited in place: same reference, new PDF, version + 1 (AC-7.2)", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const contact = await call("POST", "/contacts", { body: { firstName: "Mario", lastName: "Rossi", companyId: deal.company.id } });
    const pdf = await storeAttachment(deal.id, { fileName: "annex.pdf" });
    const created = await generate(deal.id, await body(deal.id, "Training", { contactIds: [contact.json.id], attachmentIds: [pdf.id] }));
    const before = await db.dealOffer.findUniqueOrThrow({ where: { id: created.json.id } });

    // the form gives back what the dialog sent, ready to edit
    const prefill = await form(deal.id, created.json.id);
    expect(prefill.status).toBe(200);
    expect(prefill.json).toMatchObject({
      contactIds: [contact.json.id],
      attachmentIds: [pdf.id],
      version: 1,
      sent: false,
      templateName: "Training",
    });

    const edited = { ...(await body(deal.id)), contactIds: [], opening: "A new opening." };
    expect((await put(deal.id, created.json.id, edited)).status).toBe(428);
    expect((await put(deal.id, created.json.id, edited, 7)).status).toBe(409);
    const ok = await put(deal.id, created.json.id, edited, 1);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: created.json.id, reference: `0001/${YEAR}`, version: 2, sent: null });
    expect(ok.headers.get("ETag")).toBe('"2"');
    const after = await db.dealOffer.findUniqueOrThrow({ where: { id: created.json.id } });
    expect(after.objectKey).not.toBe(before.objectKey);
    expect(bucket.objects.has(before.objectKey)).toBe(false);
    expect(bucket.objects.has(after.objectKey)).toBe(true);
    expect((after.snapshot as { opening: string }).opening).toBe("A new opening.");
    expect(await db.dealOffer.count({ where: { dealId: deal.id } })).toBe(1);
  });

  it("marking sent freezes the offer, moves the deal to Offer sent, and a revision starts from it (AC-7.2–7.4)", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    await call("POST", `/deals/${deal.id}/stage`, { ifMatch: (await call("GET", `/deals/${deal.id}`)).json.version, body: { stage: "proposal" } });
    const created = await generate(deal.id, await body(deal.id, "Training", { opening: "Version one." }));
    const sent = await markSent(deal.id, created.json.id);
    expect(sent.json.sent).toMatchObject({ by: { id: "user-admin" } });
    expect((await call("GET", `/deals/${deal.id}`)).json.stage).toBe("negotiation");
    // idempotent: the first moment stays
    expect((await markSent(deal.id, created.json.id)).json.sent.at).toBe(sent.json.sent.at);

    const frozen = await put(deal.id, created.json.id, await body(deal.id), sent.json.version);
    expect(frozen.json).toMatchObject({ status: 409, code: "offer_sent" });

    // the next revision's dialog starts from the sent offer
    const prefill = await form(deal.id, created.json.id);
    expect(prefill.json).toMatchObject({ opening: "Version one.", sent: true });
  });

  it("a deal already past Offer sent keeps its stage", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const created = await generate(deal.id, await body(deal.id));
    const won = await call("POST", `/deals/${deal.id}/stage`, { ifMatch: (await call("GET", `/deals/${deal.id}`)).json.version, body: { stage: "won" } });
    expect(won.status).toBe(200);
    await markSent(deal.id, created.json.id);
    expect((await call("GET", `/deals/${deal.id}`)).json.stage).toBe("won");
  });

  it("an offer from before offer documents can be neither edited nor revised from, and needs deal:manage in scope", async () => {
    const { deal } = await readyDeal();
    const legacy = await db.dealOffer.create({
      data: {
        dealId: deal.id,
        number: 1,
        language: "en",
        priceCents: 100n,
        currency: "CHF",
        validityDays: 30,
        snapshot: { reference: "OF-2026-ABC123-1", validUntil: "2026-10-31", scope: { aiAssisted: false, manDaysTenths: 0 } },
        objectKey: `offers/${deal.id}/legacy.pdf`,
        sizeBytes: 10,
        createdBy: "user-admin",
      },
    });
    expect((await form(deal.id, legacy.id)).json.code).toBe("offer_legacy");
    expect((await call("POST", `/deals/${deal.id}/offers/${legacy.id}/sent`, { as: "consultant" })).status).toBe(403);
  });
});

describe("offer numbering setting (specs/20261102-crm-offer-document US-8)", () => {
  beforeEach(resetWorld);
  const seq = (entity = "welld_ch", as: "admin" | "salesCh" | "consultant" = "admin") =>
    call("GET", `/offer-sequences/${entity}`, { as });
  const setSeq = (next: number, year = YEAR, entity = "welld_ch", as: "admin" | "salesCh" | "consultant" = "admin") =>
    call("PUT", `/offer-sequences/${entity}`, { as, body: { year, next } });

  it("starts at 1; setting the next number makes the next new offer take it (AC-8.1)", async () => {
    expect((await seq()).json).toEqual({ entity: "welld_ch", year: YEAR, next: 1, lowestAllowed: 1 });
    expect((await setSeq(19)).json).toMatchObject({ next: 19, lowestAllowed: 1 });
    const { deal } = await readyDeal();
    await putProfile();
    expect((await generate(deal.id, await body(deal.id))).json.reference).toBe(`0019/${YEAR}`);
    expect((await seq()).json).toMatchObject({ next: 20, lowestAllowed: 20 });
    // the other entity is untouched
    expect((await seq("welld_it")).json.next).toBe(1);
  });

  it("never goes back to a number an offer already carries, deleted ones included (AC-8.2)", async () => {
    const { deal } = await readyDeal();
    await putProfile();
    const first = await generate(deal.id, await body(deal.id));
    expect(first.json.reference).toBe(`0001/${YEAR}`);
    await call("DELETE", `/deals/${deal.id}/offers/${first.json.id}`);
    const refused = await setSeq(1);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "offer_number_used", lowestAllowed: 2 });
    // lowering to an unused number is fine: 50 was never printed
    expect((await setSeq(50)).status).toBe(200);
    expect((await setSeq(2)).json.next).toBe(2);
  });

  it("this year or the next only; deal:manage over the entity and the financials (AC-8.3)", async () => {
    expect((await setSeq(5, YEAR - 1)).json.code).toBe("year_out_of_range");
    expect((await setSeq(5, YEAR + 1)).json).toMatchObject({ year: YEAR + 1, next: 5 });
    expect((await setSeq(10_000)).status).toBe(422);
    expect((await seq("welld_ch", "consultant")).status).toBe(403);
    expect((await setSeq(5, YEAR, "welld_it", "salesCh")).json.code).toBe("out_of_scope");
  });
});
