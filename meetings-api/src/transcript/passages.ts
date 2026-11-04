/**
 * Turns pasted text into transcript passages (specs/021-meetings AC-3.4, AC-6.1).
 *
 * A passage is about 1,000 characters, cut at paragraph boundaries: consecutive
 * paragraphs are packed into one passage while they fit, a paragraph longer than the
 * target is cut at the last whitespace before it (at the target itself when there is
 * none), and no cut falls inside a surrogate pair. Pure; no times, no speaker.
 */

/** The target size of one passage, in UTF-16 code units. */
export const PASSAGE_CHARS = 1000;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Cuts one over-long paragraph into pieces of at most `max` code units. */
function cutParagraph(paragraph: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i > 0; i--) {
      if (/\s/.test(rest.charAt(i))) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      cut = max;
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    }
    const head = rest.slice(0, cut).trimEnd();
    if (head.length > 0) pieces.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

export function splitPassages(text: string, max: number = PASSAGE_CHARS): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[^\S\n]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const passages: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) passages.push(current);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush();
      passages.push(...cutParagraph(paragraph, max));
      continue;
    }
    if (current.length === 0) current = paragraph;
    else if (current.length + 2 + paragraph.length <= max) current = `${current}\n\n${paragraph}`;
    else {
      flush();
      current = paragraph;
    }
  }
  flush();
  return passages;
}
