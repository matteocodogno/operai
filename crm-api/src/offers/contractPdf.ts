/**
 * Renders a specs/20261102-crm-offer-document contract offer on the entity's letterhead (US-1).
 *
 * pdf-lib with the standard Helvetica fonts only. The letterhead is embedded
 * once and drawn behind every contract and Annex A page; its baked-in page
 * number is painted over (D-2) and `n/N` is written there. Attachments are
 * appended unchanged, after Annex A, and are not counted in `N`.
 *
 * The document is laid out twice: the first pass finds the page of each
 * section, the second prints them in the index. The index has a fixed number of
 * lines, so both passes break pages identically. The renderer never computes
 * money: it prints what the snapshot says.
 *
 * It does not number anything either (specs/20261115-crm-offer-wizard DD-29): section and sub-heading numbers,
 * annex letters, the "Allegati:" lines, the index entries and cost positions are READ from the shared engine
 * (`numberOffer`, `computeCosts`, `words`), the same copy the wizard's preview reads, for a legacy (018)
 * snapshot and a wizard snapshot alike. A plain surface (a cost description, a label) is drawn as text:
 * never parsed as markup, and a marker character (U+E000-U+E003) is split out, not drawn (DD-47).
 */

import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage, type PDFFont, type PDFPage } from "pdf-lib";
import { boundPdfIsolated } from "../entity-profiles/isolatedPdfCheck";
import type { ContractSnapshot, OfferCostLine, OfferCosts, RenderInputs } from "./contract";
import { computeCosts, type CostRowIn } from "./engine/costs";
import { formatAmount, formatPercent, shortDate } from "./engine/format";
import { parseMarkup, type Block, type CellLine, type ListItem, type Run } from "./engine/markup";
import { numberOffer, type NumberedOffer, type NumberedSection } from "./engine/numbering";
import { BALLOT_BOX, printable } from "./engine/printable";
import { words } from "./engine/words";
import {
  CELL_PAD,
  FRAME,
  HEADING_SIZE,
  LINE,
  NUMBER_BASELINE,
  NUMBER_CORNER,
  NUMBER_RIGHT_INSET,
  NUMBER_SIZE,
  PAGE,
  SIZE,
  SPACING,
  TABLE_SIZE,
  TITLE_SIZE,
} from "./paper";
import { formatManDays, winAnsi } from "./pdf";

/**
 * The issuer's legal name and address lines as the engine's `[EMITTENTE]` / `[INDIRIZZO_EMITTENTE]` print them: a line
 * break folds into one space (security I-7). The same rule as `oneLine` in `engine/resolve.ts`, which is not exported
 * (the engine files are byte-identical copies of crm-ui's).
 */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** An appended PDF that pdf-lib cannot read (encrypted, damaged); the route maps it to a 422. */
export class AttachmentUnreadableError extends Error {
  constructor(readonly fileName: string) {
    super(`Attachment "${fileName}" cannot be read as a PDF`);
    this.name = "AttachmentUnreadableError";
  }
}

/** One string the renderer drew: a line of text, a table cell's line, an index leader, a page number. */
export interface DrawnText {
  /** 1-based page of the document (the appended attachments are not drawn by the renderer). */
  readonly page: number;
  readonly text: string;
}

/** Test hook: with `drawLog`, the final layout pass appends every string it draws, in drawing order. */
export interface RenderOptions {
  readonly drawLog?: DrawnText[];
}

/**
 * The ballot box of an `option` line (DD-22): not a Helvetica glyph, so it is drawn as a small square and advances
 * the line by this many em (the square and a gap).
 */
const BOX_ADVANCE = 0.85;
const BOX_SIDE = 0.7;

/** A text's width in the font, a ballot box counting `BOX_ADVANCE` em. */
function textWidth(font: PDFFont, text: string, size: number): number {
  if (!text.includes(BALLOT_BOX)) return font.widthOfTextAtSize(text, size);
  const parts = text.split(BALLOT_BOX);
  return parts.reduce((sum, part) => sum + (part === "" ? 0 : font.widthOfTextAtSize(part, size)), 0) + (parts.length - 1) * BOX_ADVANCE * size;
}

/** A marker character (the resolver's missing/pending runs, DD-47): never drawn. */
const MARKER_CHARACTERS = /[\uE000-\uE003]/g;
/** A plain surface as drawn: its marker characters removed, everything else literal. */
const plain = (text: string): string => text.replace(MARKER_CHARACTERS, "");

// ─── Frame (measured on the supplied letterhead, A4 = 595.28 × 841.89 pt) ────
// Logo ends ~78 pt from the top; a grey rule sits 91 pt from the bottom with the
// footer under it; the baked-in "1/1" spans x 511–523, 32–43 pt from the bottom.

const PAGE_W = PAGE.width;
const PAGE_H = PAGE.height;
export { FRAME };
const BODY_W = PAGE_W - FRAME.left - FRAME.right;
const LIMIT = PAGE_H - FRAME.bottom; // lowest cursor position (from the top) a line may reach
/** The page number's corner, right edge and baseline are shared with the preview (`paper.ts`, D-2). */
const NUMBER_RIGHT = PAGE_W - NUMBER_RIGHT_INSET; // the letterhead rule's right end
/** Width reserved for the page numbers of the index. */
const NUMBER_COLUMN = 18;

const INK = rgb(0.13, 0.13, 0.13);
const SOFT = rgb(0.45, 0.45, 0.45);
const GRID = rgb(0.62, 0.62, 0.62);
const SHADE = rgb(0.9, 0.9, 0.9);
const WHITE = rgb(1, 1, 1);

// ─── Text layout ─────────────────────────────────────────────────────────────

type Style = { readonly bold: boolean; readonly italic: boolean; readonly underline: boolean };

interface Seg {
  readonly text: string;
  readonly style: Style;
  readonly width: number;
}
interface Line {
  readonly segs: Seg[];
  readonly width: number;
}

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly italic: PDFFont;
  readonly boldItalic: PDFFont;
}

const fontFor = (fonts: Fonts, style: Pick<Style, "bold" | "italic">): PDFFont =>
  style.bold ? (style.italic ? fonts.boldItalic : fonts.bold) : style.italic ? fonts.italic : fonts.regular;

const sameStyle = (a: Style, b: Style): boolean => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;

const run = (text: string, bold = false): Run => ({ text, bold, italic: false, underline: false });

interface Piece {
  text: string;
  style: Style;
}
interface Chunk {
  /** Pieces that must stay on one line (no space between them). */
  pieces: Piece[];
  spaceBefore: boolean;
}

/** Word-wraps runs to `width`, mixing the four Helvetica faces. A "\n" is a hard break. */
function layoutRuns(runs: readonly Run[], width: number, size: number, fonts: Fonts): Line[] {
  const measure = (text: string, style: Style) => textWidth(fontFor(fonts, style), text, size);
  const spaceWidth = fonts.regular.widthOfTextAtSize(" ", size);
  const widths = new Map<string, number>();
  const charWidth = (char: string, style: Style): number => {
    const key = `${style.bold ? "b" : ""}${style.italic ? "i" : ""}${char}`;
    let found = widths.get(key);
    if (found === undefined) {
      found = measure(char, style);
      widths.set(key, found);
    }
    return found;
  };
  // Helvetica's narrowest glyph is about 0.22 em: a longer text certainly overflows, no measuring needed.
  const fitsLine = (pieces: readonly Piece[], limit: number): boolean => {
    let total = 0;
    for (const piece of pieces) {
      if (piece.text.length * 0.2 * size > limit) return false;
      total += measure(piece.text, piece.style);
      if (total > limit) return false;
    }
    return true;
  };

  // Tokenise into chunks: words glued across run boundaries ("**a**,") stay together.
  const paragraphs: Chunk[][] = [[]];
  let glued = false;
  for (const source of runs) {
    const style: Style = { bold: source.bold, italic: source.italic, underline: source.underline };
    source.text
      .split("\n")
      .forEach((part, partIndex) => {
        if (partIndex > 0) {
          paragraphs.push([]);
          glued = false;
        }
        const clean = printable(part);
        const words = clean.split(/ +/);
        words.forEach((word, wordIndex) => {
          const spaced = wordIndex > 0 || (clean.startsWith(" ") && word === "");
          if (word === "") {
            if (spaced) glued = false;
            return;
          }
          if (wordIndex > 0) glued = false;
          const current = paragraphs[paragraphs.length - 1]!;
          const last = current[current.length - 1];
          if (glued && last) {
            last.pieces.push({ text: word, style });
          } else {
            current.push({ pieces: [{ text: word, style }], spaceBefore: current.length > 0 });
          }
          glued = true;
        });
        if (clean.endsWith(" ")) glued = false;
      });
  }

  const lines: Line[] = [];
  for (const chunks of paragraphs) {
    let segs: Seg[] = [];
    let lineWidth = 0;
    const flush = () => {
      lines.push({ segs, width: lineWidth });
      segs = [];
      lineWidth = 0;
    };
    const place = (pieces: readonly Piece[], leadingSpace: boolean) => {
      pieces.forEach((piece, index) => {
        const text = (index === 0 && leadingSpace ? " " : "") + piece.text;
        const previous = segs[segs.length - 1];
        if (previous && sameStyle(previous.style, piece.style)) {
          const merged = previous.text + text;
          segs[segs.length - 1] = { text: merged, style: previous.style, width: measure(merged, previous.style) };
        } else {
          segs.push({ text, style: piece.style, width: measure(text, piece.style) });
        }
        lineWidth = segs.reduce((sum, seg) => sum + seg.width, 0);
      });
    };
    for (const chunk of chunks) {
      let pieces = chunk.pieces;
      // A word wider than the line is cut at the character that overflows. The test is cheap
      // (a length bound first), and the cut is one running-width scan, so a 20 000-character
      // word costs linear time instead of re-measuring growing prefixes.
      while (!fitsLine(pieces, width)) {
        if (segs.length > 0) flush();
        const head = pieces[0]!;
        let cut = 0;
        let used = 0;
        while (cut < head.text.length) {
          const next = charWidth(head.text[cut]!, head.style);
          if (used + next > width) break;
          used += next;
          cut += 1;
        }
        cut = Math.max(cut, 1);
        place([{ text: head.text.slice(0, cut), style: head.style }], false);
        flush();
        pieces = [{ text: head.text.slice(cut), style: head.style }, ...pieces.slice(1)].filter((piece) => piece.text !== "");
        if (pieces.length === 0) break;
      }
      if (pieces.length === 0) continue;
      const chunkWidth = pieces.reduce((sum, piece) => sum + measure(piece.text, piece.style), 0);
      const space = segs.length > 0 && chunk.spaceBefore ? spaceWidth : 0;
      if (segs.length > 0 && lineWidth + space + chunkWidth > width) flush();
      place(pieces, segs.length > 0 && chunk.spaceBefore);
    }
    flush();
  }
  // A trailing break leaves no empty line; an explicit empty paragraph keeps one.
  return lines.length === 1 && lines[0]!.segs.length === 0 ? [] : lines;
}

// ─── Flow ────────────────────────────────────────────────────────────────────

/** Where a block's first line landed: its page and distance from the top. */
interface Placement {
  readonly page: PDFPage;
  readonly top: number;
}

/** The labels of one section's `###` lines, taken in order as the markup is drawn. */
interface HeadingLabels {
  readonly labels: readonly string[];
  taken: number;
}

interface PassResult {
  /** The first page (1-based) of each index target (`NumberedOffer.index[].target`). */
  readonly pages: ReadonlyMap<string, number>;
  readonly pageCount: number;
}

type TextAlign = "left" | "right" | "center";

interface CellSpec {
  readonly lines: readonly { readonly runs: readonly Run[]; readonly bullet: boolean }[];
  readonly align?: TextAlign;
  readonly span?: number;
}
interface RowSpec {
  readonly cells: readonly CellSpec[];
  readonly header?: boolean;
  readonly bold?: boolean;
}

const asBold = (runs: readonly Run[]): Run[] => runs.map((source) => ({ ...source, bold: true }));
const cell = (text: string, align?: TextAlign, span?: number): CellSpec => ({
  lines: text === "" ? [] : [{ runs: [run(text)], bullet: false }],
  ...(align ? { align } : {}),
  ...(span ? { span } : {}),
});

class Flow {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  /** Distance from the top of the page to the next free line. */
  y = FRAME.top;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
    readonly letterhead: PDFEmbeddedPage | null,
    readonly snapshot: ContractSnapshot,
    readonly log: DrawnText[] | null = null,
  ) {}

  /** Every drawn string goes through here, so the test hook sees exactly what the PDF holds. */
  text(page: PDFPage, value: string, options: Parameters<PDFPage["drawText"]>[1]): void {
    this.record(page, value);
    page.drawText(value, options);
  }

  private record(page: PDFPage, value: string): void {
    this.log?.push({ page: this.pages.indexOf(page) + 1, text: value });
  }

  // — pages —

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = FRAME.top;
    if (this.letterhead) {
      this.page.drawPage(this.letterhead, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    } else {
      this.plainLetterhead();
    }
  }

  /** The fallback without an uploaded letterhead (AC-2.4): issuer name, address and a footer rule. */
  private plainLetterhead(): void {
    const { issuer, language } = this.snapshot;
    const t = words(language);
    const legalName = oneLine(issuer.legalName);
    const addressLines = issuer.addressLines.map(oneLine).filter((line) => line !== "");
    this.text(this.page, winAnsi(legalName), { x: FRAME.left, y: PAGE_H - 52, size: 13, font: this.fonts.bold, color: INK });
    addressLines.slice(0, 3).forEach((line, index) => {
      this.text(this.page, winAnsi(line), { x: FRAME.left, y: PAGE_H - 66 - index * 10, size: 8.5, font: this.fonts.regular, color: SOFT });
    });
    this.page.drawLine({
      start: { x: FRAME.left, y: 91 },
      end: { x: PAGE_W - FRAME.right, y: 91 },
      thickness: 0.5,
      color: GRID,
    });
    const footer = [legalName, ...addressLines, issuer.vatNumber ? `${t.vat} ${issuer.vatNumber}` : null, issuer.iban ? `IBAN ${issuer.iban}` : null]
      .filter(Boolean)
      .join("  ·  ");
    for (const [index, line] of layoutRuns([run(footer)], BODY_W, 8, this.fonts).slice(0, 3).entries()) {
      this.drawLine(this.page, line, FRAME.left, 82 - index * 10, 8, SOFT);
    }
  }

  /** Starts a new page unless `height` still fits above the bottom limit. */
  ensure(height: number): void {
    if (this.pages.length === 0 || this.y + height > LIMIT) this.newPage();
  }

  // — drawing primitives —

  /** Draws one laid-out line with its baseline at `baseline` (pt from the BOTTOM of the page). */
  private drawLine(page: PDFPage, line: Line, x: number, baseline: number, size: number, color = INK): void {
    let cursor = x;
    this.record(page, line.segs.map((seg) => seg.text).join(""));
    for (const seg of line.segs) {
      const font = fontFor(this.fonts, seg.style);
      const text = seg.text;
      const lead = text.length - text.trimStart().length;
      this.drawSeg(page, text, cursor, baseline, size, font, color);
      if (seg.style.underline) {
        const start = cursor + (lead > 0 ? font.widthOfTextAtSize(text.slice(0, lead), size) : 0);
        page.drawLine({
          start: { x: start, y: baseline - 1.5 },
          end: { x: cursor + seg.width, y: baseline - 1.5 },
          thickness: 0.5,
          color,
        });
      }
      cursor += seg.width;
    }
  }

  /** One styled run; a ballot box in it is drawn as a square (the font has no glyph for it). */
  private drawSeg(page: PDFPage, text: string, x: number, baseline: number, size: number, font: PDFFont, color: typeof INK): void {
    if (!text.includes(BALLOT_BOX)) {
      page.drawText(text, { x, y: baseline, size, font, color });
      return;
    }
    let at = x;
    const parts = text.split(BALLOT_BOX);
    parts.forEach((part, index) => {
      if (part !== "") {
        page.drawText(part, { x: at, y: baseline, size, font, color });
        at += font.widthOfTextAtSize(part, size);
      }
      if (index < parts.length - 1) {
        page.drawRectangle({ x: at + 0.5, y: baseline - size * 0.05, width: size * BOX_SIDE, height: size * BOX_SIDE, borderColor: color, borderWidth: 0.7 });
        at += BOX_ADVANCE * size;
      }
    });
  }

  private baseline(top: number, size: number, lineHeight: number): number {
    return PAGE_H - (top + (lineHeight - size) / 2 + size * 0.85);
  }

  /** Lines of one text block placed at the cursor, breaking across pages line by line. */
  lines(lines: readonly Line[], options: { x?: number; width?: number; size?: number; align?: TextAlign; color?: typeof INK; keep?: number } = {}): Placement | null {
    let first: Placement | null = null;
    const size = options.size ?? SIZE;
    const x = options.x ?? FRAME.left;
    const width = options.width ?? BODY_W;
    const lineHeight = size * LINE;
    lines.forEach((line, index) => {
      // Widow/orphan control: never leave a single line of a longer block behind or ahead of a page break.
      const needed = index === 0 && lines.length > 1 ? lineHeight * 2 : index === lines.length - 2 && lines.length > 2 ? lineHeight * 2 : lineHeight;
      this.ensure(index === 0 ? Math.max(needed, (options.keep ?? 0) + lineHeight) : needed);
      const offset = options.align === "right" ? width - line.width : options.align === "center" ? (width - line.width) / 2 : 0;
      first ??= { page: this.page, top: this.y };
      this.drawLine(this.page, line, x + offset, this.baseline(this.y, size, lineHeight), size, options.color ?? INK);
      this.y += lineHeight;
    });
    return first;
  }

  paragraph(runs: readonly Run[], options: { x?: number; width?: number; size?: number; align?: TextAlign; after?: number; keep?: number } = {}): void {
    const size = options.size ?? SIZE;
    const laid = layoutRuns(runs, options.width ?? BODY_W, size, this.fonts);
    if (laid.length === 0) return;
    this.lines(laid, options);
    this.y += options.after ?? size * SPACING.paragraphAfterRatio;
  }

  gap(height: number): void {
    this.y += height;
  }

  // — markup blocks —

  /**
   * `headings` are the section's sub-heading labels from the engine ("2.1 TEXT", depth-first in markup order), taken
   * one per `###` line; `null` draws the lines unnumbered (the opening, an annex's intro). Nothing is counted here.
   */
  blocks(blocks: readonly Block[], headings: HeadingLabels | null, x = FRAME.left, width = BODY_W): void {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        this.paragraph(block.runs, { x, width });
      } else if (block.type === "heading") {
        const label = headings?.labels[headings.taken++] ?? block.text.toUpperCase();
        this.gap(SPACING.subHeadingBefore);
        this.paragraph([run(winAnsi(label), true)], { x, width, keep: SIZE * LINE * 2 });
      } else if (block.type === "list") {
        this.list(block.items, headings, x, width);
        this.y += SPACING.listAfter;
      } else {
        this.markupTable(block, x, width);
      }
    }
  }

  private list(items: readonly ListItem[], headings: HeadingLabels | null, x: number, width: number): void {
    const markerWidth = Math.max(14, ...items.map((item) => this.fonts.regular.widthOfTextAtSize(winAnsi(item.marker), SIZE) + 6));
    const textX = x + SPACING.listIndent + markerWidth;
    for (const item of items) {
      const laid = layoutRuns(item.runs, width - SPACING.listIndent - markerWidth, SIZE, this.fonts);
      this.ensure(SIZE * LINE * Math.min(laid.length, 2));
      const at = this.lines(laid, { x: textX, width: width - SPACING.listIndent - markerWidth });
      // The marker sits on the item's first line, which may have moved to a fresh page.
      const markerLine = layoutRuns([run(item.marker)], markerWidth, SIZE, this.fonts)[0];
      if (at && markerLine) this.drawLine(at.page, markerLine, x + SPACING.listIndent, this.baseline(at.top, SIZE, SIZE * LINE), SIZE);
      this.y += SPACING.listItemAfter;
      if (item.children.length > 0) this.blocks(item.children, headings, textX, width - SPACING.listIndent - markerWidth);
    }
  }

  // — tables —

  private markupTable(block: Extract<Block, { type: "table" }>, x: number, width: number): void {
    const columns = block.header.length;
    const text = (cellLines: readonly CellLine[]) => cellLines.reduce((sum, line) => sum + line.runs.reduce((n, r) => n + r.text.length, 0), 0);
    const weights = Array.from({ length: columns }, (_, index) =>
      Math.min(60, Math.max(8, ...[block.header, ...block.rows].map((row) => text(row[index] ?? [])))),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => Math.max(40, (width * weight) / total));
    const scale = width / widths.reduce((sum, w) => sum + w, 0);
    const rows: RowSpec[] = [
      { cells: block.header.map((lines) => ({ lines: lines.map((l) => ({ ...l, runs: asBold(l.runs) })) })), header: true },
      ...block.rows.map((row) => ({ cells: row.map((lines) => ({ lines })) })),
    ];
    this.table(widths.map((w) => w * scale), rows, x);
    this.gap(SPACING.tableAfter);
  }

  /** A ruled table; header shaded and repeated after a page break, rows never split. */
  table(widths: readonly number[], rows: readonly RowSpec[], x = FRAME.left, size = TABLE_SIZE): void {
    const lineHeight = size * LINE;
    const frameHeight = LIMIT - FRAME.top;

    const measured = rows.map((row) => {
      let column = 0;
      const placed = row.cells.map((spec) => {
        const span = spec.span ?? 1;
        const cellWidth = widths.slice(column, column + span).reduce((sum, w) => sum + w, 0);
        const offset = widths.slice(0, column).reduce((sum, w) => sum + w, 0);
        column += span;
        const inner = cellWidth - 2 * CELL_PAD;
        const laid: { lines: Line[]; bullet: boolean }[] = [];
        for (const source of spec.lines) {
          const runs = row.bold || row.header ? asBold(source.runs) : source.runs;
          const bulletWidth = source.bullet ? SPACING.cellBulletIndent : 0;
          for (const [index, line] of layoutRuns(runs, inner - bulletWidth, size, this.fonts).entries()) {
            laid.push({ lines: [line], bullet: source.bullet && index === 0 });
          }
        }
        return { spec, offset, cellWidth, laid, bulletIndent: spec.lines.some((l) => l.bullet) ? SPACING.cellBulletIndent : 0 };
      });
      const lineCount = Math.max(1, ...placed.map((p) => p.laid.length));
      let height = lineCount * lineHeight + 2 * CELL_PAD;
      if (height > frameHeight) {
        console.warn("[contractPdf] a table row taller than a page was clipped");
        height = Math.floor((frameHeight - 2 * CELL_PAD) / lineHeight) * lineHeight + 2 * CELL_PAD;
      }
      return { row, placed, height, maxLines: Math.floor((height - 2 * CELL_PAD) / lineHeight) };
    });

    const header = measured[0]?.row.header ? measured[0] : null;
    const drawRow = (item: (typeof measured)[number]) => {
      const top = this.y;
      for (const placed of item.placed) {
        const left = x + placed.offset;
        this.page.drawRectangle({
          x: left,
          y: PAGE_H - top - item.height,
          width: placed.cellWidth,
          height: item.height,
          borderColor: GRID,
          borderWidth: 0.5,
          ...(item.row.header ? { color: SHADE } : {}),
        });
        placed.laid.slice(0, item.maxLines).forEach((entry, index) => {
          const line = entry.lines[0]!;
          const lineTop = top + CELL_PAD + index * lineHeight;
          const inner = placed.cellWidth - 2 * CELL_PAD - placed.bulletIndent;
          const shift = placed.spec.align === "right" ? inner - line.width : placed.spec.align === "center" ? (inner - line.width) / 2 : 0;
          const base = this.baseline(lineTop, size, lineHeight);
          this.drawLine(this.page, line, left + CELL_PAD + placed.bulletIndent + shift, base, size);
          if (entry.bullet) {
            this.text(this.page, "•", { x: left + CELL_PAD, y: base, size, font: this.fonts.regular, color: INK });
          }
        });
      }
      this.y += item.height;
    };

    measured.forEach((item, index) => {
      const firstBody = header ? index === 1 : index === 0;
      // Keep the header with its first row, and never split a row.
      const needed = item.height + (index === 0 && header && measured[1] ? measured[1].height : 0) + (firstBody && header ? 0 : 0);
      if (this.pages.length === 0 || this.y + needed > LIMIT) {
        this.newPage();
        if (header && item !== header) drawRow(header);
      }
      drawRow(item);
    });
  }

  /** One numbered section: its heading (from the engine), the cost table when it carries it, its text. Returns its first page. */
  section(numbered: NumberedSection, body: string, costs: boolean): number {
    this.gap(SPACING.sectionBefore);
    // A heading never sits alone at the bottom of a page: it needs its first lines (or the table header and row).
    this.ensure(HEADING_SIZE * LINE + SIZE * LINE * (costs ? 4 : 3));
    const page = this.pages.length;
    this.paragraph([run(numbered.heading, true)], { size: HEADING_SIZE, after: SPACING.sectionHeadingAfter });
    if (costs) this.costTable();
    this.blocks(parseMarkup(body), { labels: numbered.subheadings, taken: 0 });
    return page;
  }

  // — fixed blocks —

  indexLine(label: string, page: number): void {
    const size = SIZE;
    const lineHeight = size * LINE;
    this.ensure(lineHeight);
    const text = winAnsi(label);
    const number = String(page);
    const numberWidth = this.fonts.regular.widthOfTextAtSize(number, size);
    const labelWidth = this.fonts.regular.widthOfTextAtSize(text, size);
    const dot = this.fonts.regular.widthOfTextAtSize(".", size);
    const available = BODY_W - labelWidth - NUMBER_COLUMN - 8;
    const baseline = PAGE_H - (this.y + (lineHeight - size) / 2 + size * 0.85);
    this.text(this.page, text, { x: FRAME.left, y: baseline, size, font: this.fonts.regular, color: INK });
    if (available > dot * 3) {
      // Leaders end at one x for every line, so the page numbers form a right-aligned column.
      const count = Math.floor(available / dot);
      this.text(this.page, ".".repeat(count), {
        x: FRAME.left + BODY_W - NUMBER_COLUMN - 4 - count * dot,
        y: baseline,
        size,
        font: this.fonts.regular,
        color: INK,
      });
    }
    this.text(this.page, number, { x: FRAME.left + BODY_W - numberWidth, y: baseline, size, font: this.fonts.regular, color: INK });
    this.y += lineHeight;
  }

  bulletLine(text: string): void {
    const laid = layoutRuns([run(text)], BODY_W - SPACING.bulletTextIndent, SIZE, this.fonts);
    this.ensure(SIZE * LINE);
    const top = this.y;
    const page = this.page;
    this.text(this.page, "•", { x: FRAME.left + SPACING.bulletMarkerIndent, y: PAGE_H - (top + (SIZE * LINE - SIZE) / 2 + SIZE * 0.85), size: SIZE, font: this.fonts.regular, color: INK });
    void page;
    this.lines(laid, { x: FRAME.left + SPACING.bulletTextIndent, width: BODY_W - SPACING.bulletTextIndent });
  }

  acceptance(): void {
    const { language, acceptanceLabel } = this.snapshot;
    const t = words(language);
    const lineHeight = SIZE * LINE;
    // The whole block stays on one page: heading, optional label, two fill-in lines.
    this.ensure(lineHeight * (acceptanceLabel ? 2 : 1) + 8 + 2 * (lineHeight + SPACING.acceptanceLineHeight));
    this.paragraph([run(t.acceptance, true)], { after: SPACING.acceptanceTitleAfter });
    if (acceptanceLabel) this.paragraph([run(acceptanceLabel, true)], { after: SPACING.acceptanceTitleAfter });
    for (const label of [t.place, t.signature]) {
      this.gap(SPACING.acceptanceLineGap);
      const width = this.fonts.regular.widthOfTextAtSize(winAnsi(label), SIZE);
      const base = this.baseline(this.y, SIZE, lineHeight);
      this.text(this.page, winAnsi(label), { x: FRAME.left, y: base, size: SIZE, font: this.fonts.regular, color: INK });
      this.page.drawLine({
        start: { x: FRAME.left + width + 6, y: base - 1.5 },
        end: { x: FRAME.left + BODY_W, y: base - 1.5 },
        thickness: 0.5,
        color: GRID,
      });
      this.y += lineHeight + SPACING.acceptanceLineGap;
    }
  }

  annexTable(scope: NonNullable<ContractSnapshot["annex"]>): void {
    const { language } = this.snapshot;
    const t = words(language);
    const days = (tenths: number) => formatManDays(tenths, language);
    const widths = [BODY_W * 0.3, BODY_W * 0.5, BODY_W * 0.2];
    const rows: RowSpec[] = [{ cells: [cell(t.release), cell(t.epic), cell(t.manDays, "right")], header: true }];
    for (const release of scope.releases) {
      rows.push({ bold: true, cells: [cell(release.name), cell(""), cell(days(release.manDaysTenths), "right")] });
      for (const epic of release.epics) {
        rows.push({ cells: [cell(""), cell(epic.epic), cell(days(epic.manDaysTenths), "right")] });
      }
    }
    rows.push({ bold: true, cells: [cell(t.annexTotal, "left", 2), cell(days(scope.manDaysTenths), "right")] });
    this.table(widths, rows);
  }

  // — cost table (AC-1.5) —

  costTable(): void {
    const { costs, language } = this.snapshot;
    const t = words(language);
    const { currency, columns } = costs;
    // The template's own column headers (plain surfaces, DD-47) replace the defaults, and the columns grow to hold them
    // (a bold 9.5 pt "Giorni" does not fit the default 32 pt quantity column without being cut in the middle).
    const unitLabel = costs.labels?.unit != null ? plain(costs.labels.unit) : t.unit(currency);
    const quantityLabel = costs.labels?.quantity != null ? plain(costs.labels.quantity) : t.quantity;
    const fitting = (label: string | null | undefined, least: number): number =>
      label == null ? least : Math.max(least, Math.ceil(textWidth(this.fonts.bold, plain(label), TABLE_SIZE)) + 2 * CELL_PAD + 2);
    const unitWidth = columns.unit ? fitting(costs.labels?.unit, 66) : 0;
    const qtyWidth = columns.unit ? fitting(costs.labels?.quantity, 32) : 0;
    const posWidth = columns.position ? 30 : 0;
    const totalWidth = 82;
    const widths = [
      ...(columns.position ? [posWidth] : []),
      BODY_W - posWidth - unitWidth - qtyWidth - totalWidth,
      ...(columns.unit ? [unitWidth, qtyWidth] : []),
      totalWidth,
    ];
    const head: CellSpec[] = [
      ...(columns.position ? [cell(t.position)] : []),
      cell(t.item),
      ...(columns.unit ? [cell(unitLabel, "right"), cell(quantityLabel, "right")] : []),
      cell(t.amount(currency), "right"),
    ];
    const rows: RowSpec[] = [{ cells: head, header: true }];
    const spanned = widths.length - 1;
    const totalRow = (label: string, amount: string): RowSpec => ({ bold: true, cells: [cell(label, "left", spanned), cell(amount, "right")] });

    if (costs.rows) {
      // A wizard table: lines and total rows in order, every figure and position read from the engine.
      const result = computeCosts(costRowsOf(costs));
      costs.rows.forEach((row, index) => {
        const out = result.rows[index]!;
        if (row.type === "total") {
          if (!costs.showTotal) return;
          // A span with no counted line (or one still incomplete) prints a dash, never a made-up zero.
          const amount = out.type === "total" && out.state === "ok" && out.totalCents !== null ? formatAmount(out.totalCents, currency) : "–";
          rows.push(totalRow(plain(row.label), amount));
        } else if (out.type === "line") {
          const line: OfferCostLine = {
            description: row.description,
            kind: row.kind,
            unitCents: row.unitCents,
            percentBp: row.percentBp,
            quantity: row.quantity ?? 1,
            totalCents: out.totalCents ?? 0,
          };
          rows.push({ cells: this.costRow(line, columns, currency, out.position) });
        }
      });
    } else {
      // A legacy table: its lines are one span with the single TOTAL row of 018.
      const positions = costPositions(costs);
      for (const [index, line] of costs.lines.entries()) {
        rows.push({ cells: this.costRow(line, columns, currency, positions[index] ?? null) });
      }
      if (costs.showTotal) rows.push(totalRow(t.total, formatAmount(costs.oneOffCents, currency)));
    }
    this.table(widths, rows);
    this.gap(SPACING.costTableAfter);
  }

  private costRow(line: OfferCostLine, columns: { position: boolean; unit: boolean }, currency: "CHF" | "EUR", position: number | null): CellSpec[] {
    const discount = line.kind === "discount";
    const percent = discount && line.percentBp !== null;
    // A cost description is a plain surface: drawn as written, never parsed (DD-47).
    const text = line.kind === "option" ? `${BALLOT_BOX} ${plain(line.description)}` : plain(line.description);
    const description = percent && !columns.unit ? `${text} (${formatPercent(line.percentBp!)})` : text;
    const total = `${discount ? "- " : ""}${formatAmount(line.totalCents, currency)}`;
    return [
      ...(columns.position ? [cell(position === null ? "" : String(position))] : []),
      cell(description),
      ...(columns.unit
        ? [
            cell(percent ? formatPercent(line.percentBp!) : line.unitCents === null ? "" : `${discount ? "- " : ""}${formatAmount(line.unitCents, currency)}`, "right"),
            cell(percent ? "" : String(line.quantity), "right"),
          ]
        : []),
      cell(total, "right"),
    ];
  }
}

// ─── The document ────────────────────────────────────────────────────────────

/** A legacy table has no total rows: its lines are the engine's rows, in order, one span. */
const costRowsOf = (costs: OfferCosts): CostRowIn[] =>
  (costs.rows ?? costs.lines.map((line, index) => ({ type: "line" as const, name: `cost:${index}`, ...line }))).map((row) =>
    row.type === "total"
      ? { type: "total" as const, label: row.label }
      : { type: "line" as const, name: row.name, kind: row.kind, unitCents: row.unitCents, percentBp: row.percentBp, quantity: row.quantity },
  );

/** The position of each cost LINE, in line order (null for a discount), as the engine numbers them. */
function costPositions(costs: OfferCosts): (number | null)[] {
  const positions: (number | null)[] = [];
  for (const row of computeCosts(costRowsOf(costs)).rows) if (row.type === "line") positions.push(row.position);
  return positions;
}

const sectionKey = (index: number): string => `section:${index}`;

/** The numbering of the document the snapshot describes: one engine call for a legacy and a wizard snapshot alike. */
function numberingOf(snapshot: ContractSnapshot): NumberedOffer {
  return numberOffer({
    language: snapshot.language,
    // Headings and titles are plain surfaces (DD-47): a marker character is split out before numbering prints them.
    sections: snapshot.sections.map((section, index) => ({ key: sectionKey(index), heading: plain(section.heading), body: section.body })),
    annexes: (snapshot.textAnnexes ?? []).map((annex) => ({
      designation: annex.designation,
      title: plain(annex.title),
      sections: annex.sections.map((section, index) => ({ key: `annex:${annex.designation}:${index}`, heading: plain(section.heading), body: section.body })),
    })),
    effortAnnex: snapshot.annex !== null,
    attachmentNames: snapshot.attachments.map((attachment) => attachment.fileName),
  });
}

/** Lays out the contract and the effort-detail annex on `doc`; `known` (a previous pass) feeds the index its page numbers. */
async function layout(
  doc: PDFDocument,
  snapshot: ContractSnapshot,
  letterhead: Uint8Array | null,
  known: PassResult | null,
  log: DrawnText[] | null,
): Promise<{ flow: Flow; result: PassResult }> {
  const t = words(snapshot.language);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const embedded = letterhead ? (await doc.embedPdf(letterhead))[0]! : null;
  const flow = new Flow(doc, fonts, embedded, snapshot, log);
  const numbering = numberingOf(snapshot);
  const pages = new Map<string, number>();

  flow.newPage();

  // — page 1: salutation, client, contacts, place and date, title —
  flow.paragraph([run(snapshot.salutation)], { after: 0 });
  snapshot.clientLines.forEach((line, index) => flow.paragraph([run(line, index === 0)], { after: 0 }));
  flow.gap(SPACING.clientAfter);
  if (snapshot.contacts.length > 0) {
    flow.paragraph([run(`${t.attn} ${snapshot.contacts.join(", ")}`, true)], { after: 0 });
    flow.gap(SPACING.contactsAfter);
  }
  const date = shortDate(snapshot.issuedOn);
  flow.paragraph([run(snapshot.place ? `${snapshot.place}, ${date}` : date)], { align: "right", after: SPACING.dateAfter });
  flow.paragraph([run(t.title(snapshot.reference), true)], { size: TITLE_SIZE, align: "center", after: SPACING.titleAfter });

  // — index, only with the effort-detail annex (D-8) —
  if (numbering.index) {
    flow.paragraph([run(t.index, true)], { after: SPACING.indexTitleAfter });
    for (const entry of numbering.index) flow.indexLine(entry.label, known?.pages.get(entry.target) ?? 0);
    flow.gap(SPACING.indexAfter);
  }

  flow.blocks(parseMarkup(snapshot.opening), null);

  // — sections —
  for (const [index, section] of snapshot.sections.entries()) {
    const numbered = numbering.sections[index]!;
    pages.set(numbered.key, flow.section(numbered, section.body, section.costs));
  }

  // — acceptance —
  flow.gap(SPACING.acceptanceBefore);
  flow.acceptance();

  // — annexes list —
  if (numbering.annexList.length > 0) {
    flow.ensure(SIZE * LINE * 3 + 8);
    flow.paragraph([run(t.annexes, true)], { after: SPACING.annexListTitleAfter, keep: SIZE * LINE });
    for (const entry of numbering.annexList) flow.bulletLine(entry);
  }

  // — text annexes: each from a new page, in template order, before the effort-detail annex —
  for (const [index, annex] of (snapshot.textAnnexes ?? []).entries()) {
    const numbered = numbering.annexes[index]!;
    flow.newPage();
    pages.set(`annex:${annex.designation}`, flow.pages.length);
    flow.paragraph([run(numbered.heading, true)], { size: HEADING_SIZE, after: annex.subtitle ? SPACING.annexHeadingAfterWithSubtitle : SPACING.annexHeadingAfter });
    const subtitle = annex.subtitle === null ? "" : plain(annex.subtitle).trim();
    if (subtitle !== "") flow.paragraph([{ text: subtitle, bold: false, italic: true, underline: false }], { after: SPACING.annexSubtitleAfter });
    // What stands between the heading and the first section: unnumbered, so the sections' numbers stay the annex's own.
    flow.blocks(parseMarkup(annex.intro), null);
    annex.sections.forEach((section, at) => flow.section(numbered.sections[at]!, section.body, false));
  }

  // — the effort-detail annex —
  if (snapshot.annex && numbering.effortAnnexLetter) {
    flow.newPage();
    pages.set("annex:effort", flow.pages.length);
    flow.paragraph([run(t.annexHeading(numbering.effortAnnexLetter), true)], { size: HEADING_SIZE, after: SPACING.annexHeadingAfter });
    if (snapshot.annex.aiAssisted) flow.paragraph([{ text: t.aiNote, bold: false, italic: true, underline: false }], { after: SPACING.annexSubtitleAfter });
    flow.annexTable(snapshot.annex);
  }

  return { flow, result: { pages, pageCount: flow.pages.length } };
}

export async function renderContractPdf(snapshot: ContractSnapshot, inputs: RenderInputs, options: RenderOptions = {}): Promise<Uint8Array> {
  // Unreadable attachments fail first, before any layout work.
  const appended: PDFDocument[] = [];
  for (const [index, bytes] of inputs.attachments.entries()) {
    const fileName = snapshot.attachments[index]?.fileName ?? `attachment ${index + 1}`;
    // The decoded-size bound runs on the bytes about to be loaded, whatever was checked when they were uploaded: a deal PDF
    // is a person's file, pdf-lib inflates every object and cross-reference stream while it loads, and a file stored before
    // the bound existed (or rewritten inside its upload policy's minute) was never checked (security M-7).
    const bound = await boundPdfIsolated(bytes);
    if (!bound.ok) {
      console.warn(`[offers] attachment refused by the bound reason=${bound.reason}`);
      throw new AttachmentUnreadableError(fileName);
    }
    try {
      const source = await PDFDocument.load(bytes);
      // `load` only checks the header, trailer and catalog: a missing or malformed page tree throws on its first read, which would
      // otherwise be `copyPages` below, after the layout work and as a 500 (T45).
      source.getPageIndices();
      appended.push(source);
    } catch {
      throw new AttachmentUnreadableError(fileName);
    }
  }

  // The first pass finds the pages and logs nothing; the second is the document, and the only one logged.
  const first = await layout(await PDFDocument.create(), snapshot, inputs.letterhead, null, null);
  const doc = await PDFDocument.create();
  const { flow, result } = await layout(doc, snapshot, inputs.letterhead, first.result, options.drawLog ?? null);

  // Page numbers count the contract and Annex A pages only; the corner is painted over first (D-2).
  flow.pages.forEach((page, index) => {
    if (inputs.letterhead) {
      page.drawRectangle({ ...NUMBER_CORNER, color: WHITE, borderWidth: 0 });
    }
    const label = `${index + 1}/${result.pageCount}`;
    const width = flow.fonts.regular.widthOfTextAtSize(label, NUMBER_SIZE);
    flow.text(page, label, { x: NUMBER_RIGHT - width, y: NUMBER_BASELINE, size: NUMBER_SIZE, font: flow.fonts.regular, color: SOFT });
  });

  for (const source of appended) {
    const copied = await doc.copyPages(source, source.getPageIndices());
    for (const page of copied) doc.addPage(page);
  }

  const issued = new Date(`${snapshot.issuedOn}T00:00:00Z`);
  doc.setTitle(winAnsi(`${words(snapshot.language).offer} ${snapshot.reference}`));
  doc.setAuthor(winAnsi(oneLine(snapshot.issuer.legalName)));
  doc.setCreator("Operai CRM");
  doc.setProducer("Operai CRM");
  doc.setCreationDate(issued);
  doc.setModificationDate(issued);
  return doc.save({ useObjectStreams: false });
}
