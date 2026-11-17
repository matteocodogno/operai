/**
 * The classic offer routes through the layout service (specs/20261116-letterhead-service T30; AC-10.1, AC-10.2, AC-10.6,
 * AC-10.8, AC-10.9, AC-10.10, AC-10.11): `POST /deals/{id}/offers` and `PUT /deals/{id}/offers/{offerId}`, the routes of the
 * legacy templates (`sections`), with `LETTERHEAD_SERVICE_ENABLED` on. Without this a contract made from a legacy template
 * would have no letterhead after the switch, because crm-api no longer draws one.
 *
 * The service is an in-process fake behind the REAL client of T27 (`createLetterheadClient` with a stub `fetch`), as in
 * `generation.letterhead.test.ts`: it answers a real PDF whose pages carry their own text, so "crm-api drew nothing" and "the
 * deal PDFs come after" are read from the stored bytes. Real Postgres, the assembled app. The switch is flipped on the `env`
 * object, which the routes read at the request.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, offerBody, readyDealWithProfiles, resetWorld, setRetiredLegalColumns, storedPdfAttachment } from "../test-support/world";
import { resetLetterheadMemoForTests } from "../entity-profiles/letterheadUse";
import { env } from "../lib/env";
import { LETTERHEAD_TIMEOUT_MS, createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";

beforeEach(resetWorld);
beforeEach(resetLetterheadMemoForTests);

const YEAR = new Date().getUTCFullYear();

// ─── The fake service ────────────────────────────────────────────────────────────────────────────────────────────────

type Answer = Response | "network-error";

const fake = { calls: [] as { path: string; body: any }[], answers: [] as Answer[], version: 7, pages: 2 };

async function servicePdf(pages = fake.pages): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n += 1) doc.addPage([595.28, 841.89]).drawText(`SERVICE PAGE ${n} OF ${pages}`, { x: 60, y: 700, size: 12, font });
  doc.setTitle("SERVICE-DOCUMENT");
  doc.setProducer("letterhead-api");
  return doc.save({ useObjectStreams: false });
}

const pdfAnswer = async () =>
  new Response(await servicePdf(), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Page-Count": String(fake.pages), "Unprintable-Characters": "0", "Letterhead-Version": String(fake.version) },
  });

const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ status, code, detail: "SECRET-SERVICE-DETAIL" }), { status, headers: { "Content-Type": "application/problem+json" } });

let spy: { mockRestore(): void } | null = null;
const switchWas = env.LETTERHEAD_SERVICE_ENABLED;

beforeEach(() => {
  fake.calls = [];
  fake.answers = [];
  fake.version = 7;
  fake.pages = 2;
  const tokens: ServiceTokenProvider = { getToken: async () => "svc-token", invalidate() {} };
  let served = 0;
  spy = spyOn(letterhead, "pdf").mockImplementation((content, options) =>
    createLetterheadClient({
      baseUrl: "http://letterhead.test",
      tokens,
      timeoutMs: LETTERHEAD_TIMEOUT_MS,
      sleep: async () => {},
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        fake.calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
        const answer = fake.answers.length === 0 ? await pdfAnswer() : fake.answers[Math.min(served, fake.answers.length - 1)]!;
        served += 1;
        if (answer === "network-error") throw new TypeError("fetch failed SECRET-NETWORK-DETAIL");
        return answer.clone();
      }) as typeof fetch,
    }).pdf(content, options),
  );
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
  spy?.mockRestore();
  spy = null;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function dealPdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return doc.save({ useObjectStreams: false });
}

const storedPdf = (objectKey: string): Uint8Array => bucket.objects.get(objectKey)!.bytes!;
const sizeOf = (doc: PDFDocument, index: number) => {
  const { width, height } = doc.getPage(index).getSize();
  return `${Math.round(width)}x${Math.round(height)}`;
};
const textOf = async (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

const generate = (dealId: string, body: unknown) => call("POST", `/deals/${dealId}/offers`, { body });
const edit = (dealId: string, offerId: string, body: unknown, ifMatch = 1) => call("PUT", `/deals/${dealId}/offers/${offerId}`, { body, ifMatch });
const classicBody = (dealId: string, overrides: Record<string, unknown> = {}) => offerBody(dealId, "welld_ch", "Training", overrides);
const offers = (dealId: string) => db.dealOffer.findMany({ where: { dealId }, orderBy: { number: "asc" } });
const sequences = () => db.offerSequence.findMany({ orderBy: [{ entity: "asc" }, { year: "asc" }] });

async function worldOf(dealId: string) {
  return { offers: await offers(dealId), sequences: await sequences(), objects: [...bucket.objects.keys()].sort() };
}

// ─── With the switch on ──────────────────────────────────────────────────────────────────────────────────────────────

describe("a legacy-template offer with the switch on", () => {
  beforeEach(() => {
    env.LETTERHEAD_SERVICE_ENABLED = true;
  });

  it("is the service's PDF byte for byte, and records the letterhead version (AC-10.1, AC-10.2)", async () => {
    const { deal } = await readyDealWithProfiles();
    const res = await generate(deal.id, await classicBody(deal.id));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ reference: `0001/${YEAR}`, origin: "sections", letterheadVersion: 7 });

    const [row] = await offers(deal.id);
    expect(row!.letterheadVersion).toBe(7);
    const stored = storedPdf(row!.objectKey);
    expect(Buffer.from(stored).equals(Buffer.from(await servicePdf()))).toBe(true);
    expect(row!.sizeBytes).toBe(stored.byteLength);
    const doc = await PDFDocument.load(stored, { updateMetadata: false });
    expect(doc.getTitle()).toBe("SERVICE-DOCUMENT");
    // the list says it too
    const list = await call("GET", `/deals/${deal.id}/offers`);
    expect(list.json.items[0].letterheadVersion).toBe(7);
  });

  it("sends the snapshot's document and the profile as it is now, asking for the active version (AC-10.1, AC-10.10)", async () => {
    const { deal } = await readyDealWithProfiles();
    await setRetiredLegalColumns("welld_ch", { legalName: "wellD SA (nuova)", addressLines: ["Via Nuova 9", "6900 Lugano"], vatNumber: null, iban: null });
    const put = await call("PUT", "/entity-profiles/welld_ch", { body: { offerTermsEn: "x", offerTermsIt: "y" } });
    expect(put.status).toBe(200);
    expect((await generate(deal.id, await classicBody(deal.id))).status).toBe(201);

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/pdf");
    expect(sent!.body).toMatchObject({
      contentVersion: 1,
      entity: "welld_ch",
      entityData: { legalName: "wellD SA (nuova)", addressLines: ["Via Nuova 9", "6900 Lugano"] },
    });
    expect(sent!.body.entityData).not.toHaveProperty("vat");
    expect(sent!.body.entityData).not.toHaveProperty("iban");
    expect(sent!.body).not.toHaveProperty("letterheadVersion");
    expect(sent!.body.blocks.length).toBeGreaterThan(0);
    // the offer's own reference is in what the service draws
    expect(JSON.stringify(sent!.body.blocks)).toContain(`0001/${YEAR}`);
  });

  it("appends the chosen deal PDFs after the service's pages, unchanged and unnumbered (AC-10.1)", async () => {
    const { deal } = await readyDealWithProfiles();
    const a = await storedPdfAttachment(deal.id, "a.pdf", await dealPdf([[200, 300], [210, 310]]));
    const b = await storedPdfAttachment(deal.id, "b.pdf", await dealPdf([[220, 320]]));
    const res = await generate(deal.id, await classicBody(deal.id, { attachmentIds: [b.id, a.id] }));
    expect(res.status).toBe(201);

    const [row] = await offers(deal.id);
    const doc = await PDFDocument.load(storedPdf(row!.objectKey), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2 + 1 + 2);
    expect([0, 1, 2, 3, 4].map((i) => sizeOf(doc, i))).toEqual(["595x842", "595x842", "220x320", "200x300", "210x310"]);
    expect(row!.letterheadVersion).toBe(7);
    expect((row!.snapshot as { attachments: { fileName: string }[] }).attachments.map((x) => x.fileName)).toEqual(["b.pdf", "a.pdf"]);
  });

  it("never reads or checks the uploaded letterhead, whatever is stored: letterhead_unusable cannot be answered (AC-10.11)", async () => {
    const { deal } = await readyDealWithProfiles();
    const key = `letterheads/welld_ch/${crypto.randomUUID()}.pdf`;
    // a stored file that fails the check, and one that is not even there
    bucket.objects.set(key, { bytes: new TextEncoder().encode("not a pdf"), contentType: "application/pdf", sizeBytes: 9 });
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: key, letterheadBy: "user-admin", letterheadAt: new Date() } });
    bucket.reads.length = 0;
    const res = await generate(deal.id, await classicBody(deal.id));
    expect(res.status).toBe(201);
    expect(bucket.reads).not.toContain(key);

    // a reference to an object that is not there at all
    const { deal: other } = await readyDealWithProfiles();
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: `letterheads/welld_ch/${crypto.randomUUID()}.pdf` } });
    const second = await generate(other.id, await classicBody(other.id));
    expect(second.status).toBe(201);
    expect(second.json.letterheadVersion).toBe(7);
  });

  it("edits an unsent offer through the service: the same row and reference, a new PDF, the version recorded, the old object gone (AC-10.1, AC-10.9)", async () => {
    const { deal } = await readyDealWithProfiles();
    // made before the switch: crm-api's own pages, no version
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const made = await generate(deal.id, await classicBody(deal.id));
    expect(made.status).toBe(201);
    expect(made.json.letterheadVersion).toBeNull();
    const [before] = await offers(deal.id);
    expect(fake.calls).toHaveLength(0);

    env.LETTERHEAD_SERVICE_ENABLED = true;
    fake.version = 9;
    const res = await edit(deal.id, made.json.id, await classicBody(deal.id, { validityDays: 45 }), made.json.version);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ reference: `0001/${YEAR}`, letterheadVersion: 9, version: made.json.version + 1 });

    const [after] = await offers(deal.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.objectKey).not.toBe(before!.objectKey);
    expect(bucket.objects.has(before!.objectKey)).toBe(false);
    expect(Buffer.from(storedPdf(after!.objectKey)).equals(Buffer.from(await servicePdf()))).toBe(true);
    expect(after!.letterheadVersion).toBe(9);
    expect(fake.calls).toHaveLength(1);
  });

  it("makes a revision of a sent offer with the service, and leaves the sent one byte for byte (AC-10.1, AC-10.9)", async () => {
    const { deal } = await readyDealWithProfiles();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const first = await generate(deal.id, await classicBody(deal.id));
    expect(first.status).toBe(201);
    expect((await call("POST", `/deals/${deal.id}/offers/${first.json.id}/sent`)).status).toBeLessThan(300);
    const [sentBefore] = await offers(deal.id);
    const bytesBefore = Buffer.from(storedPdf(sentBefore!.objectKey));

    env.LETTERHEAD_SERVICE_ENABLED = true;
    const revision = await generate(deal.id, await classicBody(deal.id));
    expect(revision.status).toBe(201);
    expect(revision.json).toMatchObject({ reference: `0001/${YEAR}r1`, letterheadVersion: 7 });

    const [sentAfter, revised] = await offers(deal.id);
    // the issued offer: its row, snapshot, reference, object and bytes are as they were; none was regenerated
    expect(sentAfter).toEqual(sentBefore!);
    expect(Buffer.from(storedPdf(sentAfter!.objectKey)).equals(bytesBefore)).toBe(true);
    expect(sentAfter!.letterheadVersion).toBeNull();
    expect(revised!.letterheadVersion).toBe(7);
    expect(fake.calls).toHaveLength(1);
    // and it still downloads
    expect((await call("GET", `/deals/${deal.id}/offers/${first.json.id}/download`)).json.url).toContain("?signed");
    // the list shows both: the old one has no version
    const list = await call("GET", `/deals/${deal.id}/offers`);
    expect(list.json.items.map((o: { number: number; letterheadVersion: number | null }) => [o.number, o.letterheadVersion])).toEqual([
      [2, 7],
      [1, null],
    ]);
  });
});

// ─── A service that fails leaves nothing behind ──────────────────────────────────────────────────────────────────────

describe("a service that fails leaves a legacy-template offer as it was (AC-10.6, AC-10.8)", () => {
  beforeEach(() => {
    env.LETTERHEAD_SERVICE_ENABLED = true;
  });

  const cases: { name: string; answers: Answer[]; expected: Record<string, unknown> }[] = [
    { name: "is down", answers: ["network-error"], expected: { status: 503, code: "layout_service_unavailable" } },
    { name: "answers 500", answers: [refusal(500, "internal_error")], expected: { status: 503, code: "layout_service_unavailable" } },
    { name: "has no active letterhead for the entity", answers: [refusal(409, "letterhead_not_configured")], expected: { status: 409, code: "letterhead_not_configured", entity: "welld_ch" } },
    { name: "cannot fit a profile value in the header", answers: [refusal(422, "header_overflow")], expected: { status: 409, code: "letterhead_overflow", frame: "header" } },
  ];

  for (const failing of cases) {
    it(`when it ${failing.name}: no row, no number consumed, no object; the retry takes the same number`, async () => {
      const { deal } = await readyDealWithProfiles();
      const attached = await storedPdfAttachment(deal.id, "annex.pdf", await dealPdf([[200, 300]]));
      const before = await worldOf(deal.id);
      fake.answers = failing.answers;

      const res = await generate(deal.id, await classicBody(deal.id, { attachmentIds: [attached.id] }));
      expect(res.status).toBe(failing.expected["status"] as number);
      expect(res.json).toMatchObject(failing.expected);
      expect(JSON.stringify(res.json)).not.toContain("SECRET");
      expect(await worldOf(deal.id)).toEqual(before);
      expect(bucket.deleted).toEqual([]);

      fake.answers = [];
      const retry = await generate(deal.id, await classicBody(deal.id));
      expect(retry.status).toBe(201);
      expect(retry.json.reference).toBe(`0001/${YEAR}`);
    });
  }

  it("when the service fails on an edit: the offer and its stored PDF are as they were", async () => {
    const { deal } = await readyDealWithProfiles();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const made = await generate(deal.id, await classicBody(deal.id));
    env.LETTERHEAD_SERVICE_ENABLED = true;
    const before = await worldOf(deal.id);

    fake.answers = [refusal(500, "internal_error")];
    const res = await edit(deal.id, made.json.id, await classicBody(deal.id, { validityDays: 45 }), made.json.version);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("layout_service_unavailable");
    expect(await worldOf(deal.id)).toEqual(before);
    expect(bucket.deleted).toEqual([]);
  });

  it("refuses an unreadable deal PDF before it costs a render", async () => {
    const { deal } = await readyDealWithProfiles();
    const bad = await storedPdfAttachment(deal.id, "broken.pdf", new Uint8Array([1, 2, 3]));
    const res = await generate(deal.id, await classicBody(deal.id, { attachmentIds: [bad.id] }));
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("attachment_unreadable");
    expect(fake.calls).toHaveLength(0);
    expect(await offers(deal.id)).toHaveLength(0);
  });
});

// ─── With the switch off ─────────────────────────────────────────────────────────────────────────────────────────────

describe("with the switch off", () => {
  it("crm-api draws the offer as it always did: the service is not asked and no version is recorded", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const { deal } = await readyDealWithProfiles();
    const res = await generate(deal.id, await classicBody(deal.id));
    expect(res.status).toBe(201);
    expect(res.json.letterheadVersion).toBeNull();
    expect(fake.calls).toHaveLength(0);
    const [row] = await offers(deal.id);
    expect(row!.letterheadVersion).toBeNull();
    expect(await textOf(storedPdf(row!.objectKey))).not.toContain("SERVICE-DOCUMENT");
  });
});
