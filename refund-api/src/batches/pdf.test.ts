/**
 * Unit tests for the compiled-batch PDF renderer (T2,
 * specs/008-refund-monthly-processing, ADR-0019; Unicode-font hardening —
 * OWASP A04, specs/008 QE/security finding).
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
 * - Determinism (ADR-0019 decision 5): two renders of the same input are
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
import zlib from "node:zlib";
import { PDFArray, PDFDocument, PDFDict, PDFName, PDFStream, type PDFRef } from "pdf-lib";
import { renderBatchPdf, batchPdfObjectKey, type BatchPdfEmployee } from "./pdf";
import type { LineRow } from "../requests/requests.service";

// ─── PDF text extraction via the document's own embedded ToUnicode CMaps
//     (see module doc — this is NOT a re-prediction of pdf-lib's internal
//     glyph/CID assignment, it decodes exactly like a real PDF reader) ─────

/** Parses a `beginbfchar…endbfchar` / `beginbfrange…endbfrange` ToUnicode CMap into CID(hex) → text. */
function parseToUnicodeCMap(cmapText: string): Map<string, string> {
  const map = new Map<string, string>();

  const utf16beHexToString = (hex: string): string => {
    const bytes = Buffer.from(hex, "hex");
    let text = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(bytes.readUInt16BE(i));
    }
    return text;
  };

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let section: RegExpExecArray | null;
  while ((section = bfcharRe.exec(cmapText))) {
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = entryRe.exec(section[1] as string))) {
      const cid = (entry[1] as string).toUpperCase().padStart(4, "0");
      map.set(cid, utf16beHexToString(entry[2] as string));
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((section = bfrangeRe.exec(cmapText))) {
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = entryRe.exec(section[1] as string))) {
      const lo = parseInt(entry[1] as string, 16);
      const hi = parseInt(entry[2] as string, 16);
      const dstStart = parseInt(entry[3] as string, 16);
      for (let cid = lo; cid <= hi; cid++) {
        map.set(cid.toString(16).toUpperCase().padStart(4, "0"), String.fromCharCode(dstStart + (cid - lo)));
      }
    }
  }

  return map;
}

/** Builds resource-name (`/Foo-123`) → CID-to-Unicode map, across every page's font resources. */
function buildFontCidMaps(doc: PDFDocument): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const page of doc.getPages()) {
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fontDict) continue;
    for (const [name, ref] of fontDict.entries()) {
      // `PDFName.asString()` already includes the leading `/` — do not
      // re-prefix it (that produced a silently-never-matching `//Name` key
      // here, against which `Tf`'s `/name` regex capture — WITHOUT the
      // slash — never matched either, however this was still keyed).
      const resourceName = name.asString();
      if (result.has(resourceName)) continue;
      const fontObj = doc.context.lookup(ref as PDFRef, PDFDict);
      const toUnicodeRef = fontObj.get(PDFName.of("ToUnicode"));
      if (!toUnicodeRef) continue;
      const stream = doc.context.lookup(toUnicodeRef as PDFRef, PDFStream);
      const inflated = zlib.inflateSync(Buffer.from(stream.getContents())).toString("latin1");
      result.set(resourceName, parseToUnicodeCMap(inflated));
    }
  }
  return result;
}

/**
 * Inflates a stream's contents, falling back to the raw bytes if it isn't
 * Flate-compressed (defensive — `pdf-lib` always Flate-compresses the
 * streams this module reads, but this keeps the helper honest either way).
 */
function inflateStream(stream: PDFStream): string {
  const raw = Buffer.from(stream.getContents());
  try {
    return zlib.inflateSync(raw).toString("latin1");
  } catch {
    return raw.toString("latin1");
  }
}

/**
 * Resolves a page's `/Contents` entry (a single stream, or an array of
 * streams — the PDF spec allows both) into its constituent `PDFStream`s.
 * Deliberately does NOT scan the raw file bytes for literal `stream`/
 * `endstream` markers — the renderer embeds actual binary TrueType font
 * program data (`FontFile2`) alongside the content streams, and that binary
 * data can coincidentally contain those ASCII byte sequences, which
 * misaligns a naive text-scan. Going through `pdf-lib`'s own parsed object
 * graph (already correctly framed via the file's xref/Length entries when
 * `PDFDocument.load` ran) sidesteps that entirely.
 */
function getContentStreams(doc: PDFDocument, page: ReturnType<PDFDocument["getPage"]>): PDFStream[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((ref) => doc.context.lookup(ref as PDFRef, PDFStream));
  }
  return [contents as PDFStream];
}

/**
 * Decodes a rendered batch PDF back into a plain-text approximation of what
 * it visually renders — one space-joined string per drawn `Tj` run, in
 * document order, via each active font's embedded `/ToUnicode` CMap.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const doc = await PDFDocument.load(buffer);
  const cidMaps = buildFontCidMaps(doc);

  const parts: string[] = [];
  for (const page of doc.getPages()) {
    for (const stream of getContentStreams(doc, page)) {
      const inflated = inflateStream(stream);
      if (!inflated.includes(" Tj")) continue; // not a text-drawing content stream

      // Track which font resource is active (last `/Name size Tf`) so each
      // `Tj` hex run decodes through the RIGHT font's CID map.
      const tokenRe = /\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj/g;
      let activeMap: Map<string, string> | undefined;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(inflated))) {
        if (token[1] !== undefined) {
          activeMap = cidMaps.get(`/${token[1]}`);
        } else if (token[2] !== undefined) {
          const hex = token[2];
          let text = "";
          for (let i = 0; i < hex.length; i += 4) {
            text += activeMap?.get(hex.slice(i, i + 4).toUpperCase()) ?? "�";
          }
          parts.push(text);
        }
      }
    }
  }
  return parts.join(" ");
}

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
  it("builds the batch-scoped, PII-free key (ADR-0019 § Object storage)", () => {
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
    expect(text).toContain(`Batch reference: ${BATCH_ID}`);
    expect(text).toContain(`Cutoff: ${CUTOFF.toISOString()}`);
    expect(text).toContain(`Generated: ${GENERATED_AT.toISOString()}`);
    expect(text).toContain(`Generated by: ${GENERATED_BY_EMAIL}`);
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
    expect(text).toContain("Employee: Alice Anderson (alice@welld.ch)");
    // Never blended: EUR and CHF each appear as their own subtotal line.
    expect(text).toContain("EUR 45,50");
    expect(text).toContain("CHF 90,00");
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
    expect(text).toContain("Employee: bob@welld.it");
    expect(text).toContain("EUR 0,00");
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
    expect(text).toContain("EUR 12,34");
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
