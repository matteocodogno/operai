/**
 * Shared PDF text extraction for tests — decodes a rendered PDF back into a
 * plain-text approximation of what it visually renders, via each embedded
 * font's own `/ToUnicode` CMap.
 *
 * Lives here rather than inside one test file because BOTH PDF renderers need
 * it: `batches/pdf.test.ts` (where it was written) and
 * `requests/exportPdf.test.ts`. Duplicating ~150 lines of CMap decoding into a
 * second suite would guarantee the two drift.
 *
 * This is NOT a re-prediction of pdf-lib's internal glyph/CID assignment — it
 * decodes exactly the way a real PDF reader does, which is what makes it a
 * meaningful check that a human opening the file sees the expected words. That
 * matters here specifically: the renderers embed SUBSET fonts, so the raw
 * content-stream bytes are glyph ids, not readable text, and a naive
 * string-match against the file would pass no matter what the page says.
 */

import zlib from "node:zlib";
import { PDFArray, PDFDocument, PDFDict, PDFName, PDFStream, type PDFRef } from "pdf-lib";

// ─── PDF text extraction via the document's own embedded ToUnicode CMaps
//     (see module doc — this is NOT a re-prediction of pdf-lib's internal
//     glyph/CID assignment, it decodes exactly like a real PDF reader) ─────

/** Parses a `beginbfchar…endbfchar` / `beginbfrange…endbfrange` ToUnicode CMap into CID(hex) → text. */
function parseToUnicodeCMap(cmapText: string): Map<string, string> {
  const map = new Map<string, string>();

  const utf16beHexToString = (hex: string): string => {
    const bytes = Buffer.from(hex, "hex");
    let text = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(bytes.readUInt16BE(i));
    }
    return text;
  };

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let section: RegExpExecArray | null;
  while ((section = bfcharRe.exec(cmapText))) {
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = entryRe.exec(section[1] as string))) {
      const cid = (entry[1] as string).toUpperCase().padStart(4, "0");
      map.set(cid, utf16beHexToString(entry[2] as string));
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((section = bfrangeRe.exec(cmapText))) {
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = entryRe.exec(section[1] as string))) {
      const lo = parseInt(entry[1] as string, 16);
      const hi = parseInt(entry[2] as string, 16);
      const dstStart = parseInt(entry[3] as string, 16);
      for (let cid = lo; cid <= hi; cid++) {
        map.set(cid.toString(16).toUpperCase().padStart(4, "0"), String.fromCharCode(dstStart + (cid - lo)));
      }
    }
  }

  return map;
}

/** Builds resource-name (`/Foo-123`) → CID-to-Unicode map, across every page's font resources. */
function buildFontCidMaps(doc: PDFDocument): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const page of doc.getPages()) {
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fontDict) continue;
    for (const [name, ref] of fontDict.entries()) {
      // `PDFName.asString()` already includes the leading `/` — do not
      // re-prefix it (that produced a silently-never-matching `//Name` key
      // here, against which `Tf`'s `/name` regex capture — WITHOUT the
      // slash — never matched either, however this was still keyed).
      const resourceName = name.asString();
      if (result.has(resourceName)) continue;
      const fontObj = doc.context.lookup(ref as PDFRef, PDFDict);
      const toUnicodeRef = fontObj.get(PDFName.of("ToUnicode"));
      if (!toUnicodeRef) continue;
      const stream = doc.context.lookup(toUnicodeRef as PDFRef, PDFStream);
      const inflated = zlib.inflateSync(Buffer.from(stream.getContents())).toString("latin1");
      result.set(resourceName, parseToUnicodeCMap(inflated));
    }
  }
  return result;
}

/**
 * Inflates a stream's contents, falling back to the raw bytes if it isn't
 * Flate-compressed (defensive — `pdf-lib` always Flate-compresses the
 * streams this module reads, but this keeps the helper honest either way).
 */
function inflateStream(stream: PDFStream): string {
  const raw = Buffer.from(stream.getContents());
  try {
    return zlib.inflateSync(raw).toString("latin1");
  } catch {
    return raw.toString("latin1");
  }
}

/**
 * Resolves a page's `/Contents` entry (a single stream, or an array of
 * streams — the PDF spec allows both) into its constituent `PDFStream`s.
 * Deliberately does NOT scan the raw file bytes for literal `stream`/
 * `endstream` markers — the renderer embeds actual binary TrueType font
 * program data (`FontFile2`) alongside the content streams, and that binary
 * data can coincidentally contain those ASCII byte sequences, which
 * misaligns a naive text-scan. Going through `pdf-lib`'s own parsed object
 * graph (already correctly framed via the file's xref/Length entries when
 * `PDFDocument.load` ran) sidesteps that entirely.
 */
function getContentStreams(doc: PDFDocument, page: ReturnType<PDFDocument["getPage"]>): PDFStream[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((ref) => doc.context.lookup(ref as PDFRef, PDFStream));
  }
  return [contents as PDFStream];
}

/**
 * Decodes a rendered batch PDF back into a plain-text approximation of what
 * it visually renders — one space-joined string per drawn `Tj` run, in
 * document order, via each active font's embedded `/ToUnicode` CMap.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const doc = await PDFDocument.load(buffer);
  const cidMaps = buildFontCidMaps(doc);

  const parts: string[] = [];
  for (const page of doc.getPages()) {
    for (const stream of getContentStreams(doc, page)) {
      const inflated = inflateStream(stream);
      if (!inflated.includes(" Tj")) continue; // not a text-drawing content stream

      // Track which font resource is active (last `/Name size Tf`) so each
      // `Tj` hex run decodes through the RIGHT font's CID map.
      const tokenRe = /\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj/g;
      let activeMap: Map<string, string> | undefined;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(inflated))) {
        if (token[1] !== undefined) {
          activeMap = cidMaps.get(`/${token[1]}`);
        } else if (token[2] !== undefined) {
          const hex = token[2];
          let text = "";
          for (let i = 0; i < hex.length; i += 4) {
            text += activeMap?.get(hex.slice(i, i + 4).toUpperCase()) ?? "�";
          }
          parts.push(text);
        }
      }
    }
  }
  return parts.join(" ");
}

