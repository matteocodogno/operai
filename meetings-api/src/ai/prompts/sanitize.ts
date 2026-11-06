/**
 * Neutralising model prose (specs/021-meetings AC-7.12, AC-9.7; ADR-0067 points 3 and 4).
 *
 * What a summary body or an answer says is the model's prose, and the model read text
 * written by whoever spoke in the meeting. Shape is the server's (headings, order, count,
 * citations: see summary.ts and answer.ts); prose is the model's, so prose is the part that
 * is cleaned before it is stored:
 *
 *   - Markdown links and images become their visible text, so injected text cannot
 *     exfiltrate through an image URL or dress a phishing link up as a label;
 *   - a URL that the TRANSCRIPT does not contain is removed (the meeting really saying
 *     "go to welld.ch" is not an injection; a model inventing a link is);
 *   - markup (tags, comments) is stripped, control characters dropped;
 *   - a line that opens with a role label ("SYSTEM:", "Assistant:", "[system]") is
 *     QUOTED, so it cannot pass for an application banner. A line that merely mentions the
 *     word is left alone.
 *
 * The result is shown as plain text with line breaks; React escapes whatever remains.
 * None of this replaces the labelling ("AI-generated") or the transcript being one click
 * away: the residual risk of a misleading paragraph is accepted and named (R14).
 */

/** Bare domains are only recognised under these suffixes: wider would eat "e.g." and "Node.js". */
const BARE_TLDS = "com|org|net|io|ch|eu|ai|dev|app|info|biz|xyz|ru|cn|de|fr|uk|us|ly|gg|tk|ml";

const URL_RE = new RegExp(
  [
    String.raw`[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'\]]+`, // scheme://...
    String.raw`\b(?:mailto|javascript|vbscript|data|file|tel):[^\s<>"']+`, // opaque schemes
    String.raw`\bwww\.[^\s<>"'\]]+`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s<>"'\]]*`, // host.tld/path
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${BARE_TLDS})\b`, // bare domain
  ].join("|"),
  "gi",
);

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** A URL as compared: lower case, without the punctuation of the sentence it sits in. */
const core = (token: string): string => token.replace(TRAILING_PUNCTUATION, "").toLowerCase();

/** The URLs a text contains, normalised for `sanitizeProse`'s allowance. */
export function urlsIn(text: string): Set<string> {
  return new Set((text.match(URL_RE) ?? []).map(core));
}

const ROLE_KEYWORDS = [
  "system", "assistant", "developer", "operai", "operator", "admin", "administrator", // en
  "sistema", "assistente", "sviluppatore", "operatore", "amministratore", // it
].join("|");
const ROLE_WORDS = [
  "message", "notice", "prompt", "instructions?", "update", "alert", "warning", "override", // en
  "messaggio", "avviso", "istruzion[ei]", "aggiornamento", "allerta", "avvertenza", // it
].join("|");
// A line opens with any run of whitespace, markdown markers (heading, quote, bold, bullets) and
// list numbers ("1.", "12)"); then an optional one or two "[" (whitespace is allowed only after them: before them the
// lead already took it, and two ways to take it is quadratic on a long blank run), the label, an optional qualifier
// word, and a closer. The number marker carries no trailing `\s*`: the whitespace between markers
// is matched by the `\s` alternative alone, so the run cannot be split two ways (no backtracking
// blow-up on "1. 1. 1. ...").
const ROLE_LINE = new RegExp(
  String.raw`^((?:[\s#>*\-•+]|\d{1,3}[.)])*)(?:\[{1,2}\s*)?(${ROLE_KEYWORDS})((?:\s+(?:${ROLE_WORDS}))?)\s*(\]{1,2}|[:：])`,
  "i",
);

/** Characters that print as nothing (zero-width, joiners, bidi marks, soft hyphen, variation selectors). */
const INVISIBLE = /[\p{Cf}\u034f\ufe00-\ufe0f]/u;

const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);

/** Line breaks other than "\n": CR(LF), VT, FF, NEL, LS and PS all start a new line when shown. */
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;

/**
 * The line as the label rule matches it: NFKC (fullwidth and compatibility forms fold to ASCII)
 * with invisible characters removed, plus, for every folded UTF-16 unit, where it ends in the
 * ORIGINAL line, so a match can be cut out of the original without rewriting the rest of it.
 */
function fold(line: string): { folded: string; ends: number[] } {
  let folded = "";
  const ends: number[] = [];
  let pos = 0;
  for (const ch of line) {
    pos += ch.length;
    if (INVISIBLE.test(ch)) continue;
    const f = ch.normalize("NFKC");
    for (let i = 0; i < f.length; i++) ends.push(pos);
    folded += f;
  }
  return { folded, ends };
}

/** Quotes a role label opening a line; the label is matched normalised, the remainder of the line is untouched. */
function quoteRoleLabel(line: string): string {
  const { folded, ends } = fold(line);
  const m = ROLE_LINE.exec(folded);
  if (!m) return line;
  const [whole, lead = "", keyword = "", words = "", closer = ""] = m;
  const quoted = `${lead}${LEFT_QUOTE}${keyword}${words}${RIGHT_QUOTE}`;
  const head = closer.startsWith("]") ? quoted : `${quoted}${closer}`;
  return head + line.slice(ends[whole.length - 1]);
}

/** Trailing spaces off a line, in linear time (`/[ \t]+$/gm` rescans a long run from every position). */
function trimEndBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return end === line.length ? line : line.slice(0, end);
}

/** @param allowedUrls the URLs of the transcript, from `urlsIn` */
export function sanitizeProse(text: string, allowedUrls: ReadonlySet<string>): string {
  let out = text
    .replace(LINE_BREAKS, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\t/g, " ");

  // Markdown: images and links keep only their visible text; reference definitions go.
  out = out
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*\S+.*$/gm, "");

  // Markup.
  out = out.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[A-Za-z][^>\n]*>/g, "");

  // URLs the meeting did not contain. The punctuation of the sentence stays.
  out = out.replace(URL_RE, (token) => {
    if (allowedUrls.has(core(token))) return token;
    return TRAILING_PUNCTUATION.exec(token)?.[0] ?? "";
  });

  // A role label at the start of a line is quoted (matched on a normalised copy of the line).
  out = out.split("\n").map(quoteRoleLabel).join("\n");

  return out
    .replace(/(?<=\S) {2,}(?=\S)/g, " ")
    .split("\n")
    .map(trimEndBlanks)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
