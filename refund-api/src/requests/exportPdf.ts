/**
 * Per-request archive PDF — every expense line PLUS every receipt, embedded
 * (ADR-0043).
 *
 * DELIBERATE CONTRAST WITH `batches/pdf.ts`. That renderer's module doc says
 * it "never reads or references `Attachment` rows — receipt files are never
 * embedded (AC-1.7)": a batch PDF is an accounting SUMMARY across many
 * employees, and stuffing every receipt into it would make a monthly payout
 * document enormous and mostly irrelevant to its reader. This renderer is the
 * opposite artifact for the opposite purpose — a single approved request,
 * self-contained, so it can be filed and read years later with no access to
 * Operai, its bucket, or its presigned URLs. The two must not be merged.
 *
 * PURE AND TOTAL, exactly like `renderBatchPdf`: it receives already-fetched
 * receipt BYTES and never performs I/O of its own. Fetching (and the budget
 * that bounds it) is the route's job — that keeps the ADR-0016 departure
 * confined to one call site instead of buried inside a renderer, and keeps
 * this module trivially testable with synthetic bytes.
 *
 * Currency amounts render as ISO codes (`CHF 206,50`), matching
 * `batches/pdf.ts` — same reason (ADR-0019 decision 2): the embedded font's
 * glyph coverage for currency symbols is not reliable across providers.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { RefundLineResponse, Subtotal } from "./requests.schemas";

// ─── Input shape ─────────────────────────────────────────────────────────────

/**
 * One receipt, already downloaded. `contentType` is one of ADR-0016's three
 * allowed types — the renderer refuses anything else rather than guessing,
 * because a mislabelled receipt silently dropped from an archive is the exact
 * failure this feature exists to prevent.
 */
export interface ExportReceipt {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** The line this receipt belongs to, so the archive can name its context. */
  readonly lineMotivo: string;
  readonly lineDate: string;
}

export interface RequestExportInput {
  readonly requestId: string;
  readonly status: string;
  readonly owner: { readonly email: string; readonly name: string | null };
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedByEmail: string | null;
  readonly lines: readonly RefundLineResponse[];
  readonly subtotals: readonly Subtotal[];
  readonly receipts: readonly ExportReceipt[];
  /**
   * The single "now" this document carries. Supplied by the caller so the
   * renderer stays deterministic — same reasoning as ADR-0019 decision 5,
   * which closed pdf-lib's default of stamping wall-clock time.
   */
  readonly generatedAt: Date;
  readonly generatedByEmail: string;
}

// ─── Embedded Unicode font ───────────────────────────────────────────────────
//
// Same bundled Noto Sans as batches/pdf.ts, read from that module's fonts
// directory rather than duplicating the files: a motivo can contain any
// Unicode the employee typed, and pdf-lib's built-in StandardFonts are
// WinAnsi-only and THROW on an unrepresentable character (the OWASP A04 fix
// recorded in batches/pdf.ts). An archive export must never fail because
// someone wrote "Mtg CRSS – Zürich".

const FONTS_DIR = import.meta.dir + "/../batches/fonts";

interface LoadedFontBytes {
  readonly regular: ArrayBuffer;
  readonly bold: ArrayBuffer;
}

let fontBytesPromise: Promise<LoadedFontBytes> | undefined;

function loadFontBytes(): Promise<LoadedFontBytes> {
  if (!fontBytesPromise) {
    fontBytesPromise = Promise.all([
      Bun.file(`${FONTS_DIR}/NotoSans-Regular.ttf`).arrayBuffer(),
      Bun.file(`${FONTS_DIR}/NotoSans-Bold.ttf`).arrayBuffer(),
    ]).then(([regular, bold]) => ({ regular, bold }));
  }
  return fontBytesPromise;
}

// ─── Layout constants (mirrors batches/pdf.ts) ───────────────────────────────

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

interface Cursor {
  page: PDFPage;
  y: number;
}

/** Money: ISO code + comma decimal, identical to batches/pdf.ts's formatAmount. */
function formatAmount(cents: number, currency: string): string {
  const negative = cents < 0;
  const absCents = Math.abs(cents);
  const whole = Math.trunc(absCents / 100);
  const decimals = (absCents % 100).toString().padStart(2, "0");
  return `${currency} ${negative ? "-" : ""}${whole},${decimals}`;
}

function addPage(doc: PDFDocument): PDFPage {
  return doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
}

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

/**
 * Thrown when a receipt cannot be embedded — a corrupt PDF, a mislabelled
 * content type, bytes that are not the image they claim to be.
 *
 * Deliberately FATAL to the whole export rather than a "could not embed this
 * receipt" placeholder page. The document's entire purpose is to be the
 * archived record; one that looks complete but silently isn't is worse than
 * no document at all, because nobody re-checks an archive. The route maps
 * this to a 502 naming the offending file so it can actually be fixed.
 */
export class ReceiptEmbedError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly fileName: string,
    cause: unknown,
  ) {
    super(
      `Receipt "${fileName}" (${attachmentId}) could not be embedded: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "ReceiptEmbedError";
  }
}

/** Appends one receipt: a caption page, then the image inline or the source PDF's pages. */
async function appendReceipt(
  doc: PDFDocument,
  receipt: ExportReceipt,
  font: PDFFont,
  boldFont: PDFFont,
  index: number,
  total: number,
): Promise<void> {
  const cursor: Cursor = { page: addPage(doc), y: PAGE_HEIGHT - MARGIN };

  drawLine(doc, cursor, `Receipt ${index + 1} of ${total}`, boldFont, SECTION_TITLE_SIZE);
  drawLine(doc, cursor, `File: ${receipt.fileName}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Expense: ${receipt.lineDate} — ${receipt.lineMotivo}`, font, HEADER_SIZE);
  cursor.y -= SECTION_GAP;

  try {
    if (receipt.contentType === "application/pdf") {
      // Copy every page of the source PDF verbatim — the archived receipt is
      // the original document, not a rasterised picture of it.
      const source = await PDFDocument.load(receipt.bytes);
      const copied = await doc.copyPages(source, source.getPageIndices());
      for (const page of copied) doc.addPage(page);
      return;
    }

    const image =
      receipt.contentType === "image/png"
        ? await doc.embedPng(receipt.bytes)
        : receipt.contentType === "image/jpeg"
          ? await doc.embedJpg(receipt.bytes)
          : null;

    if (image === null) {
      throw new Error(`unsupported content type "${receipt.contentType}"`);
    }

    // Scale to fit the remaining space on the caption page, preserving aspect
    // ratio and never enlarging a small receipt beyond its natural size.
    const availableWidth = PAGE_WIDTH - MARGIN * 2;
    const availableHeight = cursor.y - MARGIN;
    const scale = Math.min(
      availableWidth / image.width,
      availableHeight / image.height,
      1,
    );
    const width = image.width * scale;
    const height = image.height * scale;

    cursor.page.drawImage(image, {
      x: MARGIN,
      y: cursor.y - height,
      width,
      height,
    });
  } catch (cause) {
    if (cause instanceof ReceiptEmbedError) throw cause;
    throw new ReceiptEmbedError(receipt.attachmentId, receipt.fileName, cause);
  }
}

// ─── Renderer ────────────────────────────────────────────────────────────────

/**
 * Renders one request's archive PDF. Deterministic for a given input: the
 * only clock it reads is `input.generatedAt`.
 *
 * Throws {@link ReceiptEmbedError} if any receipt cannot be embedded — see
 * that class's doc for why this is fatal rather than a placeholder.
 */
export async function renderRequestExportPdf(
  input: RequestExportInput,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  doc.setTitle(`Refund request ${input.requestId}`);
  doc.setProducer("wellD Operai refund-api");
  doc.setCreator("wellD Operai refund-api");
  doc.setAuthor(input.generatedByEmail);

  const fontBytes = await loadFontBytes();
  const font = await doc.embedFont(fontBytes.regular, { subset: true });
  const boldFont = await doc.embedFont(fontBytes.bold, { subset: true });

  const cursor: Cursor = { page: addPage(doc), y: PAGE_HEIGHT - MARGIN };

  // ── Header ────────────────────────────────────────────────────────────────
  ensureSpace(doc, cursor, LINE_GAP + 4);
  cursor.page.drawText("Expense reimbursement request", {
    x: MARGIN,
    y: cursor.y,
    size: TITLE_SIZE,
    font: boldFont,
    color: INK,
  });
  cursor.y -= TITLE_SIZE + 6;

  const ownerLabel = input.owner.name
    ? `${input.owner.name} (${input.owner.email})`
    : input.owner.email;

  drawLine(doc, cursor, `Request reference: ${input.requestId}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Employee: ${ownerLabel}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Status: ${input.status}`, font, HEADER_SIZE);
  if (input.submittedAt) {
    drawLine(doc, cursor, `Submitted: ${input.submittedAt}`, font, HEADER_SIZE);
  }
  if (input.decidedAt) {
    drawLine(doc, cursor, `Decided: ${input.decidedAt}`, font, HEADER_SIZE);
  }
  if (input.decidedByEmail) {
    drawLine(doc, cursor, `Decided by: ${input.decidedByEmail}`, font, HEADER_SIZE);
  }
  drawLine(doc, cursor, `Exported: ${input.generatedAt.toISOString()}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Exported by: ${input.generatedByEmail}`, font, HEADER_SIZE);
  cursor.y -= SECTION_GAP;

  // ── Totals, one figure per currency, never blended (AC-3.5/6.6) ───────────
  drawLine(doc, cursor, "Totals", boldFont, SECTION_TITLE_SIZE);
  if (input.subtotals.length === 0) {
    drawLine(doc, cursor, "  (no lines)", font, BODY_SIZE);
  }
  for (const subtotal of input.subtotals) {
    const requested = formatAmount(subtotal.requestedCents, subtotal.currency);
    const approved =
      subtotal.approvedCents === null
        ? "—"
        : formatAmount(subtotal.approvedCents, subtotal.currency);
    drawLine(
      doc,
      cursor,
      `  ${subtotal.currency}: requested ${requested} · approved ${approved}`,
      font,
      BODY_SIZE,
    );
  }
  cursor.y -= SECTION_GAP;

  // ── Every expense line ───────────────────────────────────────────────────
  drawLine(doc, cursor, `Expense lines (${input.lines.length})`, boldFont, SECTION_TITLE_SIZE);

  for (const line of input.lines) {
    ensureSpace(doc, cursor, LINE_GAP * 3);
    drawLine(doc, cursor, `  ${line.date} — ${line.type} — ${line.entity}`, boldFont, BODY_SIZE);
    drawLine(doc, cursor, `    ${line.motivo}`, font, BODY_SIZE);

    const requested = formatAmount(line.requestedAmountCents, line.currency);
    const approved =
      line.approvedTotalCents === null
        ? "—"
        : formatAmount(line.approvedTotalCents, line.currency);
    drawLine(doc, cursor, `    Requested ${requested} · Approved ${approved}`, font, BODY_SIZE);

    // Mileage provenance: the snapshotted rate is part of the audited record
    // (ADR-0023/0025), so an archive that omitted it would not evidence how
    // the amount was reached.
    if (line.mileage) {
      const km = line.km === null ? "—" : String(line.km);
      const applied = line.mileage.appliedRate;
      const rate = applied ? `${applied.ratePerKm} ${applied.currency}/km` : "—";
      const validFrom = applied ? applied.validFrom : "—";
      drawLine(
        doc,
        cursor,
        `    ${km} km × ${rate} · rate valid from ${validFrom}`,
        font,
        BODY_SIZE,
      );
    }

    const attachmentCount = line.attachments.length;
    drawLine(
      doc,
      cursor,
      `    Receipts: ${attachmentCount === 0 ? "none" : String(attachmentCount)}`,
      font,
      BODY_SIZE,
    );
    cursor.y -= 4;
  }

  // ── Every receipt, embedded ──────────────────────────────────────────────
  if (input.receipts.length > 0) {
    ensureSpace(doc, cursor, LINE_GAP * 2);
    cursor.y -= SECTION_GAP;
    drawLine(
      doc,
      cursor,
      `Receipts (${input.receipts.length}) follow on the next pages.`,
      boldFont,
      SECTION_TITLE_SIZE,
    );

    for (const [index, receipt] of input.receipts.entries()) {
      await appendReceipt(doc, receipt, font, boldFont, index, input.receipts.length);
    }
  } else {
    ensureSpace(doc, cursor, LINE_GAP);
    cursor.y -= SECTION_GAP;
    drawLine(doc, cursor, "No receipts were attached to this request.", font, BODY_SIZE);
  }

  return Buffer.from(await doc.save());
}
