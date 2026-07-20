/**
 * Compiled-batch PDF renderer (T2, specs/008-refund-monthly-processing,
 * ADR-0019; Unicode-font hardening — OWASP A04, specs/008 QE/security
 * finding).
 *
 * A pure, deterministic function: `RefundBatchItem`-derived data in, a PDF
 * `Buffer` out. Built with `pdf-lib` (pure TypeScript, zero native modules,
 * no headless browser — ADR-0019 decision 1) directly from primitives (text
 * runs, rules, an embedded Unicode font) — no HTML/CSS layout engine.
 *
 * FONT CHOICE (OWASP A04 fix — chosen over character sanitization): the
 * standard 14 PDF fonts (Helvetica et al.) only support WinAnsi/CP1252 and
 * `pdf-lib` THROWS when asked to draw a character outside that charset.
 * `employee.owner.name` is an unprivileged, employee-controlled OAuth
 * display name with no charset validation — any emoji/CJK/Cyrillic/Arabic
 * name reaching this renderer previously crashed it, which (via
 * `pdfLink.ts`'s lazy-regenerate-on-miss) turned into a permanently
 * unreadable batch. This module now embeds Noto Sans (Regular + Bold,
 * `fonts/NotoSans-*.ttf`, SIL Open Font License 1.1 — see
 * `fonts/LICENSE_OFL.txt`) via `@pdf-lib/fontkit` instead of sanitizing
 * characters out: Noto Sans correctly renders Latin Extended, Cyrillic,
 * Greek, and many other scripts (materially more names render CORRECTLY
 * than under Helvetica, which matters for a payroll-adjacent document), and
 * — just as importantly — a custom fontkit-embedded font resolves any
 * codepoint it doesn't cover (CJK ideographs, emoji, Arabic shaping, …) to
 * that font's own `.notdef` glyph via the font's cmap instead of throwing;
 * pdf-lib's `CustomFontEmbedder` has no WinAnsi-style encode-time charset
 * check the way `StandardFonts` do. So the renderer is now a genuinely total
 * function of its Unicode input: legitimate non-Latin names render
 * correctly, anything the bundled font can't shape degrades to a harmless
 * blank glyph, and nothing ever throws. Bundling two ~560KB TTFs was judged
 * "reasonably sized" (ADR-0019's own bar) against the alternative of a
 * lossy sanitize-to-`?` pass that would mangle real people's names on a
 * document accounting relies on for payroll reconciliation. Full CJK/emoji
 * *glyph* coverage was explicitly out of scope — those alphabets need
 * several more MB of separate font families each, which was judged
 * impractical to bundle here; those names still degrade safely (blank
 * glyphs) rather than crashing the renderer, matching the ADR-0019
 * "regenerable, not perfect" posture already established for this cache.
 *
 * DETERMINISM (ADR-0019 decision 5, ADR regenerable-cache posture): the only
 * "now" this module ever renders is the caller-supplied `generatedAt` — the
 * batch's stored `createdAt` — NEVER `Date.now()`. `pdf-lib` embeds a
 * creation/modification date in the PDF trailer by default when neither is
 * set explicitly, which would make two renders of the same input differ
 * byte-for-byte depending on wall-clock time; this module always calls
 * `setCreationDate`/`setModificationDate` with `generatedAt` to close that
 * gap. Employees and their per-currency subtotals are also sorted into a
 * stable, input-order-independent sequence so a regenerated PDF (cache miss
 * on `pdf-url`, or a resend) is byte-identical to the one originally
 * compiled and possibly already emailed. The embedded font bytes are read
 * once and cached module-scope (`loadFontBytes`) — the font FILES don't
 * change between renders, so this doesn't affect determinism, it only avoids
 * repeated disk reads across the many re-renders a regenerable cache implies.
 *
 * CONTENT (AC-1.6/1.7/1.9): one section per requesting employee, each
 * employee's approved lines subtotaled per currency — reusing
 * `computeSubtotals` from `requests.service.ts` (007's "never blended, never
 * grouped by entity" rule, carried forward verbatim) — plus a document
 * header (cutoff, generation timestamp, generating accounting user, batch
 * reference). $0-approved lines are included on the same terms as any other
 * (AC-1.9 — `computeSubtotals` does not filter by amount). This module never
 * reads or references `Attachment` rows — receipt files are never embedded
 * (AC-1.7); only the numeric/textual summary is rendered.
 *
 * Currency amounts render as ISO codes (`EUR 45,50`), not symbols — the
 * embedded font's coverage does not reliably cover every currency glyph
 * across providers either (ADR-0019 decision 2, plan.md Risk R7).
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { computeSubtotals, type LineRow } from "../requests/requests.service";
import type { Subtotal } from "../requests/requests.schemas";

// ─── Embedded Unicode font (OWASP A04 fix — see module doc) ─────────────────

const FONTS_DIR = import.meta.dir + "/fonts";

interface LoadedFontBytes {
  readonly regular: ArrayBuffer;
  readonly bold: ArrayBuffer;
}

let fontBytesPromise: Promise<LoadedFontBytes> | undefined;

/** Reads the bundled Noto Sans TTFs once and caches the bytes for the life of the process. */
function loadFontBytes(): Promise<LoadedFontBytes> {
  if (!fontBytesPromise) {
    fontBytesPromise = Promise.all([
      Bun.file(`${FONTS_DIR}/NotoSans-Regular.ttf`).arrayBuffer(),
      Bun.file(`${FONTS_DIR}/NotoSans-Bold.ttf`).arrayBuffer(),
    ]).then(([regular, bold]) => ({ regular, bold }));
  }
  return fontBytesPromise;
}

// ─── Object key (shared by the compile-time PutObject and the read-time mint) ──

/**
 * `refund/batches/{batchId}/compiled.pdf` — batch-scoped, non-guessable id,
 * no employee/PII in the key. Deliberately a SIBLING of, not nested under,
 * the `refund/{requestId}/…` receipt namespace, so a bucket lifecycle rule
 * scoped to unconfirmed receipt uploads (007 R4) can never catch a batch PDF
 * (ADR-0019 decision 3, plan.md Risk R8).
 */
export function batchPdfObjectKey(batchId: string): string {
  return `refund/batches/${batchId}/compiled.pdf`;
}

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface BatchPdfOwner {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
}

export interface BatchPdfRequest {
  readonly id: string;
  readonly lines: readonly LineRow[];
}

export interface BatchPdfEmployee {
  readonly owner: BatchPdfOwner;
  readonly requests: readonly BatchPdfRequest[];
}

export interface BatchPdfInput {
  /** The batch's own id — also serves as its human-facing "batch reference" (AC-1.6; mirrors plan.md's `batchReference: "<id>"`). */
  readonly batchId: string;
  /** The cutoff the compile was run against (AC-1.1). */
  readonly cutoff: Date;
  /** The batch's stored `createdAt` — the ONLY "now" this renderer ever draws (see module doc). */
  readonly generatedAt: Date;
  /** The generating accounting user's identity (AC-1.6). */
  readonly generatedByEmail: string;
  readonly employees: readonly BatchPdfEmployee[];
}

// ─── Layout constants ────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const TITLE_SIZE = 16;
const HEADER_SIZE = 10;
const SECTION_TITLE_SIZE = 12;
const BODY_SIZE = 10;
const LINE_GAP = 16;
const SECTION_GAP = 10;
const INK = rgb(0.09, 0.09, 0.1);

// ─── Money formatting (ISO code, comma decimal — see module doc) ────────────

function formatAmount(cents: number, currency: string): string {
  const negative = cents < 0;
  const absCents = Math.abs(cents);
  const whole = Math.trunc(absCents / 100);
  const decimals = (absCents % 100).toString().padStart(2, "0");
  return `${currency} ${negative ? "-" : ""}${whole},${decimals}`;
}

function isoTimestamp(date: Date): string {
  return date.toISOString();
}

// ─── Deterministic ordering helpers ─────────────────────────────────────────
//
// The renderer must not depend on the order the caller happened to hand it
// employees/requests in — a regenerated PDF (cache miss, resend) must be
// byte-identical to the original render regardless of any incidental query
// ordering difference (ADR-0019 decision 5).

function sortedEmployees(
  employees: readonly BatchPdfEmployee[],
): readonly BatchPdfEmployee[] {
  return [...employees].sort((a, b) => {
    const byEmail = a.owner.email.localeCompare(b.owner.email);
    if (byEmail !== 0) return byEmail;
    return a.owner.userId.localeCompare(b.owner.userId);
  });
}

function sortedRequests(
  requests: readonly BatchPdfRequest[],
): readonly BatchPdfRequest[] {
  return [...requests].sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Page/cursor management ──────────────────────────────────────────────────

interface Cursor {
  page: PDFPage;
  y: number;
}

function addPage(doc: PDFDocument): PDFPage {
  return doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
}

/** Advances to a new page if the next line would overflow the bottom margin. */
function ensureSpace(doc: PDFDocument, cursor: Cursor, needed: number): void {
  if (cursor.y - needed < MARGIN) {
    cursor.page = addPage(doc);
    cursor.y = PAGE_HEIGHT - MARGIN;
  }
}

function drawLine(
  doc: PDFDocument,
  cursor: Cursor,
  text: string,
  font: PDFFont,
  size: number,
): void {
  ensureSpace(doc, cursor, LINE_GAP);
  cursor.page.drawText(text, { x: MARGIN, y: cursor.y, size, font, color: INK });
  cursor.y -= LINE_GAP;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Renders a compiled batch's PDF as a `Buffer`. Pure and deterministic:
 * the same `BatchPdfInput` always produces byte-identical output (see module
 * doc). Never throws on an empty employee list — that state should never
 * reach this function in practice (compile refuses an empty candidate set,
 * AC-1.4), but the renderer stays total rather than partial.
 */
export async function renderBatchPdf(input: BatchPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // Unicode-capable custom font (OWASP A04 fix, module doc) — must be
  // registered before embedFont() is called with raw TTF bytes.
  doc.registerFontkit(fontkit);
  // Close the "pdf-lib embeds current wall-clock time by default" gap — the
  // ONLY timestamp this document ever carries is the caller-supplied
  // generatedAt (module doc; ADR-0019 decision 5).
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  doc.setTitle(`Refund batch ${input.batchId}`);
  doc.setProducer("wellD Operai refund-api");
  doc.setCreator("wellD Operai refund-api");
  doc.setAuthor(input.generatedByEmail);

  const fontBytes = await loadFontBytes();
  const font = await doc.embedFont(fontBytes.regular, { subset: true });
  const boldFont = await doc.embedFont(fontBytes.bold, { subset: true });

  const cursor: Cursor = { page: addPage(doc), y: PAGE_HEIGHT - MARGIN };

  // ── Header (AC-1.6: cutoff, generation timestamp, generating user, batch reference) ──
  ensureSpace(doc, cursor, LINE_GAP + 4);
  cursor.page.drawText("Refund batch — compiled", {
    x: MARGIN,
    y: cursor.y,
    size: TITLE_SIZE,
    font: boldFont,
    color: INK,
  });
  cursor.y -= TITLE_SIZE + 6;

  drawLine(doc, cursor, `Batch reference: ${input.batchId}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Cutoff: ${isoTimestamp(input.cutoff)}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Generated: ${isoTimestamp(input.generatedAt)}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Generated by: ${input.generatedByEmail}`, font, HEADER_SIZE);
  cursor.y -= SECTION_GAP;

  const employees = sortedEmployees(input.employees);

  if (employees.length === 0) {
    drawLine(doc, cursor, "No requests included in this batch.", font, BODY_SIZE);
  }

  for (const employee of employees) {
    ensureSpace(doc, cursor, LINE_GAP * 2);
    const label = employee.owner.name
      ? `${employee.owner.name} (${employee.owner.email})`
      : employee.owner.email;
    drawLine(doc, cursor, `Employee: ${label}`, boldFont, SECTION_TITLE_SIZE);

    const lines: LineRow[] = sortedRequests(employee.requests).flatMap(
      (request) => [...request.lines],
    );
    const subtotals: Subtotal[] = computeSubtotals(lines);

    if (subtotals.length === 0) {
      drawLine(doc, cursor, "  (no lines)", font, BODY_SIZE);
    }
    for (const subtotal of subtotals) {
      const approvedCents = subtotal.approvedCents ?? 0;
      drawLine(
        doc,
        cursor,
        `  ${formatAmount(approvedCents, subtotal.currency)}`,
        font,
        BODY_SIZE,
      );
    }

    cursor.y -= SECTION_GAP;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
