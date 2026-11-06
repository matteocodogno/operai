/**
 * The transcript block of a prompt (specs/021-meetings plan.md § Summaries and
 * ask-the-meeting; ADR-0067 point 2; AC-7.12, AC-9.7).
 *
 * A transcript is text spoken or pasted by anyone, so it is UNTRUSTED INPUT. It goes
 * into the request as quoted data between `<transcript>` tags, one line per segment:
 *
 *   [S<ordinal> hh:mm:ss <speaker label>] text         (a recording)
 *   [S<ordinal>] text                                  (a text meeting: a passage)
 *
 * The structure is made of exactly three things, and a segment's text can write none of
 * them: a line (every line break in the text becomes a space), the `<transcript>` tags
 * (every `<` and `>` is replaced by an entity) and the `[S` header (a `[` that could start
 * one is replaced by a fullwidth bracket). The speaker label is user-entered too (a
 * participant name, a custom label) and is escaped the same way, plus its closing bracket.
 *
 * The same functions escape the asker's question and the template's wording: anything a
 * person typed that lands inside a prompt goes through here.
 */

/** What a prompt needs to know about one segment. `id` is never sent to the model. */
export interface PromptSegment {
  readonly id: string;
  readonly ordinal: number;
  /** null for a passage of a text meeting. */
  readonly startMs: number | null;
  /** The label as a reader sees it ("Speaker 2", a participant's name); null for a text meeting. */
  readonly speakerLabel: string | null;
  readonly text: string;
}

const LINE_BREAKS = /[\r\n\u2028\u2029\u0085\u000b\u000c]+/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
/** A `[` that could begin a segment header: followed (past blanks and zero-width characters) by an `s`. */
const HEADER_START = /\[(?=[\s\u200b-\u200f\u2060\ufeff]*s)/gi;

/** The fullwidth left square bracket: reads as a bracket to a person, is not the structure character. */
const SAFE_BRACKET = "\uff3b";

/** One line of safe text: no line break, no tag, no header start, no control character. */
export function escapeText(text: string): string {
  return text
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(/\t/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(HEADER_START, SAFE_BRACKET);
}

/** A speaker label: as text, and it cannot close the header it sits in. */
export const escapeLabel = (label: string): string => escapeText(label).replace(/\]/g, ")");

/** `hh:mm:ss`, rounded down; hours may pass 99. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

export function segmentLine(segment: PromptSegment): string {
  const header = [
    `S${segment.ordinal}`,
    ...(segment.startMs === null ? [] : [formatClock(segment.startMs)]),
    ...(segment.speakerLabel === null ? [] : [escapeLabel(segment.speakerLabel)]),
  ].join(" ");
  return `[${header}] ${escapeText(segment.text)}`;
}

export function transcriptBlock(segments: readonly PromptSegment[]): string {
  return ["<transcript>", ...segments.map(segmentLine), "</transcript>"].join("\n");
}
