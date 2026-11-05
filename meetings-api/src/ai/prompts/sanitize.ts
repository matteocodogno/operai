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

const ROLE_KEYWORDS = "system|assistant|developer|operai|administrator|sistema|assistente|amministratore";
const ROLE_WORDS = "message|notice|prompt|instructions?|update|alert|warning|override|messaggio|avviso";
const ROLE_LINE = new RegExp(
  String.raw`^([\s#>*\-•]*)\[?\s*(${ROLE_KEYWORDS})((?:\s+(?:${ROLE_WORDS}))?)\s*([\]:：])`,
  "gim",
);

const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "g");

/** @param allowedUrls the URLs of the transcript, from `urlsIn` */
export function sanitizeProse(text: string, allowedUrls: ReadonlySet<string>): string {
  let out = text
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPARATORS, "\n")
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

  // A role label at the start of a line is quoted.
  out = out.replace(ROLE_LINE, (_match, lead: string, keyword: string, words: string, closer: string) => {
    const quoted = `${lead}${LEFT_QUOTE}${keyword}${words}${RIGHT_QUOTE}`;
    return closer === "]" ? quoted : `${quoted}${closer}`;
  });

  return out
    .replace(/(?<=\S) {2,}(?=\S)/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
