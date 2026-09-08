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
 * FORMATTING lives entirely in `documentFormat.ts` and LABELS in `labels.ts`
 * — this module chooses layout, never wording or number shape. That split is
 * what stopped raw enums (`travel_km`, `welld_ch`, `status: approved`) and
 * three different number locales reaching an accounting artifact.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { RefundLineResponse, Subtotal } from "./requests.schemas";
import { entityLabel, entityLabels, expenseTypeLabel, requestStatusLabel } from "./labels";
import {
  formatDate,
  formatMoney,
  formatPeriod,
  formatRatePerKm,
  formatTimestamp,
} from "./documentFormat";

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
  /**
   * Where this request stands in the monthly payout cycle, already resolved to
   * a sentence by the caller (it needs a batch lookup this renderer must not
   * perform).
   *
   * The document previously said nothing about settlement, so an approved
   * request and a paid one produced the same page — and "is this a liability
   * or is it settled?" is the first question anyone receiving it asks. An
   * archive that cannot answer it is not a hand-off document.
   */
  readonly settlement: string;
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
const FOOTER_SIZE = 7;
// Deliberately light: a stamp on a copied receipt must be legible without
// competing with the receipt's own content.
const FOOTER_INK = rgb(0.45, 0.45, 0.5);

interface Cursor {
  page: PDFPage;
  y: number;
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

/**
 * Stamps every page with the request reference and "Page N of M".
 *
 * Runs as a LAST pass, after every page (including copied receipt pages)
 * exists — the total is not knowable until then.
 *
 * Copied receipt pages are stamped too, deliberately. These documents get
 * printed and stapled, and a set where half the pages carry no number is
 * exactly the set that loses a page without anyone noticing; the same
 * reasoning behind Bates numbering. The stamp sits in the very bottom margin
 * at 7pt, and uses each page's OWN dimensions rather than A4 — a receipt may
 * be any size, and positioning it against the wrong height would drop the
 * footer into the middle of someone's scanned invoice.
 */
function drawFooters(doc: PDFDocument, font: PDFFont, reference: string): void {
  const pages = doc.getPages();
  const total = pages.length;

  pages.forEach((page, index) => {
    const { width } = page.getSize();
    const label = `${reference}`;
    const pageLabel = `Page ${index + 1} of ${total}`;

    page.drawText(label, {
      x: MARGIN,
      y: 22,
      size: FOOTER_SIZE,
      font,
      color: FOOTER_INK,
    });
    page.drawText(pageLabel, {
      x: width - MARGIN - font.widthOfTextAtSize(pageLabel, FOOTER_SIZE),
      y: 22,
      size: FOOTER_SIZE,
      font,
      color: FOOTER_INK,
    });
  });
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

  // Self-describing at a glance: WHO, WHEN the expenses fall in, and WHICH
  // legal entity — the three things someone filing this needs before reading
  // a single line. Period and entity are derived from the lines, so they are
  // right even when the request was filed in a later month or straddles both
  // entities.
  const period = formatPeriod(input.lines.map((line) => line.date));
  const entities = entityLabels(input.lines.map((line) => line.entity));

  drawLine(doc, cursor, `Employee: ${ownerLabel}`, font, HEADER_SIZE);
  if (period) drawLine(doc, cursor, `Period: ${period}`, font, HEADER_SIZE);
  if (entities) drawLine(doc, cursor, `Entity: ${entities}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Status: ${requestStatusLabel(input.status)}`, font, HEADER_SIZE);
  drawLine(doc, cursor, `Settlement: ${input.settlement}`, font, HEADER_SIZE);
  cursor.y -= 4;

  if (input.submittedAt) {
    drawLine(doc, cursor, `Submitted: ${formatTimestamp(new Date(input.submittedAt))}`, font, HEADER_SIZE);
  }
  if (input.decidedAt) {
    const by = input.decidedByEmail ? ` by ${input.decidedByEmail}` : "";
    drawLine(doc, cursor, `Decided: ${formatTimestamp(new Date(input.decidedAt))}${by}`, font, HEADER_SIZE);
  }
  drawLine(
    doc,
    cursor,
    `Exported: ${formatTimestamp(input.generatedAt)} by ${input.generatedByEmail}`,
    font,
    HEADER_SIZE,
  );
  drawLine(doc, cursor, `Internal ID: ${input.requestId}`, font, HEADER_SIZE);
  cursor.y -= SECTION_GAP;

  // ── Totals, one figure per currency, never blended (AC-3.5/6.6) ───────────
  drawLine(doc, cursor, "Totals", boldFont, SECTION_TITLE_SIZE);
  if (input.subtotals.length === 0) {
    drawLine(doc, cursor, "  (no lines)", font, BODY_SIZE);
  }
  for (const subtotal of input.subtotals) {
    const requested = formatMoney(subtotal.requestedCents, subtotal.currency);
    const approved =
      subtotal.approvedCents === null
        ? "—"
        : formatMoney(subtotal.approvedCents, subtotal.currency);
    // No `CHF:` group prefix — each amount already carries its currency, and
    // printing it three times on one line is the same noise the mixed
    // locales were.
    drawLine(doc, cursor, `  Requested ${requested} · Approved ${approved}`, font, BODY_SIZE);
  }
  cursor.y -= SECTION_GAP;

  // ── Every expense line ───────────────────────────────────────────────────
  const hasAnyReceipt = input.receipts.length > 0;

  drawLine(doc, cursor, `Expense lines (${input.lines.length})`, boldFont, SECTION_TITLE_SIZE);

  for (const line of input.lines) {
    ensureSpace(doc, cursor, LINE_GAP * 3);
    drawLine(
      doc,
      cursor,
      `  ${formatDate(line.date)} — ${expenseTypeLabel(line.type)} — ${entityLabel(line.entity)}`,
      boldFont,
      BODY_SIZE,
    );
    drawLine(doc, cursor, `    ${line.motivo}`, font, BODY_SIZE);

    const requested = formatMoney(line.requestedAmountCents, line.currency);
    const approved =
      line.approvedTotalCents === null
        ? "—"
        : formatMoney(line.approvedTotalCents, line.currency);
    drawLine(doc, cursor, `    Requested ${requested} · Approved ${approved}`, font, BODY_SIZE);

    // Mileage provenance: the snapshotted rate is part of the audited record
    // (ADR-0023/0025), so an archive that omitted it would not evidence how
    // the amount was reached.
    if (line.mileage) {
      const km = line.km === null ? "—" : String(line.km);
      const applied = line.mileage.appliedRate;
      const rate = applied ? formatRatePerKm(applied.ratePerKm, applied.currency) : "—";
      const validFrom = applied ? formatDate(applied.validFrom) : "—";
      drawLine(
        doc,
        cursor,
        `    ${km} km × ${rate} · rate valid from ${validFrom}`,
        font,
        BODY_SIZE,
      );
    }

    // Per-line receipt counts appear ONLY when the request has receipts
    // somewhere. On a request with none, every line saying "Receipts: none"
    // plus a closing "No receipts were attached" states the same fact four
    // times; one statement at the end says it once. When receipts DO exist the
    // per-line count is load-bearing — it is how a reader tells which expense
    // a given receipt belongs to — and the closing line is then redundant.
    if (hasAnyReceipt) {
      const attachmentCount = line.attachments.length;
      drawLine(
        doc,
        cursor,
        `    Receipts: ${attachmentCount === 0 ? "none" : String(attachmentCount)}`,
        font,
        BODY_SIZE,
      );
    }
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

  drawFooters(doc, font, input.requestId);

  return Buffer.from(await doc.save());
}
