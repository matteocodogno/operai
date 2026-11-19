/**
 * Per-request archive PDF — every expense line PLUS every receipt, embedded
 * (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes).
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
 * that bounds it) is the route's job — that keeps the ADR 20260716-eu-object-storage-refund-attachments departure
 * confined to one call site instead of buried inside a renderer, and keeps
 * this module trivially testable with synthetic bytes.
 *
 * FORMATTING lives entirely in `documentFormat.ts` and LABELS in `labels.ts`
 * — this module chooses layout, never wording or number shape. That split is
 * what stopped raw enums (`travel_km`, `welld_ch`, `status: approved`) and
 * three different number locales reaching an accounting artifact.
 */

import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type { RefundLineResponse, Subtotal } from "./requests.schemas";
import { entityLabel, entityHeaderLabel, expenseTypeLabel, requestStatusLabel } from "./labels";
import { letterheadFor } from "./letterhead";
import { COLOR, CONTENT_WIDTH, TYPE } from "./documentTheme";
import {
  INK,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  SECTION_GAP,
  addPage,
  createDocument,
  drawFooters,
  drawLabel,
  drawLetterhead,
  drawLine,
  drawMetadataGrid,
  drawRight,
  drawTitleBlock,
  ensureSpace,
  hairline,
  personLabel,
  wrapText,
  type Cursor,
  type Fonts,
} from "./documentLayout";
import {
  formatDate,
  formatMoney,
  formatPeriod,
  formatRatePerKm,
  formatTimestamp,
} from "./documentFormat";

// ─── Input shape ─────────────────────────────────────────────────────────────

/**
 * One receipt, already downloaded. `contentType` is one of ADR 20260716-eu-object-storage-refund-attachments's three
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
  /** Display-name snapshot of the decider, null for rows decided before it was recorded. */
  readonly decidedByName: string | null;
  /**
   * Why a rejected request was rejected. Null for any other status.
   *
   * On a rejected document this is not a detail — it is the entire content,
   * and the part a disputing employee will hold onto. Rendering the lines
   * without it would produce a document that says a claim was refused and
   * never says why.
   */
  readonly rejectionMotivation: string | null;
  readonly lines: readonly RefundLineResponse[];
  readonly subtotals: readonly Subtotal[];
  readonly receipts: readonly ExportReceipt[];
  /**
   * The single "now" this document carries. Supplied by the caller so the
   * renderer stays deterministic — same reasoning as ADR 20260719-refund-batch-pdf-generation-pdf-lib decision 5,
   * which closed pdf-lib's default of stamping wall-clock time.
   */
  readonly generatedAt: Date;
  readonly generatedByEmail: string;
  readonly generatedByName: string | null;
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

// ─── Layout ─────────────────────────────────────────────────────────────────
//
// Shared primitives (letterhead, grid, labels, footer) live in
// `documentLayout.ts`, so this document and the compiled batch stay one
// family; colour and type in `documentTheme.ts`. This module decides the
// request's own ARRANGEMENT only.

const LINE_GAP = 13;

/**
 * The expense table's columns, in points, summing to the content width.
 *
 * Fixed rather than content-derived: the header repeats on every page and a
 * total row sits under the last one, so the grid has to be identical
 * everywhere or the sum stops lining up with the figures it totals — which is
 * the entire reason the table exists.
 */
const COL = {
  index: 18,
  date: 54,
  description: 132,
  detail: 157,
  requested: 60,
  approved: 60,
} as const;

const COL_X = (() => {
  let x = MARGIN;
  const out = {} as Record<keyof typeof COL, number>;
  for (const key of Object.keys(COL) as (keyof typeof COL)[]) {
    out[key] = x;
    x += COL[key];
  }
  return out;
})();

/** Right edge of a right-aligned money column. */
const colRight = (key: "requested" | "approved"): number => COL_X[key] + COL[key];

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

  drawLine(doc, cursor, `Receipt ${index + 1} of ${total}`, boldFont, TYPE.value);
  drawLine(doc, cursor, `File: ${receipt.fileName}`, font, TYPE.small);
  drawLine(doc, cursor, `Expense: ${receipt.lineDate} — ${receipt.lineMotivo}`, font, TYPE.small);
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

// ─── Status chip ─────────────────────────────────────────────────────────────

/**
 * A filled chip carrying the status WORD.
 *
 * Colour is the accent, never the signal: the chip says "Approved" or
 * "Rejected" in text, so a monochrome photocopy loses nothing. That is why the
 * fill is a light wash with dark text rather than a saturated block with
 * knocked-out white type, which greys into mud when printed.
 */
function drawStatusChip(page: PDFPage, status: string, right: number, y: number, fonts: Fonts): void {
  const label = requestStatusLabel(status);
  const accent =
    status === "rejected" ? COLOR.brand : status === "approved" || status === "paid" ? COLOR.teal : COLOR.muted;

  const textWidth = fonts.label.widthOfTextAtSize(label.toUpperCase(), TYPE.label);
  const padX = 7;
  const width = textWidth + padX * 2 + 1;
  const height = 15;

  page.drawRectangle({
    x: right - width, y: y - 4, width, height,
    color: COLOR.wash, borderColor: accent, borderWidth: 0.8,
  });
  page.drawText(label.toUpperCase(), {
    x: right - width + padX, y: y + 0.5, size: TYPE.label, font: fonts.label, color: accent,
  });
}

// ─── Expense table ───────────────────────────────────────────────────────────

function drawTableHeader(page: PDFPage, y: number, fonts: Fonts, showsApproved: boolean): number {
  drawLabel(page, "#", COL_X.index, y, fonts);
  drawLabel(page, "Date", COL_X.date, y, fonts);
  drawLabel(page, "Description", COL_X.description, y, fonts);
  drawLabel(page, "Detail", COL_X.detail, y, fonts);

  const requestedLabel = "REQUESTED";
  drawRight(page, requestedLabel, colRight("requested"), y, fonts.label, TYPE.label, COLOR.muted);
  if (showsApproved) {
    drawRight(page, "APPROVED", colRight("approved"), y, fonts.label, TYPE.label, COLOR.muted);
  }

  hairline(page, y - 5, MARGIN, CONTENT_WIDTH, COLOR.ink, 0.8);
  return y - 16;
}

/**
 * How many pages each receipt will occupy once appended, computed BEFORE any
 * of them are.
 *
 * The receipts note has to name the page a reader turns to, and the note is
 * drawn above the receipts it points at — so the spans must be known in
 * advance. An image occupies its caption page alone; a PDF adds its own pages
 * after the caption. A receipt whose bytes will not parse is counted as one
 * page rather than throwing here: `appendReceipt` is where that failure is
 * diagnosed and reported (ReceiptEmbedError), and duplicating the check would
 * mean two places deciding what a broken receipt means.
 */
async function receiptPageSpans(receipts: readonly ExportReceipt[]): Promise<number[]> {
  const spans: number[] = [];
  for (const receipt of receipts) {
    if (receipt.contentType !== "application/pdf") {
      spans.push(1);
      continue;
    }
    try {
      const source = await PDFDocument.load(receipt.bytes);
      spans.push(1 + source.getPageCount());
    } catch {
      spans.push(1);
    }
  }
  return spans;
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
  const { doc, fonts } = await createDocument({
    title: `Refund request ${input.requestId}`,
    author: input.generatedByEmail,
    generatedAt: input.generatedAt,
  });

  const showsApprovedAmounts = input.status !== "rejected";
  const page0 = addPage(doc);
  const mark = letterheadFor(input.lines.map((line) => line.entity));

  // ── 1. Letterhead ────────────────────────────────────────────────────────
  let y = drawLetterhead(page0, PAGE_HEIGHT - MARGIN, fonts, mark);

  // ── 2. Title block: title + reference left, status chip right ────────────
  y = drawTitleBlock(page0, y, fonts, "Expense reimbursement request", input.requestId, (right, baseline) =>
    drawStatusChip(page0, input.status, right, baseline, fonts),
  );

  // ── 3. Metadata, two grouped columns ─────────────────────────────────────
  const period = formatPeriod(input.lines.map((line) => line.date));
  const decider = input.decidedByEmail ? personLabel(input.decidedByName, input.decidedByEmail) : "—";

  y = drawMetadataGrid(
    page0,
    y,
    fonts,
    {
      heading: "Request",
      entries: [
      ["Employee", personLabel(input.owner.name, input.owner.email)],
      ["Period", period ?? "—"],
      ["Entity", entityHeaderLabel(input.lines.map((line) => line.entity)) || "—"],
      ],
    },
    {
      heading: "Processing",
      entries: [
      ["Submitted", input.submittedAt ? formatTimestamp(new Date(input.submittedAt)) : "—"],
      ["Decided", `${input.decidedAt ? formatTimestamp(new Date(input.decidedAt)) : "—"} ${decider}`],
      ["Exported", `${formatTimestamp(input.generatedAt)} ${personLabel(input.generatedByName, input.generatedByEmail)}`],
      ["Settlement", input.settlement],
      ],
    },
  );
  y -= SECTION_GAP;

  const cursor: Cursor = { page: page0, y };

  // ── Rejection motivation — the content of a refusal, above the figures ───
  if (input.rejectionMotivation && input.rejectionMotivation.trim() !== "") {
    ensureSpace(doc, cursor, 60);
    drawLabel(cursor.page, "Reason for rejection", MARGIN, cursor.y, fonts);
    cursor.y -= 14;
    // The one genuinely prose block on the page — set in the prose role.
    for (const wrapped of wrapText(input.rejectionMotivation, fonts.prose, TYPE.prose, CONTENT_WIDTH)) {
      ensureSpace(doc, cursor, LINE_GAP);
      cursor.page.drawText(wrapped, { x: MARGIN, y: cursor.y, size: TYPE.prose, font: fonts.prose, color: INK });
      cursor.y -= 13.5;
    }
    cursor.y -= SECTION_GAP;
  }

  // ── 4/6. The table, one section per currency ─────────────────────────────
  const byCurrency = new Map<string, typeof input.lines>();
  for (const line of input.lines) {
    byCurrency.set(line.currency, [...(byCurrency.get(line.currency) ?? []), line] as typeof input.lines);
  }
  const currencies = [...byCurrency.keys()].sort();
  const multiCurrency = currencies.length > 1;

  let index = 0;
  for (const currency of currencies) {
    const lines = byCurrency.get(currency)!;

    ensureSpace(doc, cursor, 70);
    if (multiCurrency) {
      // A section per group, never a grand total across them: summing CHF and
      // EUR would invent a number that does not exist.
      drawLabel(cursor.page, `Expenses in ${currency}`, MARGIN, cursor.y, fonts);
      cursor.y -= 14;
    }
    cursor.y = drawTableHeader(cursor.page, cursor.y, fonts, showsApprovedAmounts);

    // Totalled from the LINES this document prints, not from `input.subtotals`.
    // The two agree by construction (computeSubtotals sums the same rows), but
    // summing what is on the page means the total can never disagree with the
    // figures above it — which is the one thing an accountant checks by hand.
    let requestedTotal = 0;
    let approvedTotal = 0;
    let kmTotal = 0;

    for (const line of lines) {
      index += 1;
      const detailTop = `${expenseTypeLabel(line.type)} · ${entityLabel(line.entity)}`;
      const applied = line.mileage?.appliedRate ?? null;
      const detailRate = applied
        ? `${line.km ?? "—"} km × ${formatRatePerKm(applied.ratePerKm, applied.currency)} · valid from ${formatDate(applied.validFrom)}`
        : null;
      const descriptionLines = wrapText(line.motivo || "—", fonts.value, TYPE.value, COL.description - 8);
      // specs/20260716-refund-service amendment (2026-11-10): a line refused on its own carries
      // its reason beside it — an approved figure of 0 with no explanation
      // is exactly the question this document exists to answer.
      const detailRejection =
        showsApprovedAmounts && line.rejection ? `Rejected: ${line.rejection.reason}` : null;
      const detailLines = [
        ...wrapText(detailTop, fonts.value, TYPE.small, COL.detail - 8),
        // specs/20261118-refund-accounting-export (T16, AC-4.9): the number this line was given at approval, one per
        // line, spelled out in full (only the batch PDF compresses runs). A rejected or not yet numbered line has none.
        ...(line.receiptNumber ? [`Receipt no. ${line.receiptNumber}`] : []),
        ...(detailRate ? wrapText(detailRate, fonts.value, TYPE.small, COL.detail - 8) : []),
        ...(detailRejection ? wrapText(detailRejection, fonts.value, TYPE.small, COL.detail - 8) : []),
      ];
      const rowHeight = Math.max(descriptionLines.length * 11, detailLines.length * 9.5, 14) + 7;

      // 9. A long request repeats the header rather than orphaning rows.
      if (cursor.y - rowHeight < MARGIN + 40) {
        cursor.page = addPage(doc);
        cursor.y = PAGE_HEIGHT - MARGIN;
        cursor.y = drawTableHeader(cursor.page, cursor.y, fonts, showsApprovedAmounts);
      }

      const rowTop = cursor.y;
      cursor.page.drawText(String(index), { x: COL_X.index, y: rowTop, size: TYPE.value, font: fonts.value, color: COLOR.muted });
      cursor.page.drawText(formatDate(line.date), { x: COL_X.date, y: rowTop, size: TYPE.value, font: fonts.value, color: INK });

      descriptionLines.forEach((text, i) => {
        cursor.page.drawText(text, { x: COL_X.description, y: rowTop - i * 11, size: TYPE.value, font: fonts.value, color: INK });
      });
      detailLines.forEach((text, i) => {
        cursor.page.drawText(text, { x: COL_X.detail, y: rowTop - i * 9.5, size: TYPE.small, font: fonts.value, color: COLOR.muted });
      });

      drawRight(cursor.page, formatMoney(line.requestedAmountCents, line.currency), colRight("requested"), rowTop, fonts.value, TYPE.value);
      requestedTotal += line.requestedAmountCents;
      if (showsApprovedAmounts) {
        const approved = line.approvedTotalCents ?? line.requestedAmountCents;
        drawRight(cursor.page, formatMoney(approved, line.currency), colRight("approved"), rowTop, fonts.value, TYPE.value);
        approvedTotal += approved;
      }
      kmTotal += line.km ?? 0;

      cursor.y = rowTop - rowHeight + 7;
      hairline(cursor.page, cursor.y + 3);
      cursor.y -= 8;
    }

    // ── 5. The total: the most prominent number, not the least ─────────────
    ensureSpace(doc, cursor, 34);
    hairline(cursor.page, cursor.y + 8, MARGIN, CONTENT_WIDTH, COLOR.brand, 1);
    cursor.y -= 4;
    cursor.page.drawText(multiCurrency ? `Subtotal — ${currency}` : "Total", {
      x: COL_X.description, y: cursor.y, size: TYPE.value, font: fonts.title, color: INK,
    });
    if (kmTotal > 0) {
      // A cross-check the reader can actually perform against the rate.
      cursor.page.drawText(`${kmTotal} km total`, {
        x: COL_X.detail, y: cursor.y, size: TYPE.small, font: fonts.value, color: COLOR.muted,
      });
    }
    drawRight(cursor.page, formatMoney(requestedTotal, currency), colRight("requested"), cursor.y, fonts.title, TYPE.value);
    if (showsApprovedAmounts) {
      drawRight(cursor.page, formatMoney(approvedTotal, currency), colRight("approved"), cursor.y, fonts.title, TYPE.value);
    }
    cursor.y -= SECTION_GAP + 10;
  }

  if (input.lines.length === 0) {
    drawLine(doc, cursor, "This request has no expense lines.", fonts.value, TYPE.value);
  }

  // ── 7. Receipts note — framed and muted, under the table ─────────────────
  const hasAnyReceipt = input.receipts.length > 0;
  ensureSpace(doc, cursor, 46);
  // Page references are computed from the spans above, offset by the pages
  // already drawn — so "page 3" is the page a reader actually turns to.
  const spans = await receiptPageSpans(input.receipts);
  let nextPage = doc.getPageCount() + 1;
  const noteLines = hasAnyReceipt
    ? input.receipts.map((r, i) => {
        const start = nextPage;
        nextPage += spans[i] ?? 1;
        return `${i + 1}. ${r.fileName} — ${formatDate(r.lineDate)} · ${r.lineMotivo} — page ${start}`;
      })
    : ["No receipts were attached to this request."];
  const noteHeight = 20 + noteLines.length * 10;
  cursor.page.drawRectangle({
    x: MARGIN, y: cursor.y - noteHeight + 12, width: CONTENT_WIDTH, height: noteHeight,
    color: COLOR.wash, borderColor: COLOR.hairline, borderWidth: 0.5,
  });
  drawLabel(cursor.page, hasAnyReceipt ? `Receipts (${input.receipts.length})` : "Receipts", MARGIN + 8, cursor.y, fonts);
  cursor.y -= 12;
  for (const note of noteLines) {
    cursor.page.drawText(note, { x: MARGIN + 8, y: cursor.y, size: TYPE.small, font: fonts.value, color: COLOR.muted });
    cursor.y -= 10;
  }
  cursor.y -= SECTION_GAP;

  // ── Receipts themselves ──────────────────────────────────────────────────
  for (const [i, receipt] of input.receipts.entries()) {
    await appendReceipt(doc, receipt, fonts.value, fonts.title, i, input.receipts.length);
  }

  // ── 8. Footer ────────────────────────────────────────────────────────────
  drawFooters(doc, fonts.value, input.requestId);

  return Buffer.from(await doc.save());
}
