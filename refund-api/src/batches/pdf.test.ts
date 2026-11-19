/**
 * Unit tests for the compiled-batch PDF renderer (T2,
 * specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-pdf-generation-pdf-lib; Unicode-font hardening —
 * OWASP A04, specs/20260719-refund-monthly-processing QE/security finding).
 *
 * `pdf-lib` FlateDecode-compresses content streams by default, so a saved
 * PDF's drawn text never appears as a literal ASCII substring in the raw
 * buffer — `Tj`/`TJ` operators carry it as hex-encoded strings inside a
 * compressed stream.
 *
 * Since the renderer now embeds a CUSTOM Unicode font (Noto Sans, via
 * `@pdf-lib/fontkit`) instead of a standard WinAnsi font, the hex in each
 * `Tj` is a sequence of font-specific CIDs, NOT literal character codes —
 * and (unlike the old standard-font renderer) the CID pdf-lib assigns a
 * given character is NOT a static property of the font file: `pdf-lib`
 * embeds custom fonts as a progressively-built subset, so a character's CID
 * depends on the full history of text already encoded on that SAME `PDFFont`
 * instance earlier in the render. That rules out predicting a line's
 * expected hex from a freshly-built reference font in isolation.
 *
 * Instead, `pdf-lib` embeds a proper `/ToUnicode` CMap alongside every
 * custom font (a `beginbfchar`/`endbfchar` PostScript CMap mapping each CID
 * back to the Unicode codepoint it represents) — exactly what a real PDF
 * viewer/copy-paste/search feature relies on. `extractPdfText` below is a
 * small, self-contained decoder that does what any real PDF text extractor
 * does: load the saved document, read each font resource's `/ToUnicode`
 * CMap, then walk each content stream tracking `Tf` (font-selection)
 * operators and decoding each `Tj` hex run through the CURRENTLY selected
 * font's CID→Unicode map. This is robust to `pdf.ts`'s internal
 * encoding/subsetting details — it decodes the SAME way a real PDF reader
 * would, off the document's own embedded metadata, not a re-implementation
 * of `pdf-lib`'s subset-assignment algorithm.
 *
 * AC coverage (T2 done-when)
 * ──────────────────────────
 * - AC-1.6: header (cutoff/generated/generated-by/batch reference) +
 *   one section per employee + per-currency subtotals, never blended
 * - AC-1.7: no attachment bytes/refs ever appear (this module never reads
 *   Attachment rows at all — asserted by construction, not by a negative
 *   text search, since nothing attachment-shaped is ever passed in)
 * - AC-1.9: a request whose lines are all $0-approved is rendered on the
 *   same terms as any other (not silently dropped)
 * - Determinism (ADR 20260719-refund-batch-pdf-generation-pdf-lib decision 5): two renders of the same input are
 *   byte-identical; employee section order does not depend on input order
 *
 * OWASP A04 coverage (this fix)
 * ──────────────────────────────
 * - A display name carrying emoji/CJK/Cyrillic/Arabic renders without
 *   throwing (previously: `pdf-lib`'s standard Helvetica font threw on any
 *   non-WinAnsi character, which — via `pdfLink.ts`'s lazy-regenerate-on-
 *   miss — made the batch permanently unreadable, AC-1.10).
 */

import { describe, it, expect } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  renderBatchPdf,
  batchPdfObjectKey,
  compareReceiptNumbers,
  compressReceiptNumbers,
  type BatchPdfEmployee,
} from "./pdf";
import { extractPdfText } from "../test-support/pdfText";
import { toBatchPdfEmployees } from "./batches.service";
import type { LineRow } from "../requests/requests.service";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function line(overrides: Partial<LineRow>): LineRow {
  return {
    id: "line-default",
    date: new Date("2026-07-01T00:00:00Z"),
    type: "office_material",
    motivo: "supplies",
    entity: "welld_ch",
    currency: "EUR",
    requestedAmountCents: 0,
    km: null,
    approvedTotalCents: 0,
    ...overrides,
  };
}

const CUTOFF = new Date("2026-07-19T00:00:00Z");
const GENERATED_AT = new Date("2026-07-19T22:15:00Z");
const BATCH_ID = "batch-abc123";
const GENERATED_BY_EMAIL = "accounting@welld.ch";

const aliceEmployee: BatchPdfEmployee = {
  owner: { userId: "u-alice", email: "alice@welld.ch", name: "Alice Anderson" },
  requests: [
    {
      id: "req-alice-1",
      decidedAt: new Date("2026-07-10T22:30:00Z"),
      lines: [
        line({
          id: "l1",
          entity: "welld_ch",
          currency: "EUR",
          requestedAmountCents: 4550,
          approvedTotalCents: 4550,
        }),
        line({
          id: "l2",
          entity: "welld_ch",
          currency: "CHF",
          requestedAmountCents: 9000,
          approvedTotalCents: 9000,
        }),
      ],
    },
  ],
};

// Bob has no display name (null) and every line approved at $0 (AC-1.9).
const bobEmployee: BatchPdfEmployee = {
  owner: { userId: "u-bob", email: "bob@welld.it", name: null },
  requests: [
    {
      id: "req-bob-1",
      lines: [
        line({
          id: "l3",
          entity: "welld_it",
          currency: "EUR",
          requestedAmountCents: 0,
          approvedTotalCents: 0,
        }),
      ],
    },
  ],
};

describe("batchPdfObjectKey", () => {
  it("builds the batch-scoped, PII-free key (ADR 20260719-refund-batch-pdf-generation-pdf-lib § Object storage)", () => {
    expect(batchPdfObjectKey("batch-abc123")).toBe(
      "refund/batches/batch-abc123/compiled.pdf",
    );
  });
});

describe("renderBatchPdf", () => {
  it("renders the AC-1.6 header fields (cutoff, generated, generated-by, batch reference)", async () => {
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [aliceEmployee],
    });

    const text = await extractPdfText(buffer);
    // Same letterhead/grid/format family as the request archive (documentLayout.ts):
    // uppercase labels, civil time in the document zone, never raw ISO.
    expect(text).toContain("Monthly refund batch");
    expect(text).toContain("BATCH REFERENCE");
    expect(text).toContain(BATCH_ID);
    expect(text).toContain("CUTOFF");
    expect(text).toContain("19.07.2026 02:00 (CEST)");
    expect(text).toContain("COMPILED");
    expect(text).toContain(`20.07.2026 00:15 (CEST) ${GENERATED_BY_EMAIL}`);
    expect(text).not.toContain(CUTOFF.toISOString());
    expect(text).toContain(`Page 1 of 1`);
  });

  it("renders one section per employee with per-currency subtotals, never blended", async () => {
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [aliceEmployee, bobEmployee],
    });

    const text = await extractPdfText(buffer);
    expect(text).toContain("Alice Anderson (alice@welld.ch)");
    expect(text).toContain("req-alice-1");
    // Approved-on date in the document zone: 22:30Z on the 10th is the 11th in Zurich.
    expect(text).toContain("11.07.2026");
    // Never blended: EUR and CHF each get their own payout table and subtotal.
    expect(text).toContain("WellD CH, WellD Italia");
    expect(text).toContain("PAYOUTS IN CHF");
    expect(text).toContain("PAYOUTS IN EUR");
    expect(text).toContain("Subtotal — EUR");
    expect(text).toContain("Subtotal — CHF");
    expect(text).toContain("45,50 €");
    expect(text).toContain("90,00 CHF");
    // No combined/blended figure anywhere (e.g. summing 4550+9000 cents).
    expect(text).not.toContain("135,50");
  });

  it("includes a $0-approved request on the same terms as any other (AC-1.9)", async () => {
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [bobEmployee],
    });

    const text = await extractPdfText(buffer);
    // Bob has no display name — falls back to the bare email.
    expect(text).toContain("bob@welld.it");
    expect(text).toContain("req-bob-1");
    expect(text).toContain("0,00 €");
  });

  it("never embeds attachment file bytes or references (AC-1.7)", async () => {
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [aliceEmployee],
    });

    // This module's BatchPdfInput carries no attachment field at all (see
    // pdf.ts — BatchPdfRequest is `{ id, lines }`, LineRow's own
    // `attachments` is never read by the renderer) — nothing attachment-
    // shaped can appear in the output by construction. Sanity-check the
    // buffer stays a small, text-only document (no embedded binary/image
    // XObject bloats it) — the bundled Unicode font's subset embedding adds
    // some fixed overhead versus the old standard-font baseline, so the
    // ceiling here is generously above a single-employee document's actual
    // size (~15KB) while still catching an accidental image/attachment embed.
    expect(buffer.length).toBeLessThan(100_000);
  });

  it("is a deterministic pure function — two renders of the same input are byte-identical", async () => {
    const input = {
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [aliceEmployee, bobEmployee],
    };

    const a = await renderBatchPdf(input);
    const b = await renderBatchPdf(input);

    expect(a.equals(b)).toBe(true);
  });

  it("orders employee sections independent of input order (stable by owner email)", async () => {
    const forward = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [aliceEmployee, bobEmployee],
    });
    const reversed = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [bobEmployee, aliceEmployee],
    });

    expect(forward.equals(reversed)).toBe(true);

    const text = await extractPdfText(forward);
    expect(text.indexOf("alice@welld.ch")).toBeLessThan(text.indexOf("bob@welld.it"));
  });

  it("stays a total function on an empty employee list (never throws)", async () => {
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [],
    });

    const text = await extractPdfText(buffer);
    expect(text).toContain("No requests included in this batch.");
  });

  // ─── OWASP A04 — Unicode display names must never throw (this fix) ───────

  it("renders an emoji + CJK + Cyrillic display name without throwing, and its ASCII parts stay readable (OWASP A04)", async () => {
    const unicodeEmployee: BatchPdfEmployee = {
      owner: {
        userId: "u-unicode",
        email: "unicode@welld.ch",
        name: "\u{1F600} Tánaka 田中太郎 Иван",
      },
      requests: [
        {
          id: "req-unicode-1",
          lines: [
            line({
              id: "l-unicode",
              entity: "welld_ch",
              currency: "EUR",
              requestedAmountCents: 1234,
              approvedTotalCents: 1234,
            }),
          ],
        },
      ],
    };

    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [unicodeEmployee],
    });

    // The previous StandardFonts.Helvetica implementation threw a WinAnsi
    // encode error on this input — reaching here at all is the core
    // assertion. The email (plain ASCII) still round-trips through
    // ToUnicode, confirming the line was actually drawn, not skipped.
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = await extractPdfText(buffer);
    expect(text).toContain("(unicode@welld.ch)");
    expect(text).toContain("12,34 €");
  });

  it("renders a right-to-left (Arabic) display name without throwing (OWASP A04)", async () => {
    const rtlEmployee: BatchPdfEmployee = {
      owner: { userId: "u-rtl", email: "rtl@welld.ch", name: "مرحبا" },
      requests: [
        {
          id: "req-rtl-1",
          lines: [line({ id: "l-rtl", entity: "welld_ch", currency: "EUR" })],
        },
      ],
    };

    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: GENERATED_BY_EMAIL,
      employees: [rtlEmployee],
    });

    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a Unicode generating-user email without throwing (OWASP A04)", async () => {
    // generatedByEmail flows through both a drawn body line AND the PDF
    // Author metadata field — belt-and-braces against non-ASCII local parts.
    const buffer = await renderBatchPdf({
      batchId: BATCH_ID,
      cutoff: CUTOFF,
      generatedAt: GENERATED_AT,
      generatedByEmail: "üñïçødé@welld.ch",
      employees: [aliceEmployee],
    });

    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

// ─── Receipt numbers (T16, specs/20261118-refund-accounting-export, AC-4.9) ───

describe("compressReceiptNumbers", () => {
  it("writes a run of three or more consecutive numbers as first–last sequence", () => {
    expect(compressReceiptNumbers(["MC26/014", "MC26/015", "MC26/016"])).toBe("MC26/014–016");
    expect(compressReceiptNumbers(["MC26/001", "MC26/002", "MC26/003", "MC26/004", "MC26/005"])).toBe("MC26/001–005");
  });

  it("lists one or two numbers in full: a pair saves nothing", () => {
    expect(compressReceiptNumbers(["MC26/014"])).toBe("MC26/014");
    expect(compressReceiptNumbers(["MC26/014", "MC26/015"])).toBe("MC26/014, MC26/015");
  });

  it("breaks the run at a gap, and keeps each run on its own", () => {
    expect(compressReceiptNumbers(["MC26/014", "MC26/015", "MC26/016", "MC26/018", "MC26/020", "MC26/021", "MC26/022", "MC26/023"])).toBe(
      "MC26/014–016, MC26/018, MC26/020–023",
    );
  });

  it("is independent of the order the numbers come in, and drops a duplicate", () => {
    expect(compressReceiptNumbers(["MC26/016", "MC26/014", "MC26/015", "MC26/014"])).toBe("MC26/014–016");
  });

  it("never joins two prefixes: another year or other initials start a new run", () => {
    expect(compressReceiptNumbers(["MC25/001", "MC25/002", "MC25/003", "MC26/004", "MC26/005", "MC26/006"])).toBe(
      "MC25/001–003, MC26/004–006",
    );
    expect(compressReceiptNumbers(["MC26/001", "MC26/002", "AB26/003"])).toBe("AB26/003, MC26/001, MC26/002");
  });

  it("orders by the NUMBER of the sequence, so a run crosses 999 to 1000", () => {
    expect(compressReceiptNumbers(["MC26/1000", "MC26/998", "MC26/999", "MC26/1001"])).toBe("MC26/998–1001");
    expect(compareReceiptNumbers("MC26/999", "MC26/1000")).toBeLessThan(0);
  });

  it("is the empty string for no numbers, and keeps a string that is no receipt number as it is", () => {
    expect(compressReceiptNumbers([])).toBe("");
    expect(compressReceiptNumbers(["MC26/001", "legacy-17"])).toBe("MC26/001, legacy-17");
  });
});

describe("renderBatchPdf — receipt numbers", () => {
  const numbersEmployee = (receiptNumbers: readonly string[] | undefined): BatchPdfEmployee => ({
    owner: { userId: "u-mc", email: "matteo.codogno@welld.ch", name: "Matteo Codogno" },
    requests: [
      {
        id: "req-mc-1",
        decidedAt: new Date("2026-07-10T08:00:00Z"),
        lines: [line({ id: "n1", entity: "welld_ch", currency: "CHF", requestedAmountCents: 1000, approvedTotalCents: 1000 })],
        ...(receiptNumbers ? { receiptNumbers } : {}),
      },
    ],
  });
  const render = (employees: BatchPdfEmployee[]) =>
    renderBatchPdf({ batchId: BATCH_ID, cutoff: CUTOFF, generatedAt: GENERATED_AT, generatedByEmail: GENERATED_BY_EMAIL, employees });

  it("shows a 'Receipt numbers' column with the request's numbers, a consecutive run compressed", async () => {
    const text = await extractPdfText(await render([numbersEmployee(["MC26/014", "MC26/015", "MC26/016", "MC26/020"])]));
    expect(text).toContain("RECEIPT NUMBERS");
    expect(text).toContain("MC26/014–016");
    expect(text).toContain("MC26/020");
    expect(text).not.toContain("MC26/015"); // inside the run, not spelled out
  });

  it("a request with no numbers shows a dash, and the other columns are all still there", async () => {
    const text = await extractPdfText(await render([numbersEmployee([])]));
    expect(text).toContain("RECEIPT NUMBERS");
    expect(text).toContain("req-mc-1");
    expect(text).toContain("10,00 CHF");
    expect(text).not.toContain("MC26/");
  });

  it("falls back to the lines' own receiptNumber when the request carries no list", async () => {
    const employee: BatchPdfEmployee = {
      owner: { userId: "u-mc", email: "mc@welld.ch", name: null },
      requests: [
        {
          id: "req-fallback",
          lines: [
            line({ id: "f1", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/031" }),
            line({ id: "f2", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/032" }),
            line({ id: "f3", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/033" }),
            line({ id: "f4", entity: "welld_ch", currency: "CHF", receiptNumber: null }),
          ],
        },
      ],
    };
    expect(await extractPdfText(await render([employee]))).toContain("MC26/031–033");
  });

  it("the same input renders identical bytes twice, whatever order the numbers were listed in", async () => {
    const forward = await render([numbersEmployee(["MC26/014", "MC26/015", "MC26/016", "MC26/020"])]);
    const again = await render([numbersEmployee(["MC26/014", "MC26/015", "MC26/016", "MC26/020"])]);
    const shuffled = await render([numbersEmployee(["MC26/020", "MC26/016", "MC26/014", "MC26/015"])]);
    expect(forward.equals(again)).toBe(true);
    expect(forward.equals(shuffled)).toBe(true);
  });

  it("many separate numbers wrap inside their cell and the document still renders, with every number present", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `MC26/${String(i * 2 + 1).padStart(3, "0")}`); // 001, 003, 005 …: no run
    const text = await extractPdfText(await render([numbersEmployee(many)]));
    for (const n of [many[0]!, many[17]!, many[39]!]) expect(text).toContain(n);
  });

  it("an old request (numbered before, unnumbered after) renders the same document as one with no numbers at all", async () => {
    const a = await render([numbersEmployee(undefined)]);
    const b = await render([numbersEmployee([])]);
    expect(a.equals(b)).toBe(true);
  });
});

describe("toBatchPdfEmployees — what the compile and the regeneration hand the renderer", () => {
  it("carries each request's receipt numbers, ordered, skipping lines with none", async () => {
    const employees = toBatchPdfEmployees([
      {
        id: "req-1",
        ownerUserId: "u-mc",
        ownerEmail: "mc@welld.ch",
        ownerName: "Matteo Codogno",
        status: "approved",
        decidedAt: new Date("2026-07-10T08:00:00Z"),
        lines: [
          line({ id: "a", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/016" }),
          line({ id: "b", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/014" }),
          line({ id: "c", entity: "welld_ch", currency: "CHF", receiptNumber: "MC26/015" }),
          line({ id: "d", entity: "welld_ch", currency: "CHF", receiptNumber: null }),
        ],
      },
    ]);
    expect(employees[0]!.requests[0]!.receiptNumbers).toEqual(["MC26/014", "MC26/015", "MC26/016"]);
    const text = await extractPdfText(
      await renderBatchPdf({ batchId: BATCH_ID, cutoff: CUTOFF, generatedAt: GENERATED_AT, generatedByEmail: GENERATED_BY_EMAIL, employees }),
    );
    expect(text).toContain("MC26/014–016");
  });
});
