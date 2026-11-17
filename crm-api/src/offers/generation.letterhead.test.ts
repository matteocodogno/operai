/**
 * Offers generated through the layout service (specs/20261116-letterhead-service T29; AC-10.1, AC-10.2, AC-10.6, AC-10.9,
 * AC-10.10; plan § Sequences "Offer generation after the switch"): `POST /deals/{id}/offer-draft/generate` with
 * `LETTERHEAD_SERVICE_ENABLED` on, for a new offer, an edit and a revision.
 *
 * The service is an in-process fake behind the REAL client of T27 (`createLetterheadClient` with a stub `fetch`), so the
 * failure mapping under test is the one that ships. The fake answers a real PDF, made with pdf-lib, whose pages carry their own
 * text and size, so "crm-api drew nothing" and "the deal PDFs come after" are read from the stored bytes, not from a call log.
 * Real Postgres (compose), the assembled app. The switch is flipped on the `env` object, which the routes read at the request.
 *
 * The fake plays letterhead-api's side of the issuer's details too (specs/20261117-legal-entities T28; AC-5.2, AC-6.2): the
 * content is version 2 with NO `entityData`, pinned by `legalEntityVersion`; `fake.issuerVersion` is the version of the
 * registry's details the service holds, and a pin that is not it is the 409 `legal_entity_version_mismatch` of the contract
 * (the crm-api registry fake is `registry`; the service has its own copy, which is what a mismatch is about).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, makeDraftTemplate, readyDealWithProfiles, resetWorld, registry, storedPdfAttachment } from "../test-support/world";
import { completeEntity, incompleteEntity } from "../test-support/fakeRegistry";
import { resetLetterheadMemoForTests } from "../entity-profiles/letterheadUse";
import { env } from "../lib/env";
import { LETTERHEAD_TIMEOUT_MS, createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";

// After the test world, never statically: `generation` pulls in the route guards, which must see the world's mocked JWT check.
const { issuerPinRetry, OFFER_TRANSACTION_TIMEOUT_MS, SERVICE_OFFER_TRANSACTION_TIMEOUT_MS, offerTransactionTimeoutMs } = await import("./generation");

const realPinSleep = issuerPinRetry.sleep;
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
  /** The version of the issuer's details the service holds: a pin that is not it is a 409; null: it holds whatever is pinned. */
  issuerVersion: null as number | null,
  /** The fake clock (ms), advanced only by the retry's injected sleep; with `refuseUntilMs`, the service's coalescing window (T64). */
  clock: 0,
  /** While `clock` is below this, the service answers every request 409 (its forced refresh is coalesced); null: no window. */
  refuseUntilMs: null as number | null,
  /** Every wait `withIssuerPin` asked for before its retry. */
  sleeps: [] as number[],
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

/** What `Legal-Entity-Version` says in a preset answer when the version is "the one that was pinned": the fake fills it in. */
const PINNED = "=pin";

const pdfAnswer = async (over: { version?: number | null; bytes?: Uint8Array; type?: string; issuerVersion?: number | null } = {}) => {
  const bytes = over.bytes ?? (await servicePdf());
  const headers: Record<string, string> = { "Content-Type": over.type ?? "application/pdf", "Page-Count": String(fake.pages), "Unprintable-Characters": "0" };
  const version = over.version === undefined ? fake.version : over.version;
  if (version !== null) headers["Letterhead-Version"] = String(version);
  // The version of the issuer's details the service printed: the pin it was given unless the test says otherwise.
  const printed = over.issuerVersion === undefined ? PINNED : over.issuerVersion === null ? null : String(over.issuerVersion);
  if (printed !== null) headers["Legal-Entity-Version"] = printed;
  return new Response(bytes, { status: 200, headers });
};

const refusal = (status: number, code: string, headers: Record<string, string> = {}, extras: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status, code, detail: "SECRET-SERVICE-DETAIL: the service's own words", ...extras }), {
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
  fake.issuerVersion = null;
  fake.clock = 0;
  fake.refuseUntilMs = null;
  fake.sleeps = [];
  issuerPinRetry.sleep = async (ms) => {
    fake.sleeps.push(ms);
    fake.clock += ms;
  };
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
        const body = JSON.parse(String(init?.body));
        fake.calls.push({ path: `${href.pathname}${href.search}`, authorization: new Headers(init?.headers).get("Authorization"), body });
        // Inside its coalescing window the service has not refreshed yet: the pin is refused whatever it is.
        if (fake.refuseUntilMs !== null && fake.clock < fake.refuseUntilMs) {
          return refusal(409, "legal_entity_version_mismatch", {}, { currentVersion: 7 });
        }
        // The service holds one version of the issuer's details: another pin is the contract's 409, with the version in use.
        if (fake.issuerVersion !== null && body.legalEntityVersion !== fake.issuerVersion) {
          return refusal(409, "legal_entity_version_mismatch", {}, { currentVersion: fake.issuerVersion });
        }
        const answer = fake.answers.length === 0 ? await pdfAnswer() : fake.answers[Math.min(served, fake.answers.length - 1)]!;
        served += 1;
        if (answer === "network-error") throw new TypeError("fetch failed SECRET-NETWORK-DETAIL");
        if (answer === "hang") {
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        // A preset PDF answer prints the version that was pinned.
        if (answer.headers.get("Legal-Entity-Version") === PINNED) {
          const headers = new Headers(answer.headers);
          headers.set("Legal-Entity-Version", String(body.legalEntityVersion));
          return new Response(await answer.clone().arrayBuffer(), { status: answer.status, headers });
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
  issuerPinRetry.sleep = realPinSleep;
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

async function startDraft(entity: "welld_ch" | "welld_it" = "welld_ch", templateOverrides: Record<string, unknown> = {}): Promise<Setup> {
  const { deal } = await readyDealWithProfiles({ entity });
  const template = await makeDraftTemplate({ entity, ...templateOverrides });
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

  it("sends the draft as content version 2: no entityData, the version of the registry's details it used, as the service, asking for the active letterhead version (AC-5.2, AC-6.2)", async () => {
    const s = await startDraft();
    // The registry's details change after the draft was made: the render takes the version of its moment, and the service prints them itself.
    registry.set(
      completeEntity("welld_ch", {
        version: 5,
        legalName: "wellD SA (nuova)",
        address: { it: ["Via Nuova 9", "6900 Lugano"], en: ["Via Nuova 9", "6900 Lugano"] },
        vatNumber: "",
        iban: "",
        ibanPrint: "",
      }),
    );
    const put = await call("PUT", "/entity-profiles/welld_ch", { body: { offerTermsEn: "x", offerTermsIt: "y" } });
    expect(put.status).toBe(200);
    expect((await generate(s)).status).toBe(201);

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/pdf");
    expect(sent!.authorization).toBe("Bearer svc-token");
    expect(sent!.body).toMatchObject({ contentVersion: 2, entity: "welld_ch", language: "it", legalEntityVersion: 5 });
    // the issuer's values are the service's to read: none is sent, not even blank
    expect(sent!.body).not.toHaveProperty("entityData");
    expect(Object.keys(sent!.body).sort()).toEqual(["blocks", "contentVersion", "entity", "language", "legalEntityVersion"]);
    expect(JSON.stringify(sent!.body)).not.toContain("wellD SA (nuova)");
    // the active version is the service's default
    expect(sent!.body).not.toHaveProperty("letterheadVersion");
    // the offer's reference is in the document it renders (the title), not the pending label
    expect(JSON.stringify(sent!.body.blocks)).toContain(`0001/${YEAR}`);
    // the snapshot beside the PDF is made from the same version of the details
    const [row] = await offers(s.dealId);
    expect((row!.snapshot as any).legalEntityVersion).toBe(5);
    expect((row!.snapshot as any).issuer.legalName).toBe("wellD SA (nuova)");
  });

  it("generates the same document as the preview shows: the same blocks and the same version of the issuer's details for the same draft (AC-10.3)", async () => {
    const s = await startDraft();
    const previews: any[] = [];
    const previewSpy = spyOn(letterhead, "preview").mockImplementation(async (content) => {
      previews.push(content);
      return { letterheadVersion: 7, legalEntityVersion: content.legalEntityVersion ?? 0, pageCount: 1, missingPlaceholders: [], unprintableCharacters: 0, pages: [] };
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
    expect(generated!.body.legalEntityVersion).toBe(previewed.legalEntityVersion);
    expect(generated!.body).not.toHaveProperty("entityData");
    expect(previewed).not.toHaveProperty("entityData");
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

  it("refuses an incomplete issuer before the service is asked (AC-10.10, AC-12.7)", async () => {
    const s = await startDraft();
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: "" }));
    const res = await generate(s);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "legal_entity_incomplete", entity: "welld_ch", missing: ["legalName"] });
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
    { name: "answers a PDF that does not say which version of the issuer's details it printed", answers: async () => [await pdfAnswer({ issuerVersion: null })], expected: unavailable },
    { name: "answers a PDF printed with another version of the issuer's details than the one pinned", answers: async () => [await pdfAnswer({ issuerVersion: 99 })], expected: unavailable },
    { name: "is an old letterhead-api that does not know content version 2 (the skew fails closed, decision 6)", answers: async () => [refusal(422, "unsupported_content_version")], expected: unavailable },
    {
      name: "cannot read the registry of the issuer's details (its 503 legal_entities_unavailable, AC-5.5)",
      answers: async () => [refusal(503, "legal_entities_unavailable", { "Retry-After": "5" })],
      expected: unavailable,
    },
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

// ─── One document, one version of the issuer's details (decision 8; AC-6.2) ──────────────────────────────────────────────

/** A wizard template whose body prints the issuer's name and address (`[EMITTENTE]`, `[INDIRIZZO]`): what the pin must keep in step with the frame. */
const ISSUER_SOURCE = [
  "@@salutation Spett.le",
  "",
  "ISSUER-LINE: [EMITTENTE] / [INDIRIZZO]",
  "",
  "## COSTI",
  "@@step costs",
  "@@costs",
  "@@line work one_off | Lavoro | unit=deal | qty=1",
  "@@total **TOTALE**",
  "@@end",
  "",
  "@@field EMITTENTE",
  "source: issuer",
  "",
  "@@field INDIRIZZO",
  "source: issuerAddress",
  "",
].join("\n");

const details = (version: number, legalName: string, street: string) =>
  completeEntity("welld_ch", {
    version,
    legalName,
    address: { it: [street, "6900 Lugano"], en: [street, "6900 Lugano"] },
    vatNumber: "CHE-111.222.333 IVA",
    iban: "CH9300762011623852957",
    ibanPrint: "CH93 0076 2011 6238 5295 7",
  });

const issuerLineOf = (body: any): string => {
  const texts = (body.blocks as any[]).map((block) => (block.type === "paragraph" ? block.runs.map((run: any) => run.text ?? "").join("") : ""));
  const line = texts.find((text) => text.startsWith("ISSUER-LINE:"));
  if (line === undefined) throw new Error(`the request has no issuer line: ${JSON.stringify(texts)}`);
  return line;
};

/** The version of the registry's details crm-api reads after `invalidate()`: the registry's own refresh, as the real client does. */
function refreshesOnInvalidate(next: ReturnType<typeof details>): { restore(): void } {
  const real = registry.invalidate.bind(registry);
  const hook = spyOn(registry, "invalidate").mockImplementation(() => {
    real();
    registry.set(next);
  });
  return { restore: () => hook.mockRestore() };
}

describe("the service prints another version of the issuer's details than crm-api read (AC-6.2)", () => {
  // The registry fake counts every `invalidate()` of the process: a test reads the difference.
  let dropped = 0;
  beforeEach(() => {
    dropped = registry.invalidations;
  });

  it("a 409 legal_entity_version_mismatch once: the cache is dropped, the registry read again, the document and the snapshot rebuilt, ONE retry, and the offer is made from the new version only", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    // The service already holds version 8 (a save was committed and its own copy refreshed); crm-api's registry is read again after the drop.
    fake.issuerVersion = 8;
    const refresh = refreshesOnInvalidate(details(8, "wellD NEW SA", "Via Nuova 2"));
    try {
      const reads = registry.reads;
      const res = await generate(s);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json.reference).toBe(`0001/${YEAR}`);

      // exactly one retry: the first request was pinned to the version crm-api had read, the second to the version it read next
      expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
      expect(registry.invalidations - dropped).toBe(1);
      expect(registry.reads).toBeGreaterThan(reads);
      // the body of each request prints the issuer of ITS version: the document was rebuilt, not re-sent
      expect(issuerLineOf(fake.calls[0]!.body)).toBe("ISSUER-LINE: wellD OLD SA / Via Vecchia 1, 6900 Lugano");
      expect(issuerLineOf(fake.calls[1]!.body)).toBe("ISSUER-LINE: wellD NEW SA / Via Nuova 2, 6900 Lugano");
      for (const call of fake.calls) expect(call.body).not.toHaveProperty("entityData");

      // what is stored is the second version, whole: the snapshot's issuer and version, and the PDF the service answered for it
      const [row] = await offers(s.dealId);
      const snapshot = row!.snapshot as any;
      expect(snapshot.legalEntityVersion).toBe(8);
      expect(snapshot.issuer).toEqual({ legalName: "wellD NEW SA", addressLines: ["Via Nuova 2", "6900 Lugano"], vatNumber: "CHE-111.222.333 IVA", iban: "CH93 0076 2011 6238 5295 7" });
      expect(JSON.stringify(snapshot)).not.toContain("wellD OLD SA");
      expect(row!.letterheadVersion).toBe(7);
      expect(Buffer.from(storedPdf(row!.objectKey)).equals(Buffer.from(await servicePdf()))).toBe(true);
      // the first attempt left nothing: one row, the number the failed attempt did not burn, one object, no draft
      expect(await offers(s.dealId)).toHaveLength(1);
      expect((await sequences()).map((row) => row.last)).toEqual([1]);
      expect(bucket.objects.size).toBe(1);
      expect(bucket.deleted).toEqual([]);
      expect(await db.offerDraft.count()).toBe(0);
    } finally {
      refresh.restore();
    }
  });

  it("a 409 inside the service's one-second refresh window: the retry waits at least 1.1 s (bounded), then the offer is made; nothing was burnt by the first attempt", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    // The service answers 409 for the first second (its forced refresh is coalesced), then 200 for version 8.
    fake.refuseUntilMs = 1000;
    fake.issuerVersion = 8;
    const refresh = refreshesOnInvalidate(details(8, "wellD NEW SA", "Via Nuova 2"));
    try {
      const res = await generate(s);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json.reference).toBe(`0001/${YEAR}`);
      expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
      // exactly one wait, long enough to leave the window and short enough to stay bounded
      expect(fake.sleeps).toHaveLength(1);
      expect(fake.sleeps[0]!).toBeGreaterThanOrEqual(1100);
      expect(fake.sleeps[0]!).toBeLessThanOrEqual(2000);
      expect(fake.clock).toBeGreaterThanOrEqual(1100);
      expect((await sequences()).map((row) => row.last)).toEqual([1]);
      expect(await offers(s.dealId)).toHaveLength(1);
    } finally {
      refresh.restore();
    }
  });

  it("a 409 twice: 503 layout_service_unavailable, exactly two requests, and nothing is left behind (no row, no number, no object, the draft kept)", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    // The service holds version 9; crm-api's registry reads 8 after the drop: still not the service's.
    fake.issuerVersion = 9;
    const refresh = refreshesOnInvalidate(details(8, "wellD NEW SA", "Via Nuova 2"));
    try {
      const before = await worldOf(s);
      const res = await generate(s);
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "layout_service_unavailable" });
      expect(JSON.stringify(res.json)).not.toContain("SECRET");
      expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
      expect(registry.invalidations - dropped).toBe(1);
      expect(await worldOf(s)).toEqual(before);
      expect(bucket.deleted).toEqual([]);
      // when the two agree again the person's retry takes the number that was never burnt
      fake.issuerVersion = 8;
      fake.calls = [];
      const retry = await generate(s);
      expect(retry.status).toBe(201);
      expect(retry.json.reference).toBe(`0001/${YEAR}`);
      expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([8]);
    } finally {
      refresh.restore();
    }
  });

  it("a mismatch that finds the entity incomplete on the second read is that refusal (409 legal_entity_incomplete): no second request, nothing stored", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    fake.issuerVersion = 8;
    const refresh = refreshesOnInvalidate(incompleteEntity("welld_ch", ["vatNumber"], { version: 8 }));
    try {
      const before = await worldOf(s);
      const res = await generate(s);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: "legal_entity_incomplete", entity: "welld_ch", missing: ["vatNumber"] });
      expect(fake.calls).toHaveLength(1);
      expect(await worldOf(s)).toEqual(before);
    } finally {
      refresh.restore();
    }
  });

  it("a mismatch that finds the registry unreadable on the second read is 503 legal_entities_unavailable with Retry-After: 5: no second request, nothing stored", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    fake.issuerVersion = 8;
    const real = registry.invalidate.bind(registry);
    const hook = spyOn(registry, "invalidate").mockImplementation(() => {
      real();
      registry.unavailable();
    });
    try {
      const before = await worldOf(s);
      const res = await generate(s);
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "legal_entities_unavailable" });
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(fake.calls).toHaveLength(1);
      registry.unavailable(false);
      expect(await worldOf(s)).toEqual(before);
    } finally {
      hook.mockRestore();
      registry.unavailable(false);
    }
  });

  it("a pin that matches is not retried and the cache is not dropped", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    fake.issuerVersion = 7;
    expect((await generate(s)).status).toBe(201);
    expect(fake.calls).toHaveLength(1);
    expect(registry.invalidations - dropped).toBe(0);
  });

  it("an EDIT is rebuilt the same way: the same row and reference, the new PDF, the snapshot of the version that was printed, the old object gone", async () => {
    const s = await startDraft("welld_ch", { source: ISSUER_SOURCE });
    registry.set(details(7, "wellD OLD SA", "Via Vecchia 1"));
    expect((await generate(s)).status).toBe(201);
    const [made] = await offers(s.dealId);
    const drafted = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: made!.id } }, headers: noMatch });
    expect(drafted.status).toBe(201);
    const editing: Setup = { dealId: s.dealId, draft: drafted.json };

    fake.calls = [];
    fake.issuerVersion = 8;
    const refresh = refreshesOnInvalidate(details(8, "wellD NEW SA", "Via Nuova 2"));
    try {
      const res = await generate(editing);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
      const [row] = await offers(s.dealId);
      expect(row!.id).toBe(made!.id);
      expect(row!.version).toBe(2);
      expect((row!.snapshot as any).reference).toBe(`0001/${YEAR}`);
      expect((row!.snapshot as any).legalEntityVersion).toBe(8);
      expect((row!.snapshot as any).issuer.legalName).toBe("wellD NEW SA");
      expect(issuerLineOf(fake.calls[1]!.body)).toBe("ISSUER-LINE: wellD NEW SA / Via Nuova 2, 6900 Lugano");
      expect(bucket.objects.has(made!.objectKey)).toBe(false);
      expect(bucket.objects.has(row!.objectKey)).toBe(true);
    } finally {
      refresh.restore();
    }
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
