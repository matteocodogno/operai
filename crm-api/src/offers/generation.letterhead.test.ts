/**
 * Offers generated through the layout service (specs/20261116-letterhead-service T29; AC-10.1, AC-10.2, AC-10.6, AC-10.9,
 * AC-10.10; plan § Sequences "Offer generation after the switch"): `POST /deals/{id}/offer-draft/generate` with
 * `LETTERHEAD_SERVICE_ENABLED` on, for a new offer, an edit and a revision.
 *
 * The service is an in-process fake behind the REAL client of T27 (`createLetterheadClient` with a stub `fetch`), so the
 * failure mapping under test is the one that ships. The fake answers a real PDF, made with pdf-lib, whose pages carry their own
 * text and size, so "crm-api drew nothing" and "the deal PDFs come after" are read from the stored bytes, not from a call log.
 * Real Postgres (compose), the assembled app. The switch is flipped on the `env` object, which the routes read at the request.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, makeDraftTemplate, readyDealWithProfiles, resetWorld, setRetiredLegalColumns, storedPdfAttachment } from "../test-support/world";
import { resetLetterheadMemoForTests } from "../entity-profiles/letterheadUse";
import { env } from "../lib/env";
import { LETTERHEAD_TIMEOUT_MS, createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";

// After the test world, never statically: `generation` pulls in the route guards, which must see the world's mocked JWT check.
const { OFFER_TRANSACTION_TIMEOUT_MS, SERVICE_OFFER_TRANSACTION_TIMEOUT_MS, offerTransactionTimeoutMs } = await import("./generation");

beforeEach(resetWorld);

const YEAR = new Date().getUTCFullYear();
const noMatch = { "If-None-Match": "*" };

// ─── The fake service ────────────────────────────────────────────────────────────────────────────────────────────────

type Answer = Response | "network-error" | "hang";

const fake = {
  /** Every request that reached the service: the path, the bearer and the JSON body. */
  calls: [] as { path: string; authorization: string | null; body: any }[],
  /** What it answers, in order (the last one repeats); empty: a healthy PDF of two pages. */
  answers: [] as Answer[],
  timeoutMs: LETTERHEAD_TIMEOUT_MS,
  version: 7,
  pages: 2,
};

/** The service's PDF: A4 pages that carry their own text, and the service's own title and producer. */
async function servicePdf(pages = fake.pages): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`SERVICE PAGE ${n} OF ${pages}`, { x: 60, y: 700, size: 12, font });
  }
  doc.setTitle("SERVICE-DOCUMENT");
  doc.setProducer("letterhead-api");
  doc.setCreator("letterhead-api");
  return doc.save({ useObjectStreams: false });
}

const pdfAnswer = async (over: { version?: number | null; bytes?: Uint8Array; type?: string } = {}) => {
  const bytes = over.bytes ?? (await servicePdf());
  const headers: Record<string, string> = { "Content-Type": over.type ?? "application/pdf", "Page-Count": String(fake.pages), "Unprintable-Characters": "0" };
  const version = over.version === undefined ? fake.version : over.version;
  if (version !== null) headers["Letterhead-Version"] = String(version);
  return new Response(bytes, { status: 200, headers });
};

const refusal = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ status, code, detail: "SECRET-SERVICE-DETAIL: the service's own words" }), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });

let spy: { mockRestore(): void } | null = null;

function installFakeService(): void {
  fake.calls = [];
  fake.answers = [];
  fake.timeoutMs = LETTERHEAD_TIMEOUT_MS;
  fake.version = 7;
  fake.pages = 2;
  const tokens: ServiceTokenProvider = { getToken: async () => "svc-token", invalidate() {} };
  let served = 0;
  spy = spyOn(letterhead, "pdf").mockImplementation((content, options) =>
    createLetterheadClient({
      baseUrl: "http://letterhead.test",
      tokens,
      timeoutMs: fake.timeoutMs,
      sleep: async () => {},
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const href = new URL(String(url));
        fake.calls.push({ path: `${href.pathname}${href.search}`, authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
        const answer = fake.answers.length === 0 ? await pdfAnswer() : fake.answers[Math.min(served, fake.answers.length - 1)]!;
        served += 1;
        if (answer === "network-error") throw new TypeError("fetch failed SECRET-NETWORK-DETAIL");
        if (answer === "hang") {
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        return answer.clone();
      }) as typeof fetch,
    }).pdf(content, options),
  );
}

const switchWas = env.LETTERHEAD_SERVICE_ENABLED;
beforeEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = true;
  installFakeService();
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
  spy?.mockRestore();
  spy = null;
});

// ─── Reading a stored PDF ────────────────────────────────────────────────────────────────────────────────────────────

/** A PDF of pages of the given sizes: what a deal's file looks like. */
async function dealPdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return doc.save({ useObjectStreams: false });
}

/** The page's drawing instructions, decoded: what was drawn on it, by whoever drew it. */
function contentOf(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1")).join("\n");
}

const sizeOf = (doc: PDFDocument, index: number) => {
  const { width, height } = doc.getPage(index).getSize();
  return `${Math.round(width)}x${Math.round(height)}`;
};

/** A string as the content stream spells it: Helvetica text is a hex string of its bytes. */
const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase();

const storedPdf = (objectKey: string): Uint8Array => bucket.objects.get(objectKey)!.bytes!;

// ─── A draft ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Setup {
  dealId: string;
  draft: { answers: any; version: number; templateVersion: number };
}

async function startDraft(entity: "welld_ch" | "welld_it" = "welld_ch"): Promise<Setup> {
  const { deal } = await readyDealWithProfiles({ entity });
  const template = await makeDraftTemplate({ entity });
  const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  return { dealId: deal.id, draft: created.json };
}

/** Saves `change(answers)` through the API. */
async function edit(s: Setup, change: (answers: any) => void) {
  const answers = structuredClone(s.draft.answers);
  change(answers);
  const res = await call("PUT", `/deals/${s.dealId}/offer-draft`, {
    ifMatch: s.draft.version,
    body: { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers },
  });
  if (res.status !== 200) throw new Error(`save: ${res.status} ${JSON.stringify(res.json)}`);
  s.draft = res.json;
}

const generate = (s: Setup) => call("POST", `/deals/${s.dealId}/offer-draft/generate`, { ifMatch: s.draft.version });
const offers = (dealId: string) => db.dealOffer.findMany({ where: { dealId }, orderBy: { number: "asc" } });
const sequences = () => db.offerSequence.findMany({ orderBy: [{ entity: "asc" }, { year: "asc" }] });

/** What a refused generation must leave exactly as it found it (AC-10.6). */
async function worldOf(s: Setup) {
  return {
    offers: await offers(s.dealId),
    sequences: await sequences(),
    objects: [...bucket.objects.keys()].sort(),
    draft: await db.offerDraft.findUnique({ where: { dealId: s.dealId } }),
  };
}

describe("with the switch on", () => {
  it("takes the pages from the service: its bytes are the offer's PDF, nothing is drawn by crm-api, and the version is stored (AC-10.1, AC-10.2)", async () => {
    const s = await startDraft();
    const res = await generate(s);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ reference: `0001/${YEAR}`, origin: "wizard", version: 1 });

    const [row] = await offers(s.dealId);
    expect(row!.letterheadVersion).toBe(7);
    // The service's answer, byte for byte: crm-api's renderer did not run, and no page number or frame was added to it.
    const stored = storedPdf(row!.objectKey);
    expect(Buffer.from(stored).equals(Buffer.from(await servicePdf()))).toBe(true);
    expect(row!.sizeBytes).toBe(stored.byteLength);
    const doc = await PDFDocument.load(stored, { updateMetadata: false });
    expect(doc.getTitle()).toBe("SERVICE-DOCUMENT");
    expect(doc.getProducer()).toBe("letterhead-api");
    expect(await db.offerDraft.count()).toBe(0);
  });

  it("records the version the service answered, whatever it is (AC-10.2)", async () => {
    const first = await startDraft();
    fake.version = 12;
    expect((await generate(first)).status).toBe(201);
    expect((await offers(first.dealId))[0]!.letterheadVersion).toBe(12);
    const second = await startDraft();
    fake.version = 3;
    expect((await generate(second)).status).toBe(201);
    expect((await offers(second.dealId))[0]!.letterheadVersion).toBe(3);
  });

  it("sends the draft as content version 1 with the entity profile as it is now, as the service, asking for the active version (AC-10.1, AC-10.10)", async () => {
    const s = await startDraft();
    // the profile changes after the draft was made: the render takes the values of its moment
    await setRetiredLegalColumns("welld_ch", { legalName: "wellD SA (nuova)", addressLines: ["Via Nuova 9", "6900 Lugano"], vatNumber: null, iban: null });
    const put = await call("PUT", "/entity-profiles/welld_ch", { body: { offerTermsEn: "x", offerTermsIt: "y" } });
    expect(put.status).toBe(200);
    expect((await generate(s)).status).toBe(201);

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/pdf");
    expect(sent!.authorization).toBe("Bearer svc-token");
    expect(sent!.body).toMatchObject({
      contentVersion: 1,
      entity: "welld_ch",
      language: "it",
      entityData: { legalName: "wellD SA (nuova)", addressLines: ["Via Nuova 9", "6900 Lugano"] },
    });
    // a blank value prints nothing: it is not sent (AC-10.10)
    expect(sent!.body.entityData).not.toHaveProperty("vat");
    expect(sent!.body.entityData).not.toHaveProperty("iban");
    // the active version is the service's default
    expect(sent!.body).not.toHaveProperty("letterheadVersion");
    // the offer's reference is in the document it renders (the title), not the pending label
    expect(JSON.stringify(sent!.body.blocks)).toContain(`0001/${YEAR}`);
  });

  it("generates the same document as the preview shows: the same blocks and entity data for the same draft (AC-10.3)", async () => {
    const s = await startDraft();
    const previews: any[] = [];
    const previewSpy = spyOn(letterhead, "preview").mockImplementation(async (content) => {
      previews.push(content);
      return { letterheadVersion: 7, pageCount: 1, missingPlaceholders: [], unprintableCharacters: 0, pages: [] };
    });
    try {
      const body = { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers: s.draft.answers };
      expect((await call("POST", `/deals/${s.dealId}/offer-draft/preview`, { body })).status).toBe(200);
    } finally {
      previewSpy.mockRestore();
    }
    expect((await generate(s)).status).toBe(201);
    const [previewed] = previews;
    const [generated] = fake.calls;
    expect(generated!.body.entityData).toEqual(previewed.entityData);
    expect(generated!.body.language).toBe(previewed.language);
    expect(generated!.body.blocks.length).toBe(previewed.blocks.length);
    // they differ only where the reference is printed: the preview of a new offer has none yet
    const strip = (blocks: unknown) => JSON.stringify(blocks).replaceAll(`0001/${YEAR}`, "").replace(/\\ue002[^\\]*\\ue003/gi, "");
    expect(strip(generated!.body.blocks).length).toBeLessThanOrEqual(strip(previewed.blocks).length + 4);
  });

  it("appends the deal PDFs after the rendered pages, in the order chosen, unnumbered, and keeps the service's pages as drawn (AC-10.1)", async () => {
    const s = await startDraft();
    const first = await storedPdfAttachment(s.dealId, "first.pdf", await dealPdf([[200, 300], [210, 310]]));
    const second = await storedPdfAttachment(s.dealId, "second.pdf", await dealPdf([[220, 320]]));
    await edit(s, (a) => (a.attachmentIds = [second.id, first.id]));

    const res = await generate(s);
    expect(res.status).toBe(201);
    const [row] = await offers(s.dealId);
    expect(row!.letterheadVersion).toBe(7);
    const doc = await PDFDocument.load(storedPdf(row!.objectKey), { updateMetadata: false });
    const original = await PDFDocument.load(await servicePdf(), { updateMetadata: false });

    expect(doc.getPageCount()).toBe(2 + 3);
    expect(Array.from({ length: 5 }, (_, index) => sizeOf(doc, index))).toEqual(["595x842", "595x842", "220x320", "200x300", "210x310"]);
    // the rendered pages are the service's, instruction for instruction: no number was painted on them
    expect(contentOf(doc, 0)).toBe(contentOf(original, 0));
    expect(contentOf(doc, 1)).toBe(contentOf(original, 1));
    expect(contentOf(doc, 0)).toContain(hex("SERVICE PAGE 1 OF 2"));
    // and the service's own document properties survive the append
    expect(doc.getTitle()).toBe("SERVICE-DOCUMENT");
    expect(doc.getProducer()).toBe("letterhead-api");
    // the snapshot lists the deal PDFs that were appended
    expect((row!.snapshot as any).attachments.map((a: any) => a.fileName)).toEqual(["second.pdf", "first.pdf"]);
    expect(row!.sizeBytes).toBe(storedPdf(row!.objectKey).byteLength);
  });

  it("reads and checks no uploaded letterhead: nothing draws it any more (AC-10.11)", async () => {
    const key = "letterheads/welld_ch/11111111-1111-4111-8111-111111111111.pdf";
    // a stored letterhead that fails the check (not a PDF), which the switch off still refuses
    const unusable = async () => {
      resetLetterheadMemoForTests();
      const bytes = new TextEncoder().encode("not a pdf");
      bucket.objects.set(key, { bytes, contentType: "application/pdf", sizeBytes: bytes.byteLength });
      await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: key, letterheadAt: new Date(), letterheadBy: "user-admin" } });
    };
    const s = await startDraft();
    await unusable();
    const res = await generate(s);
    expect(res.status).toBe(201);
    expect(bucket.reads).not.toContain(key);
    // with the switch off the same profile is checked, as it always was
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const other = await startDraft();
    await unusable();
    const off = await generate(other);
    expect(off.status).toBe(409);
    expect(off.json.code).toBe("letterhead_unusable");
    expect(bucket.reads).toContain(key);
  });

  it("refuses a blank legal name before the service is asked (AC-10.10, AC-12.7)", async () => {
    const s = await startDraft();
    await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { legalName: "  " } });
    const res = await generate(s);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("entity_profile_missing");
    expect(fake.calls).toHaveLength(0);
    expect(await offers(s.dealId)).toHaveLength(0);
  });

  it("checks the deal PDFs before the service is asked: an unreadable one is 422 and costs no render", async () => {
    const s = await startDraft();
    const garbage = await storedPdfAttachment(s.dealId, "broken.pdf", new Uint8Array([1, 2, 3]));
    await edit(s, (a) => (a.attachmentIds = [garbage.id]));
    const before = await worldOf(s);
    const res = await generate(s);
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "attachment_unreadable" });
    expect(fake.calls).toHaveLength(0);
    expect(await worldOf(s)).toEqual(before);
  });
});

describe("a service that fails leaves nothing behind (AC-10.6)", () => {
  const unavailable = { status: 503, code: "layout_service_unavailable" };
  const cases: { name: string; answers: () => Promise<Answer[]>; timeoutMs?: number; expected: Record<string, unknown> }[] = [
    { name: "is down (a network error)", answers: async () => ["network-error"], expected: unavailable },
    { name: "answers 500", answers: async () => [refusal(500, "internal_error")], expected: unavailable },
    { name: "answers 502", answers: async () => [new Response("<html>Bad gateway</html>", { status: 502 })], expected: unavailable },
    { name: "is busy, and still is after the one retry", answers: async () => [refusal(429, "busy", { "Retry-After": "1" })], expected: unavailable },
    { name: "times out", answers: async () => ["hang"], timeoutMs: 40, expected: unavailable },
    { name: "answers a PDF that does not say its version", answers: async () => [await pdfAnswer({ version: null })], expected: unavailable },
    { name: "answers bytes that are not a PDF", answers: async () => [await pdfAnswer({ bytes: new TextEncoder().encode("<html>nope</html>") })], expected: unavailable },
    { name: "refuses the content (a defect of the CRM, not something to retry)", answers: async () => [refusal(422, "invalid_content")], expected: unavailable },
    { name: "has no active letterhead for the entity (AC-10.8)", answers: async () => [refusal(409, "letterhead_not_configured")], expected: { status: 409, code: "letterhead_not_configured" } },
    {
      name: "cannot fit a profile value in the header",
      answers: async () => [refusal(422, "header_overflow")],
      expected: { status: 409, code: "letterhead_overflow", frame: "header", entity: "welld_ch" },
    },
    {
      name: "cannot fit a profile value in the footer",
      answers: async () => [refusal(422, "footer_overflow")],
      expected: { status: 409, code: "letterhead_overflow", frame: "footer", entity: "welld_ch" },
    },
  ];

  for (const failing of cases) {
    it(`when it ${failing.name}: no row, the sequence as it was, no object, the draft as it was; the retry then takes the same number`, async () => {
      // an offer of another deal first, so the sequence has a value that a failed generation must not move
      const other = await startDraft();
      expect((await generate(other)).status).toBe(201);
      expect((await sequences()).map((row) => row.last)).toEqual([1]);

      const s = await startDraft();
      const garbage = await dealPdf([[200, 300]]);
      const attached = await storedPdfAttachment(s.dealId, "annex.pdf", garbage);
      await edit(s, (a) => (a.attachmentIds = [attached.id]));
      const before = await worldOf(s);

      fake.answers = await failing.answers();
      if (failing.timeoutMs !== undefined) fake.timeoutMs = failing.timeoutMs;
      const res = await generate(s);
      expect(res.status).toBe(failing.expected["status"] as number);
      expect(res.json).toMatchObject(failing.expected);
      // the service's own words and the transport's are never the CRM's answer
      expect(JSON.stringify(res.json)).not.toContain("SECRET");
      expect(fake.calls.length).toBeGreaterThanOrEqual(1);

      const after = await worldOf(s);
      expect(after.offers).toHaveLength(0);
      expect(after.sequences).toEqual(before.sequences);
      expect(after.objects).toEqual(before.objects);
      expect(after.draft).toEqual(before.draft);
      // nothing was put and taken back either: the bucket was never written
      expect(bucket.deleted).toEqual([]);

      // the person may try again: the service is back and the offer takes the number the failure did not burn
      fake.answers = [];
      fake.calls = [];
      fake.timeoutMs = LETTERHEAD_TIMEOUT_MS;
      const retry = await generate(s);
      expect(retry.status).toBe(201);
      expect(retry.json.reference).toBe(`0002/${YEAR}`);
      expect((await sequences()).map((row) => row.last)).toEqual([2]);
    });
  }

  it("when an edit of an unsent offer fails, the offer, its stored PDF and the draft are as they were", async () => {
    const s = await startDraft();
    // made before the switch: crm-api's own PDF
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const made = await generate(s);
    expect(made.status).toBe(201);
    env.LETTERHEAD_SERVICE_ENABLED = true;
    const drafted = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: made.json.id } }, headers: noMatch });
    expect(drafted.status).toBe(201);
    const editing: Setup = { dealId: s.dealId, draft: drafted.json };

    const before = await worldOf(editing);
    fake.answers = [refusal(500, "internal_error")];
    const res = await generate(editing);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("layout_service_unavailable");
    expect(await worldOf(editing)).toEqual(before);
    expect(bucket.deleted).toEqual([]);

    // and when it is back: the same row, a new PDF from the service, its version recorded, the old object gone (AC-10.9)
    fake.answers = [];
    const ok = await generate(editing);
    expect(ok.status).toBe(200);
    const [row] = await offers(s.dealId);
    expect(row!.id).toBe(made.json.id);
    expect(row!.letterheadVersion).toBe(7);
    expect(row!.version).toBe(2);
    expect(row!.objectKey).not.toBe(before.offers[0]!.objectKey);
    expect(bucket.objects.has(before.offers[0]!.objectKey)).toBe(false);
    expect(Buffer.from(storedPdf(row!.objectKey)).equals(Buffer.from(await servicePdf()))).toBe(true);
  });
});

describe("offers from before the switch (AC-10.9)", () => {
  it("keep their reference, snapshot, stored PDF and download, byte for byte, while a revision after the switch is made by the service", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const s = await startDraft();
    expect((await generate(s)).status).toBe(201);
    const [old] = await offers(s.dealId);
    expect(old!.letterheadVersion).toBeNull();
    const oldBytes = Buffer.from(storedPdf(old!.objectKey));
    // crm-api's own renderer made it
    expect((await PDFDocument.load(oldBytes, { updateMetadata: false })).getProducer()).toBe("Operai CRM");
    expect((await call("POST", `/deals/${s.dealId}/offers/${old!.id}/sent`)).status).toBe(200);

    env.LETTERHEAD_SERVICE_ENABLED = true;
    // the old offer opens after the switch
    const download = await call("GET", `/deals/${s.dealId}/offers/${old!.id}/download`);
    expect(download.status).toBe(200);
    expect(download.json.url).toContain(old!.objectKey);

    const next = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { templateId: (await db.offerTemplate.findFirstOrThrow()).id }, headers: noMatch });
    expect(next.status).toBe(201);
    const revision = await generate({ dealId: s.dealId, draft: next.json });
    expect(revision.status).toBe(201);
    expect(revision.json.reference).toBe(`0001/${YEAR}r1`);

    const [again, made] = await offers(s.dealId);
    // the old row is the row it was: nothing of it was rewritten
    expect(again).toEqual({ ...old!, sentAt: again!.sentAt, sentBy: again!.sentBy, version: again!.version, updatedAt: again!.updatedAt, updatedBy: again!.updatedBy });
    expect(again!.letterheadVersion).toBeNull();
    expect(again!.snapshot).toEqual(old!.snapshot);
    expect(again!.objectKey).toBe(old!.objectKey);
    expect(Buffer.from(storedPdf(again!.objectKey)).equals(oldBytes)).toBe(true);
    expect(bucket.deleted).not.toContain(old!.objectKey);
    expect(made!.letterheadVersion).toBe(7);
  });

  it("an unsent one that is edited after the switch is drawn by the service with the active letterhead, and records its version", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const s = await startDraft();
    const made = await generate(s);
    expect(made.status).toBe(201);
    env.LETTERHEAD_SERVICE_ENABLED = true;
    const drafted = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: made.json.id } }, headers: noMatch });
    const res = await generate({ dealId: s.dealId, draft: drafted.json });
    expect(res.status).toBe(200);
    const [row] = await offers(s.dealId);
    expect((row!.snapshot as any).reference).toBe(`0001/${YEAR}`);
    expect(row!.letterheadVersion).toBe(7);
  });
});

describe("with the switch off", () => {
  it("is as it always was: crm-api draws the pages, the service is not asked and no version is recorded", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const s = await startDraft();
    const res = await generate(s);
    expect(res.status).toBe(201);
    expect(fake.calls).toHaveLength(0);
    const [row] = await offers(s.dealId);
    expect(row!.letterheadVersion).toBeNull();
    const doc = await PDFDocument.load(storedPdf(row!.objectKey), { updateMetadata: false });
    expect(doc.getProducer()).toBe("Operai CRM");
    expect(doc.getCreator()).toBe("Operai CRM");
    // the page numbers are crm-api's own: "1/N" in the corner of its first page
    expect(contentOf(doc, 0)).toContain(hex(`1/${doc.getPageCount()}`));
  });

  it("even a service that is down is not noticed", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    fake.answers = ["network-error"];
    const s = await startDraft();
    expect((await generate(s)).status).toBe(201);
    expect(fake.calls).toHaveLength(0);
  });
});

/**
 * A hand-written PDF: valid header, trailer and cross-reference table, but a page tree that is missing, malformed or empty.
 * pdf-lib's `PDFDocument.load` accepts these and only the first read of the page tree (`getPageIndices`, `copyPages`) throws.
 */
function pdfWithObjects(objects: string[]): Uint8Array {
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

const withoutPageTree: Record<string, Uint8Array> = {
  "a catalog whose /Pages is missing": pdfWithObjects(["<< /Type /Catalog /Pages 9 0 R >>"]),
  "a /Pages that is not a dictionary": pdfWithObjects(["<< /Type /Catalog /Pages 2 0 R >>", "42"]),
  "a /Pages without /Kids": pdfWithObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 >>"]),
};

describe("a deal PDF that passes the load but has no page tree (T45)", () => {
  for (const [name, bytes] of Object.entries(withoutPageTree)) {
    for (const on of [true, false]) {
      it(`${on ? "through the service" : "on the classic path"}, ${name}: 422 attachment_unreadable, nothing left behind`, async () => {
        env.LETTERHEAD_SERVICE_ENABLED = on;
        const s = await startDraft();
        const broken = await storedPdfAttachment(s.dealId, "no-pages.pdf", bytes);
        await edit(s, (a) => (a.attachmentIds = [broken.id]));
        const before = await worldOf(s);
        const res = await generate(s);
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ code: "attachment_unreadable", field: "attachmentIds", fileName: "no-pages.pdf" });
        // the service is never asked on either path
        expect(fake.calls).toHaveLength(0);
        expect(await worldOf(s)).toEqual(before);
      });
    }
  }
});

describe("the transaction's budget", () => {
  it("outlives the client's 35 s bound with the switch on, so a render cannot outlast its transaction", () => {
    expect(LETTERHEAD_TIMEOUT_MS).toBe(35_000);
    expect(SERVICE_OFFER_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(LETTERHEAD_TIMEOUT_MS);
    env.LETTERHEAD_SERVICE_ENABLED = true;
    expect(offerTransactionTimeoutMs()).toBe(SERVICE_OFFER_TRANSACTION_TIMEOUT_MS);
    expect(offerTransactionTimeoutMs()).toBeGreaterThan(LETTERHEAD_TIMEOUT_MS);
  });

  it("is the 30 s it always was with the switch off", () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect(offerTransactionTimeoutMs()).toBe(OFFER_TRANSACTION_TIMEOUT_MS);
    expect(OFFER_TRANSACTION_TIMEOUT_MS).toBe(30_000);
  });
});

describe("the preview's body limit (T28 finding)", () => {
  const padded = (bytes: number) => JSON.stringify({ templateVersion: 1, target: { kind: "new" }, answers: {}, pad: "x".repeat(bytes) });

  it("is the draft's 512 KiB, not the 64 KiB of a small write", async () => {
    const s = await startDraft();
    const roomy = await call("POST", `/deals/${s.dealId}/offer-draft/preview`, { rawBody: padded(200 * 1024) });
    // the body is read and judged (a 422 for an answer that is not a draft's), not turned away for its size
    expect(roomy.status).not.toBe(413);
    const huge = await call("POST", `/deals/${s.dealId}/offer-draft/preview`, { rawBody: padded(600 * 1024) });
    expect(huge.status).toBe(413);
    expect(huge.json.code).toBe("draft_too_large");
  });
});
