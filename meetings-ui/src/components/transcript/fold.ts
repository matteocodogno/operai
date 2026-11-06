/**
 * fold — case- and accent-insensitive matching for the transcript search (AC-6.4).
 *
 * Folding changes string length ("é" decomposes to two code points), so matches are found in the
 * folded text and mapped back to ranges of the ORIGINAL text, which is what gets highlighted.
 */

const MARKS = /\p{M}/gu

/** Lower-cases and strips accents: "Perché" → "perche". */
export const fold = (text: string): string => text.normalize('NFD').replace(MARKS, '').toLowerCase()

export type Range = { start: number; end: number }

/** Every non-overlapping occurrence of `query` in `text`, as ranges of `text` (UTF-16 indexes). */
export function findMatches(text: string, query: string): Range[] {
  const needle = fold(query.trim())
  if (needle === '') return []

  // Fold code point by code point, remembering which original index each folded char came from.
  let folded = ''
  const origin: number[] = []
  let index = 0
  for (const char of text) {
    const piece = fold(char)
    for (let i = 0; i < piece.length; i++) origin.push(index)
    folded += piece
    index += char.length
  }

  const ranges: Range[] = []
  let from = 0
  for (;;) {
    const at = folded.indexOf(needle, from)
    if (at === -1) return ranges
    const next = at + needle.length
    // The end is the start of the next folded char, so trailing combining marks stay inside the match.
    ranges.push({ start: origin[at]!, end: next < origin.length ? origin[next]! : text.length })
    from = next
  }
}
