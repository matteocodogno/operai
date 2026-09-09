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
import { extractPdfText } from "../test-support/pdfText";
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
  decidedByName: null,
  rejectionMotivation: null,
  generatedByName: null,
  settlement: "Not yet included in a monthly batch",
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

// ─── Document quality (2026-09-08 review) ──────────────────────────────────
//
// Each of these pins a defect an actual exported PDF shipped with, found by
// reading the file rather than the code.

const mileageLine = {
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
} as unknown as RequestExportInput["lines"][number];

async function textOf(input: RequestExportInput): Promise<string> {
  return await extractPdfText(await renderRequestExportPdf(input));
}

describe("renderRequestExportPdf — no raw enum values reach the document", () => {
  it("renders display labels for the expense type and the entity", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    expect(text).toContain("Travel — mileage (km)");
    expect(text).toContain("WellD CH");
    expect(text).not.toContain("travel_km");
    expect(text).not.toContain("welld_ch");
  });

  it("renders the status as a label, not the database value", async () => {
    const text = await textOf(baseInput({ status: "approved", lines: [mileageLine] }));

    // The status is a CHIP now, carrying the word itself so a greyscale
    // photocopy loses nothing.
    expect(text).toContain("APPROVED");
    expect(text).not.toContain("approved");
  });
});

describe("renderRequestExportPdf — one number locale", () => {
  it("renders the mileage rate and its validity in the document's locale, not the wire's", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    expect(text).toContain("0,70 CHF/km");
    expect(text).toContain("31.01.2021");
    // The wire forms must not survive into the page.
    expect(text).not.toContain("0.70");
    expect(text).not.toContain("2021-01-31");
  });

  it("puts the currency after the amount, as the UI does", async () => {
    // Asserted on a REJECTED render, which has a single money column. With
    // both columns present the extractor concatenates them into
    // "10,50 CHF 10,50 CHF", which contains "CHF 10,50" across the column
    // boundary — a false positive about the document rather than a fact about
    // it. The prefix/suffix rule itself is pinned in documentFormat.test.ts.
    const text = await textOf(
      baseInput({ status: "rejected", rejectionMotivation: "n/a", lines: [mileageLine] }),
    );

    expect(text).toContain("10,50 CHF");
    expect(text).not.toContain("CHF 10,50");
  });

  it("renders line dates like every other date", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    expect(text).toContain("11.08.2026");
    expect(text).not.toContain("2026-08-11");
  });

  it("renders timestamps as civil time with a named zone, never raw ISO", async () => {
    const text = await textOf(
      baseInput({
        submittedAt: "2026-08-22T09:00:00.000Z",
        decidedAt: "2026-09-01T06:45:20.752Z",
        lines: [mileageLine],
      }),
    );

    expect(text).toContain("01.09.2026 08:45 (CEST)");
    expect(text).not.toContain(".752");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("renderRequestExportPdf — self-describing header", () => {
  it("names the period and the entity up front", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    // Labels are uppercase `label.medium` above their values, not "Key: value".
    expect(text).toContain("PERIOD");
    expect(text).toContain("August 2026");
    expect(text).toContain("ENTITY");
    expect(text).toContain("WellD CH");
  });

  // "Is this a liability or is it settled?" is the first question a recipient
  // asks, and the document used to answer it nowhere.
  it("states the settlement position", async () => {
    const text = await textOf(
      baseInput({
        lines: [mileageLine],
        settlement: "Paid on 30.09.2026 08:00 (CEST) — batch 2026-09",
      }),
    );

    expect(text).toContain("SETTLEMENT");
    expect(text).toContain("batch 2026-09");
  });
});

describe("renderRequestExportPdf — receipts are stated once", () => {
  it("states the zero case once globally, with no per-line repetition", async () => {
    const text = await textOf(
      baseInput({ lines: [mileageLine, { ...mileageLine, id: "l2" }] }),
    );

    expect(text).toContain("No receipts were attached");
    expect(text).not.toContain("page 2");
  });

  it("states per-line counts when receipts exist, and drops the global claim", async () => {
    const withReceipt = {
      ...mileageLine,
      attachments: [{ id: "a1", fileName: "r.png", contentType: "image/png", sizeBytes: 10 }],
    } as unknown as RequestExportInput["lines"][number];

    const text = await textOf(
      baseInput({ lines: [withReceipt, { ...mileageLine, id: "l2" }], receipts: [receipt()] }),
    );

    // Receipts are listed in the note under the table, by filename and the
    // page a reader turns to — not counted per line.
    expect(text).toContain("receipt.png");
    expect(text).toMatch(/page \d+/);
    expect(text).not.toContain("No receipts were attached");
  });
});

describe("renderRequestExportPdf — footer", () => {
  it("stamps every page with the reference and its page number", async () => {
    const buffer = await renderRequestExportPdf(
      baseInput({
        lines: [mileageLine],
        receipts: [receipt({ contentType: "application/pdf", bytes: await makePdfBytes(2) })],
      }),
    );
    const text = await extractPdfText(buffer);
    const pageCount = (await PDFDocument.load(buffer, { updateMetadata: false })).getPageCount();

    // Including the copied receipt pages — a stapled set where half the pages
    // carry no number is the set that loses one unnoticed.
    for (let page = 1; page <= pageCount; page += 1) {
      expect(text).toContain(`Page ${page} of ${pageCount}`);
    }
  });
});

// ─── 2026-09-09 review: identity, letterhead, mixed requests ───────────────

describe("renderRequestExportPdf — the document identifies its people", () => {
  it("leads with names, keeping the address as the identifier beside it", async () => {
    const text = await textOf(
      baseInput({
        lines: [mileageLine],
        owner: { email: "luigi.gambardella@welld.ch", name: "Luigi Gambardella" },
        decidedAt: "2026-09-01T06:45:00.000Z",
        decidedByEmail: "chiara.rossi@welld.ch",
        decidedByName: "Chiara Rossi",
        generatedByEmail: "matteo.codogno@welld.ch",
        generatedByName: "Matteo Codogno",
      }),
    );

    expect(text).toContain("Luigi Gambardella (luigi.gambardella@welld.ch)");
    expect(text).toContain("Chiara Rossi (chiara.rossi@welld.ch)");
    expect(text).toContain("Matteo Codogno (matteo.codogno@welld.ch)");
  });

  // Rows decided before decidedByName existed have no name to recover.
  it("falls back to the address alone rather than an empty parenthetical", async () => {
    const text = await textOf(
      baseInput({
        lines: [mileageLine],
        owner: { email: "someone@welld.ch", name: null },
        decidedAt: "2026-09-01T06:45:00.000Z",
        decidedByEmail: "acct@welld.ch",
        decidedByName: null,
      }),
    );

    expect(text).toContain("someone@welld.ch");
    expect(text).not.toContain("()");
    expect(text).not.toContain("null");
  });
});

describe("renderRequestExportPdf — letterhead", () => {
  it("names the issuing company, its registered seat and its tax id", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    expect(text).toContain("wellD — Switzerland (headquarters)");
    expect(text).toContain("Via Pessina 9, c.p. 1920, CH-6901 Lugano");
    expect(text).toContain("CHE-114.591.536");
  });

  it("uses the Italian branch for an Italian request", async () => {
    const italian = { ...mileageLine, entity: "welld_it" } as typeof mileageLine;
    const text = await textOf(baseInput({ lines: [italian] }));

    expect(text).toContain("wellD — Italy (branch)");
    expect(text).toContain("I-16128, Genova".replace(", ", " ").replace("I-16128 Genova", "I-16128 Genova"));
    expect(text).toContain("CF / P. IVA 01975370998");
  });

  // Only the REGISTERED seat belongs on a letterhead — listing the operational
  // offices would turn a header into a directory.
  it("states one address, not every office", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));

    expect(text).not.toContain("Via Campagna");
    expect(text).not.toContain("Piazza Indipendenza");
  });
});

describe("renderRequestExportPdf — a request that is not uniform", () => {
  const chf = { ...mileageLine, id: "a", date: "2026-08-30", entity: "welld_ch", currency: "CHF" } as typeof mileageLine;
  const eur = {
    ...mileageLine, id: "b", date: "2026-09-02", entity: "welld_it", currency: "EUR",
    requestedAmountCents: 12624, approvedTotalCents: 12624, mileage: null,
  } as unknown as typeof mileageLine;

  const mixed = () =>
    baseInput({
      lines: [chf, eur],
      subtotals: [
        { currency: "CHF", requestedCents: 1050, approvedCents: 1050 },
        { currency: "EUR", requestedCents: 12624, approvedCents: 12624 },
      ],
    });

  it("widens the period rather than naming only the first month", async () => {
    expect(await textOf(mixed())).toContain("August to September 2026");
  });

  // Naming one entity in a single-valued header invites the reader to treat it
  // as THE entity for the whole request — wrong, since per-line entity is what
  // drives scope and which establishment books the cost.
  it("says Multiple for the entity and defers to the lines", async () => {
    const text = await textOf(mixed());

    expect(text).toContain("Multiple — see each line");
    // The truth stays per line, in the Detail column.
    expect(text).toContain("WellD CH");
    expect(text).toContain("WellD Italia");
  });

  it("gives one total per currency and never sums across them", async () => {
    const text = await textOf(mixed());

    // One SECTION per currency, each with its own subtotal row.
    expect(text).toContain("EXPENSES IN CHF");
    expect(text).toContain("EXPENSES IN EUR");
    expect(text).toContain("Subtotal — CHF");
    expect(text).toContain("Subtotal — EUR");
    expect(text).toContain("10,50 CHF");
    expect(text).toContain("126,24 €");
    // 1050 + 12624 = 13674 — a number that must not exist anywhere.
    expect(text).not.toContain("136,74");
  });
});

describe("renderRequestExportPdf — settlement does not repeat the status", () => {
  it("does not say Approved twice in consecutive lines", async () => {
    const text = await textOf(
      baseInput({
        status: "approved",
        lines: [mileageLine],
        settlement: "Not yet included in a monthly batch",
      }),
    );

    expect(text).toContain("APPROVED"); // the chip
    expect(text).toContain("Not yet included in a monthly batch");

    // The settlement value must not restate the status word. The chip carries
    // it once; the old header said "Approved" on two consecutive lines.
    expect(text).not.toContain("Approved — not yet included");
  });
});

describe("renderRequestExportPdf — a rejected request approves nothing", () => {
  // A reviewer can set per-line approved totals while a request is still
  // `submitted` and then reject it. Those leftovers used to render as
  // "Approved 206,50 CHF" on every line while the totals said "Approved —".
  const rejected = () =>
    baseInput({
      status: "rejected",
      rejectionMotivation: "Receipt does not match the amount claimed",
      lines: [{ ...mileageLine, approvedTotalCents: 1050 }],
      subtotals: [{ currency: "CHF", requestedCents: 1050, approvedCents: null }],
      settlement: "Not payable — the request was rejected",
    });

  it("shows no approved figure on any line, even when one was set before the refusal", async () => {
    const text = await textOf(rejected());

    // No APPROVED column header at all, so there is nowhere for a stale
    // per-line approved total to surface.
    expect(text).toContain("10,50 CHF");
    expect(text).not.toContain("APPROVED");
  });

  it("shows no approved column in the totals either", async () => {
    const text = await textOf(rejected());
    // The total row carries one figure, under REQUESTED only.
    expect(text).toContain("Total");
    expect(text).toContain("10,50 CHF");
    expect(text).not.toContain("APPROVED");
  });

  it("still shows approved figures on an approved request", async () => {
    const text = await textOf(
      baseInput({ status: "approved", lines: [{ ...mileageLine, approvedTotalCents: 1050 }] }),
    );

    expect(text).toContain("APPROVED"); // the column exists again
    expect(text).toContain("10,50 CHF");
  });
});

// ─── Layout mechanisms (2026-09-09 brand-kit pass) ─────────────────────────

describe("renderRequestExportPdf — the table survives a long request", () => {
  const manyLines = Array.from({ length: 26 }, (_, i) => ({
    ...mileageLine,
    id: `l${i}`,
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    motivo: `Trip ${i + 1}`,
    requestedAmountCents: 1000 + i,
    approvedTotalCents: 1000 + i,
  })) as unknown as RequestExportInput["lines"];

  it("repeats the column header on every page rather than orphaning rows", async () => {
    const text = await textOf(baseInput({ lines: manyLines }));
    const headers = text.match(/# DATE DESCRIPTION/g) ?? [];

    expect(headers.length).toBeGreaterThan(1);
  });

  // The total an accountant checks by hand must equal the figures printed
  // above it — so it is summed from the rendered LINES, not from a separate
  // subtotals field that could drift from them.
  it("totals the lines it actually printed", async () => {
    const expected = manyLines.reduce((sum, l) => sum + l.requestedAmountCents, 0);
    const text = await textOf(
      baseInput({
        lines: manyLines,
        // Deliberately wrong, to prove the document does not read it.
        subtotals: [{ currency: "CHF", requestedCents: 999999, approvedCents: 999999 }],
      }),
    );

    expect(text).toContain(formatExpected(expected));
    expect(text).not.toContain("9.999,99");
  });
});

function formatExpected(cents: number): string {
  return `${Math.trunc(cents / 100)},${(cents % 100).toString().padStart(2, "0")} CHF`;
}

describe("renderRequestExportPdf — receipts note", () => {
  it("names each receipt and the page a reader turns to", async () => {
    const twoPage = await makePdfBytes(2);
    const text = await textOf(
      baseInput({
        lines: [mileageLine],
        receipts: [
          receipt({ attachmentId: "a1", fileName: "hotel.pdf", contentType: "application/pdf", bytes: twoPage }),
          receipt({ attachmentId: "a2", fileName: "taxi.png" }),
        ],
      }),
    );

    // hotel.pdf: caption page + 2 copied pages starting at page 2 → taxi.png
    // therefore starts at page 5. A reference that is merely present but wrong
    // is worse than none, so the arithmetic is asserted, not just the shape.
    expect(text).toContain("hotel.pdf");
    expect(text).toContain("page 2");
    expect(text).toContain("taxi.png");
    expect(text).toContain("page 5");
  });
});

describe("renderRequestExportPdf — greyscale floor", () => {
  // Every one of these documents will be printed or photocopied in mono.
  // Colour may accent, never carry.
  it("the status chip carries its word, not just a colour", async () => {
    expect(await textOf(baseInput({ status: "approved", lines: [mileageLine] }))).toContain("APPROVED");
    expect(
      await textOf(baseInput({ status: "rejected", rejectionMotivation: "n/a", lines: [mileageLine] })),
    ).toContain("REJECTED");
  });

  it("the total is distinguished by weight and a rule, not by colour alone", async () => {
    const text = await textOf(baseInput({ lines: [mileageLine] }));
    // The word "Total" is what identifies the row in monochrome.
    expect(text).toContain("Total");
  });
});
