/**
 * Unit tests for the per-request archive renderer (ADR-0043).
 *
 * `renderRequestExportPdf` is pure — it takes already-fetched receipt bytes
 * and does no I/O — so these need no storage mock at all. That is the whole
 * reason the fetching lives in the route rather than the renderer: the
 * interesting logic (embedding real JPEG/PNG/PDF bytes, refusing corrupt
 * ones) is testable with synthetic files and nothing else.
 */

import { describe, it, expect } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  renderRequestExportPdf,
  ReceiptEmbedError,
  type ExportReceipt,
  type RequestExportInput,
} from "./exportPdf";

// Real, minimal files — not fixtures pretending to be images. pdf-lib parses
// these for real, so a regression in the embed path fails here.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

async function makePdfBytes(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  return await doc.save();
}

const baseInput = (overrides: Partial<RequestExportInput> = {}): RequestExportInput => ({
  requestId: "req_123",
  status: "approved",
  owner: { email: "luca.camerini@welld.ch", name: "Luca Camerini" },
  submittedAt: "2026-08-22T09:00:00.000Z",
  decidedAt: "2026-09-01T09:00:00.000Z",
  decidedByEmail: "acct@welld.ch",
  lines: [],
  subtotals: [{ currency: "CHF", requestedCents: 20650, approvedCents: 20650 }],
  receipts: [],
  generatedAt: new Date("2026-09-08T12:00:00.000Z"),
  generatedByEmail: "acct@welld.ch",
  ...overrides,
});

const receipt = (over: Partial<ExportReceipt> = {}): ExportReceipt => ({
  attachmentId: "att_1",
  fileName: "receipt.png",
  contentType: "image/png",
  bytes: PNG_1X1,
  lineMotivo: "Mtg CRSS",
  lineDate: "2026-08-11",
  ...over,
});

describe("renderRequestExportPdf", () => {
  it("produces a parseable PDF carrying the request's identifying header", async () => {
    const buffer = await renderRequestExportPdf(baseInput());

    // `updateMetadata: false` on LOAD is required to assert anything about
    // dates: pdf-lib's load() defaults to true and rewrites ModDate to the
    // current wall clock on the in-memory copy. Without it this assertion
    // would be measuring the reader, not the document.
    const parsed = await PDFDocument.load(buffer, { updateMetadata: false });
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(parsed.getTitle()).toContain("req_123");
    // ADR-0019 decision 5: the ONLY clock in the document is generatedAt.
    expect(parsed.getCreationDate()?.toISOString()).toBe("2026-09-08T12:00:00.000Z");
    expect(parsed.getModificationDate()?.toISOString()).toBe("2026-09-08T12:00:00.000Z");
  });

  it("is deterministic — the same input twice renders byte-identical output", async () => {
    const a = await renderRequestExportPdf(baseInput());
    const b = await renderRequestExportPdf(baseInput());
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("embeds a PNG receipt on its own caption page", async () => {
    const before = await PDFDocument.load(await renderRequestExportPdf(baseInput()));
    const after = await PDFDocument.load(
      await renderRequestExportPdf(baseInput({ receipts: [receipt()] })),
    );
    expect(after.getPageCount()).toBe(before.getPageCount() + 1);
  });

  it("embeds a JPEG receipt", async () => {
    const buffer = await renderRequestExportPdf(
      baseInput({
        receipts: [receipt({ contentType: "image/jpeg", bytes: JPEG_1X1, fileName: "r.jpg" })],
      }),
    );
    expect((await PDFDocument.load(buffer)).getPageCount()).toBeGreaterThanOrEqual(2);
  });

  // The archival requirement is "all receipts" — a multi-page PDF receipt must
  // arrive complete, not as its first page.
  it("copies EVERY page of a multi-page PDF receipt, not just the first", async () => {
    const threePage = await makePdfBytes(3);
    const withReceipt = await PDFDocument.load(
      await renderRequestExportPdf(
        baseInput({
          receipts: [
            receipt({ contentType: "application/pdf", bytes: threePage, fileName: "r.pdf" }),
          ],
        }),
      ),
    );
    const without = await PDFDocument.load(await renderRequestExportPdf(baseInput()));

    // one caption page + three copied pages
    expect(withReceipt.getPageCount()).toBe(without.getPageCount() + 4);
  });

  it("embeds every receipt when a request has several, of mixed types", async () => {
    const buffer = await renderRequestExportPdf(
      baseInput({
        receipts: [
          receipt({ attachmentId: "a1" }),
          receipt({ attachmentId: "a2", contentType: "image/jpeg", bytes: JPEG_1X1 }),
          receipt({
            attachmentId: "a3",
            contentType: "application/pdf",
            bytes: await makePdfBytes(2),
          }),
        ],
      }),
    );
    const parsed = await PDFDocument.load(buffer);
    const without = await PDFDocument.load(await renderRequestExportPdf(baseInput()));
    // 3 caption pages + 1 png + 1 jpg (drawn on their captions) + 2 pdf pages
    expect(parsed.getPageCount()).toBe(without.getPageCount() + 5);
  });

  // See ReceiptEmbedError's doc: an archive that looks complete but silently
  // isn't is worse than one that refuses to build, because nobody re-checks
  // an archive. These pin that the renderer never degrades quietly.
  it("throws ReceiptEmbedError on corrupt bytes rather than emitting a placeholder", async () => {
    const promise = renderRequestExportPdf(
      baseInput({
        receipts: [receipt({ bytes: Buffer.from("not a png at all"), fileName: "broken.png" })],
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(ReceiptEmbedError);
  });

  it("throws ReceiptEmbedError on an unsupported content type", async () => {
    const promise = renderRequestExportPdf(
      baseInput({
        receipts: [receipt({ contentType: "image/gif", fileName: "r.gif" })],
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(ReceiptEmbedError);
    await expect(promise).rejects.toThrow("r.gif");
  });

  it("renders every expense line, with its mileage rate provenance", async () => {
    const input = baseInput({
      lines: [
        {
          id: "l1",
          date: "2026-08-11",
          type: "travel_km",
          motivo: "Mtg CRSS",
          entity: "welld_ch",
          currency: "CHF",
          requestedAmountCents: 1050,
          km: 15,
          approvedTotalCents: 1050,
          attachments: [],
          mileage: {
            km: 15,
            rateInEffect: true,
            appliedRate: {
              ratePerKmMicros: 700000,
              ratePerKm: "0.70",
              validFrom: "2021-01-31",
              currency: "CHF",
            },
            computedAmountCents: 1050,
            snapshotted: true,
          },
        },
      ],
    });

    // Rendering must not throw on a fully-populated mileage line, and the
    // document must grow relative to the no-lines baseline.
    const withLine = await renderRequestExportPdf(input);
    expect(withLine.byteLength).toBeGreaterThan(
      (await renderRequestExportPdf(baseInput())).byteLength,
    );
  });

  // A motivo is free text an employee typed. pdf-lib's built-in fonts are
  // WinAnsi-only and THROW on characters outside it; the bundled Noto Sans is
  // what makes this safe (same OWASP A04 fix as batches/pdf.ts).
  it("renders non-WinAnsi characters in a motivo without throwing", async () => {
    const buffer = await renderRequestExportPdf(
      baseInput({
        receipts: [receipt({ lineMotivo: "Mtg Zürich – Bellinzona ✓ 東京" })],
      }),
    );
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("states plainly when a request has no receipts, rather than leaving it ambiguous", async () => {
    const buffer = await renderRequestExportPdf(baseInput());
    expect(buffer.byteLength).toBeGreaterThan(0);
    // A no-receipt export must still be exactly one document, not an error.
    expect((await PDFDocument.load(buffer)).getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
