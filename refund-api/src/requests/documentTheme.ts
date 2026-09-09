/**
 * Print theme for refund documents — colour, type scale and rules.
 *
 * ADAPTED FROM the suite's brand kit, deliberately NOT copied from it. The UI
 * tokens are built for a dark surface; a document is ink on white paper, read
 * under a desk lamp and photocopied. Carrying the screen palette over
 * literally would produce a page that is either unreadable or a toner sink.
 *
 * GREYSCALE IS THE FLOOR. Every one of these documents will be printed, faxed
 * to an accountant, or scanned back in monochrome. Colour is therefore only
 * ever an accent on something that already reads without it: the status chip
 * carries its own word, the total row is bold and ruled, and no figure is ever
 * distinguished by colour alone. If a rule here is ever relaxed, that is the
 * one to keep.
 *
 * ─── ASSET GAP (2026-09-09) ──────────────────────────────────────────────
 * The brand kit specifies Ubuntu (Light/Medium/Regular) for the document and
 * Noto Serif for prose blocks, plus `wordmark-red.svg` in the letterhead.
 * NONE of those files exist in this repository — `src/batches/fonts/` holds
 * only NotoSans Regular and Bold, and there is no brand asset directory at
 * all. Rather than block the layout on them, this module isolates the seam:
 *
 *   1. Drop `Ubuntu-Light.ttf`, `Ubuntu-Medium.ttf`, `Ubuntu-Regular.ttf` and
 *      `NotoSerif-Regular.ttf` into `src/requests/fonts/`.
 *   2. Point `FONT_FILES` below at them.
 *   3. Nothing else changes — every call site asks for a ROLE (`title`,
 *      `label`, `value`, `prose`), never a file.
 *
 * Until then all four roles resolve to Noto Sans, which is a competent
 * substitute and, importantly, has TABULAR figures by default: all ten digits
 * measure identically (5.72pt at size 10), so the money column aligns
 * digit-for-digit. That matters because pdf-lib cannot apply OpenType features
 * — `tnum` is not something we could switch on if the chosen face lacked it,
 * so any replacement font MUST have tabular lining figures natively.
 */

import { rgb, type RGB } from "pdf-lib";

// ─── Colour ──────────────────────────────────────────────────────────────────

const hex = (value: string): RGB => {
  const n = parseInt(value.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const COLOR = {
  /** Near-black, not pure black: pure black on white is harsh in print and bleeds on cheap toner. */
  ink: hex("#1a1a1a"),
  /** Secondary text — labels, detail cells, footer. Holds up in greyscale as a lighter grey. */
  muted: hex("#6b6b73"),
  /** Brand red. Sparingly: the letterhead rule, the total rule, a rejected chip. */
  brand: hex("#e50339"),
  /** Brand teal — an approved chip only. */
  teal: hex("#03a59a"),
  /** Hairline separators. Light enough to structure without competing with the figures. */
  hairline: hex("#d8d8dd"),
  /** Fill behind a neutral chip / the receipts note. */
  wash: hex("#f4f4f6"),
} as const;

// ─── Type scale ──────────────────────────────────────────────────────────────
//
// The kit's sizes are screen px; these are PRINT points, which is why they are
// smaller rather than a 1:1 transcription (12px label ≈ 9pt on paper). The
// role names mirror the kit so the mapping stays legible.

export const TYPE = {
  /** headline.small — the document title. */
  title: 17,
  /** The letterhead's company name. */
  letterhead: 10,
  /** label.medium — uppercase field labels and table headers. */
  label: 8,
  /** Body values, table cells, amounts. */
  value: 9.5,
  /** label.small — detail cells, the receipts note, the footer. */
  small: 7.5,
  /** Prose blocks (a rejection motivation). Larger and set looser: it is read, not scanned. */
  prose: 10,
} as const;

// ─── Page geometry ───────────────────────────────────────────────────────────

export const PAGE = {
  width: 595.28, // A4 portrait, points
  height: 841.89,
  /** ~20mm. Wide enough to survive a stapled/hole-punched archive copy. */
  margin: 56.7,
} as const;

export const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;

/**
 * Font ROLES. Every caller asks for one of these; none names a file.
 *
 * `title`/`label` map to Bold and `value`/`prose` to Regular today, because
 * Noto Sans ships two weights here. With Ubuntu present, `title` becomes
 * Light, `label` Medium and `value` Regular, and `prose` becomes Noto Serif —
 * a change confined to `loadDocumentFonts`.
 */
export type FontRole = "title" | "label" | "value" | "prose";
