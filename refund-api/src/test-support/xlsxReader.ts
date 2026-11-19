/**
 * TEST-ONLY reader of the accounting workbook (T62, specs/20261119-accounting). It is independent of `accounting/xlsx.ts` on
 * purpose (its own CRC-32, its own ZIP and XML reading), so a test that writes with one and reads with the other checks both.
 * Never imported by production code.
 *
 * - `readZip` reads the STORE entries through the CENTRAL DIRECTORY (as a real unzipper does), cross-checks each local header
 *   against it, checks every CRC-32 and size, and refuses anything this export never produces (compression, data descriptors,
 *   extra fields, comments, ZIP64, gaps between entries, bytes after the end record).
 * - `parseXml` is a STRICT parser of the XML subset a worksheet uses: one root, matching tags, double-quoted attributes, no
 *   duplicate attribute, only the five predefined entities and valid numeric references, no comment, CDATA, DOCTYPE or
 *   processing instruction other than the leading declaration, and only characters XML 1.0 allows. Anything else throws.
 * - `readWorkbook` follows the relationships from the package root to the sheet and returns its cells with their types, the
 *   shared strings resolved and the style facts a test cares about (number format, quote prefix).
 */

// ─── ZIP ─────────────────────────────────────────────────────────────────────

export interface ReadZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc32: number;
  readonly flags: number;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly localOffset: number;
}

let table: Uint32Array | undefined;
/** Bitwise CRC-32, deliberately not the writer's implementation. */
export function referenceCrc32(bytes: Uint8Array): number {
  if (table === undefined) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = ~0;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

export function readZip(bytes: Uint8Array): ReadZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message: string): never => {
    throw new Error(`invalid ZIP: ${message}`);
  };
  if (bytes.length < 22) fail("shorter than an end record");
  // This writer never writes a comment, so the end record is the last 22 bytes; a reader of arbitrary files would scan back.
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) fail("no end-of-central-directory record in the last 22 bytes");
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail("a multi-disk archive");
  const count = view.getUint16(end + 8, true);
  if (view.getUint16(end + 10, true) !== count) fail("entry counts differ");
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 20, true) !== 0) fail("an archive comment");
  if (directoryStart + directorySize !== end) fail("the central directory does not end where the end record starts");

  const entries: ReadZipEntry[] = [];
  let at = directoryStart;
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) fail(`central header ${i} has a wrong signature`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const dosTime = view.getUint16(at + 12, true);
    const dosDate = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    if (method !== 0) fail(`entry ${i} is not STORED`);
    if (compressed !== size) fail(`entry ${i}: STORE sizes differ`);
    if ((flags & 0x0008) !== 0) fail(`entry ${i} uses a data descriptor`);
    if (extraLength !== 0 || commentLength !== 0) fail(`entry ${i} has an extra field or a comment`);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // The local header must agree with the directory, and entries follow one another with no gap.
    if (localOffset !== expectedLocal) fail(`entry ${i} does not start where the previous one ended`);
    if (view.getUint32(localOffset, true) !== 0x04034b50) fail(`local header ${i} has a wrong signature`);
    if (
      view.getUint16(localOffset + 6, true) !== flags ||
      view.getUint16(localOffset + 8, true) !== method ||
      view.getUint16(localOffset + 10, true) !== dosTime ||
      view.getUint16(localOffset + 12, true) !== dosDate ||
      view.getUint32(localOffset + 14, true) !== crc ||
      view.getUint32(localOffset + 18, true) !== compressed ||
      view.getUint32(localOffset + 22, true) !== size ||
      view.getUint16(localOffset + 26, true) !== nameLength ||
      view.getUint16(localOffset + 28, true) !== 0
    ) {
      fail(`local header ${i} disagrees with the central directory`);
    }
    const dataStart = localOffset + 30 + nameLength;
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(localOffset + 30, dataStart));
    if (localName !== name) fail(`local name ${i} differs`);
    const data = bytes.slice(dataStart, dataStart + size);
    if (data.length !== size) fail(`entry ${i} is cut short`);
    if (referenceCrc32(data) !== crc) fail(`entry ${name}: CRC-32 mismatch`);
    expectedLocal = dataStart + size;
    entries.push({ name, data, crc32: crc, flags, method, dosTime, dosDate, localOffset });
    at += 46 + nameLength;
  }
  if (at !== end) fail("trailing bytes in the central directory");
  if (expectedLocal !== directoryStart) fail("bytes between the last entry and the central directory");
  if (new Set(entries.map((e) => e.name)).size !== entries.length) fail("duplicate entry names");
  return entries;
}

// ─── XML ─────────────────────────────────────────────────────────────────────

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The character data directly inside the element, in order, entities decoded. */
  readonly text: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function checkChars(text: string, where: string): void {
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    if (!ok) throw new Error(`invalid XML: character U+${cp.toString(16)} in ${where}`);
    i += cp > 0xffff ? 2 : 1;
  }
}

function decodeEntities(raw: string, where: string): string {
  return raw.replace(/&([^;&<]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) throw new Error(`invalid XML: an unterminated reference in ${where}`);
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(body);
    if (!numeric) throw new Error(`invalid XML: unknown reference &${body}; in ${where}`);
    const cp = numeric[1] !== undefined ? parseInt(numeric[1], 16) : parseInt(numeric[2]!, 10);
    const decoded = String.fromCodePoint(cp);
    checkChars(decoded, where);
    return decoded;
  });
}

export function parseXml(source: string): XmlElement {
  checkChars(source, "the document");
  let i = 0;
  const fail = (message: string): never => {
    throw new Error(`invalid XML at ${i}: ${message}`);
  };
  if (source.startsWith("﻿")) fail("a byte-order mark");
  const declaration = /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\r?\n?/.exec(source);
  if (declaration) i = declaration[0].length;

  interface Open {
    name: string;
    attributes: Record<string, string>;
    children: XmlElement[];
    text: string;
  }
  const stack: Open[] = [];
  let root: XmlElement | undefined;

  const close = (open: Open): void => {
    const element: XmlElement = { name: open.name, attributes: open.attributes, children: open.children, text: open.text };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root === undefined) root = element;
    else fail("more than one root element");
  };

  while (i < source.length) {
    if (source[i] !== "<") {
      const next = source.indexOf("<", i);
      const chunk = source.slice(i, next === -1 ? source.length : next);
      if (stack.length === 0) {
        if (chunk.trim() !== "") fail("text outside the root element");
      } else stack[stack.length - 1]!.text += decodeEntities(chunk, "text");
      i += chunk.length;
      continue;
    }
    if (source.startsWith("<!--", i) || source.startsWith("<![CDATA[", i) || source.startsWith("<!", i) || source.startsWith("<?", i)) {
      fail("a comment, CDATA, DOCTYPE or processing instruction");
    }
    if (source[i + 1] === "/") {
      const end = source.indexOf(">", i);
      if (end === -1) fail("an unterminated end tag");
      const name = source.slice(i + 2, end);
      const open = stack.pop();
      if (!open || open.name !== name) fail(`end tag </${name}> does not match`);
      close(open!);
      i = end + 1;
      continue;
    }
    // A start tag.
    const match = /^<([^\s/>=]+)((?:\s+[^\s/>=]+\s*=\s*"[^"<]*")*)\s*(\/?)>/.exec(source.slice(i, source.indexOf(">", i) + 1));
    if (!match) fail("a malformed start tag");
    const [whole, name, rawAttributes, selfClosing] = match!;
    if (!NAME.test(name!)) fail(`a bad element name ${name}`);
    const attributes: Record<string, string> = {};
    for (const attribute of rawAttributes!.matchAll(/\s+([^\s/>=]+)\s*=\s*"([^"<]*)"/g)) {
      const key = attribute[1]!;
      if (!NAME.test(key)) fail(`a bad attribute name ${key}`);
      if (key in attributes) fail(`duplicate attribute ${key}`);
      attributes[key] = decodeEntities(attribute[2]!, `attribute ${key}`);
    }
    const open: Open = { name: name!, attributes, children: [], text: "" };
    i += whole!.length;
    if (selfClosing === "/") close(open);
    else stack.push(open);
  }
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]!.name}>`);
  if (root === undefined) fail("no root element");
  return root!;
}

const childrenNamed = (element: XmlElement, name: string): XmlElement[] => element.children.filter((child) => child.name === name);
const only = (element: XmlElement, name: string): XmlElement => {
  const found = childrenNamed(element, name);
  if (found.length !== 1) throw new Error(`expected exactly one <${name}> in <${element.name}>, found ${found.length}`);
  return found[0]!;
};

// ─── The workbook ────────────────────────────────────────────────────────────

export interface ReadStyle {
  readonly numFmtId: number;
  /** The format code: the custom one, or the built-in's well-known code (0, 2, 49). */
  readonly formatCode: string | null;
  readonly quotePrefix: boolean;
  readonly bold: boolean;
}

export type ReadCell =
  | { readonly type: "string"; readonly ref: string; readonly value: string; readonly style: ReadStyle }
  | { readonly type: "number"; readonly ref: string; readonly value: string; readonly style: ReadStyle }
  | { readonly type: "empty"; readonly ref: string; readonly style: ReadStyle };

export interface ReadWorkbook {
  readonly entryNames: readonly string[];
  readonly sheetNames: readonly string[];
  /** Rows of the (only) sheet; each is its cells in column order. */
  readonly rows: readonly (readonly ReadCell[])[];
  readonly dimension: string;
  readonly columnWidths: readonly number[];
  /** Every part, as text, for tests that scan the raw XML. */
  readonly parts: Readonly<Record<string, string>>;
}

const BUILT_IN_FORMATS: Record<number, string> = { 0: "General", 2: "0.00", 49: "@" };

function resolveTarget(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${base}${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/** Reads a workbook the way a consumer would: through the package relationships, never by assuming a part's name. */
export function readWorkbook(bytes: Uint8Array): ReadWorkbook {
  const entries = readZip(bytes);
  const parts: Record<string, string> = {};
  for (const entry of entries) parts[entry.name] = new TextDecoder("utf-8", { fatal: true }).decode(entry.data);
  const part = (name: string): string => {
    const text = parts[name];
    if (text === undefined) throw new Error(`the workbook has no part ${name}`);
    return text;
  };
  // Every XML part must parse strictly, even the ones this reader does not look into.
  for (const name of Object.keys(parts)) parseXml(parts[name]!);

  const NS_OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
  const rootRels = parseXml(part("_rels/.rels"));
  const workbookRel = childrenNamed(rootRels, "Relationship").find((r) => r.attributes.Type === NS_OFFICE_DOCUMENT);
  if (!workbookRel) throw new Error("no officeDocument relationship");
  const workbookPath = resolveTarget("", workbookRel.attributes.Target!);
  const workbook = parseXml(part(workbookPath));
  const sheets = childrenNamed(only(workbook, "sheets"), "sheet");
  const workbookDir = workbookPath.slice(0, workbookPath.lastIndexOf("/") + 1);
  const relsPath = `${workbookDir}_rels/${workbookPath.slice(workbookPath.lastIndexOf("/") + 1)}.rels`;
  const rels = childrenNamed(parseXml(part(relsPath)), "Relationship");
  const target = (type: string, id?: string): string => {
    const found = rels.filter((r) => r.attributes.Type === `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}` && (id === undefined || r.attributes.Id === id));
    if (found.length !== 1) throw new Error(`expected one ${type} relationship, found ${found.length}`);
    return resolveTarget(workbookDir, found[0]!.attributes.Target!);
  };
  if (sheets.length !== 1) throw new Error(`expected one sheet, found ${sheets.length}`);
  const sheetPath = target("worksheet", sheets[0]!.attributes["r:id"]);

  // Shared strings.
  const sst = parseXml(part(target("sharedStrings")));
  const strings = childrenNamed(sst, "si").map((si) => only(si, "t").text);
  if (Number(sst.attributes.uniqueCount) !== strings.length) throw new Error("sharedStrings uniqueCount is wrong");

  // Styles.
  const styleSheet = parseXml(part(target("styles")));
  const formats = new Map<number, string>(
    childrenNamed(styleSheet.children.find((c) => c.name === "numFmts") ?? { name: "", attributes: {}, children: [], text: "" }, "numFmt").map((f) => [
      Number(f.attributes.numFmtId),
      f.attributes.formatCode!,
    ]),
  );
  const fonts = childrenNamed(only(styleSheet, "fonts"), "font");
  const xfs = childrenNamed(only(styleSheet, "cellXfs"), "xf");
  if (Number(only(styleSheet, "cellXfs").attributes.count) !== xfs.length) throw new Error("cellXfs count is wrong");
  const styles: ReadStyle[] = xfs.map((xf) => {
    const numFmtId = Number(xf.attributes.numFmtId);
    return {
      numFmtId,
      formatCode: formats.get(numFmtId) ?? BUILT_IN_FORMATS[numFmtId] ?? null,
      quotePrefix: xf.attributes.quotePrefix === "1",
      bold: fonts[Number(xf.attributes.fontId)]?.children.some((c) => c.name === "b") ?? false,
    };
  });

  // The sheet.
  const worksheet = parseXml(part(sheetPath));
  const dimension = only(worksheet, "dimension").attributes.ref!;
  const columnWidths = childrenNamed(worksheet.children.find((c) => c.name === "cols") ?? { name: "", attributes: {}, children: [], text: "" }, "col").map((c) =>
    Number(c.attributes.width),
  );
  const sheetData = only(worksheet, "sheetData");
  const rows = childrenNamed(sheetData, "row").map((row, rowIndex) => {
    if (Number(row.attributes.r) !== rowIndex + 1) throw new Error(`row ${rowIndex + 1} is numbered ${row.attributes.r}`);
    return row.children.map((c, columnIndex): ReadCell => {
      if (c.name !== "c") throw new Error(`unexpected <${c.name}> in a row`);
      const ref = c.attributes.r!;
      const letters = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!letters || Number(letters[2]) !== rowIndex + 1) throw new Error(`cell ${ref} is in row ${rowIndex + 1}`);
      const style = styles[Number(c.attributes.s ?? 0)];
      if (style === undefined) throw new Error(`cell ${ref} names a style that does not exist`);
      const columnNumber = [...letters[1]!].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
      if (columnNumber !== columnIndex + 1) throw new Error(`cell ${ref} is not in column ${columnIndex + 1}`);
      if (c.children.some((child) => child.name !== "v")) throw new Error(`cell ${ref} has a child other than <v> (a formula or an inline string)`);
      const v = c.children.find((child) => child.name === "v");
      const t = c.attributes.t;
      if (v === undefined) return { type: "empty", ref, style };
      if (t === "s") {
        const index = Number(v.text);
        const value = strings[index];
        if (!Number.isInteger(index) || value === undefined) throw new Error(`cell ${ref} points at shared string ${v.text}`);
        return { type: "string", ref, value, style };
      }
      if (t !== undefined && t !== "n") throw new Error(`cell ${ref} has the unexpected type ${t}`);
      return { type: "number", ref, value: v.text, style };
    });
  });
  return { entryNames: entries.map((e) => e.name), sheetNames: sheets.map((s) => s.attributes.name!), rows, dimension, columnWidths, parts };
}

/** A row's values the way `golden.cells.json` lists them: text as a string, a number as `{ n: "<text>" }`, an empty cell as `null`. */
export function cellValues(row: readonly ReadCell[]): (string | { n: string } | null)[] {
  return row.map((cell) => (cell.type === "string" ? cell.value : cell.type === "number" ? { n: cell.value } : null));
}
