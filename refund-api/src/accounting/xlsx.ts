/**
 * A tiny, pure, deterministic XLSX (OOXML) writer: mechanism only, it knows nothing of accounting
 * (T62, specs/20261119-accounting; SO-7, SO-10 of specs/20261118-refund-accounting-export/plan.md § "Accounting sign-off
 * delta"; ADR 20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-
 * and-format-version, amendment 2026-11-19 points 2 and 3).
 *
 * What it writes: ONE worksheet, the parts `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
 * `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml`, `xl/styles.xml` and `xl/sharedStrings.xml`, packed in a ZIP.
 * No theme, no `docProps` (so no author and no timestamp), no table object, no defined name, no calculation chain.
 *
 * Deterministic, byte for byte (AC-6.8: the export log's SHA-256 is a real fingerprint):
 * - the entries are in a fixed order, STORED (method 0, no compression, so no compressor version can change the bytes),
 *   every one dated 1980-01-01 00:00 (the DOS epoch), with the UTF-8 name flag, no extra field, no comment, no data
 *   descriptor, a CRC-32 per entry (`zlib.crc32`, or a table fallback if the runtime lacks it);
 * - shared strings are numbered in order of first use, so the same cells always give the same table;
 * - nothing reads the clock, a locale, a random source or the environment.
 *
 * Why it is safe to feed it text that came from a person (AC-6.15):
 * - text reaches the file ONLY as a shared string (`t="s"`), XML-escaped. There is NO code path that writes `<f>`, an inline
 *   string or a formula: a cell is `text`, `number` or `empty`, and nothing else exists. A `number` cell is checked against a
 *   strict decimal lexical form, so it cannot carry markup either;
 * - a text cell must use a style with `quotePrefix`, so a spreadsheet keeps `=...`, `+...`, `-...` or `@...` as text even
 *   when a person edits the cell (the writer refuses a text cell whose style does not say so);
 * - a character that XML 1.0 cannot carry, and every control character (C0, C1), is REFUSED with a `RangeError`: the caller
 *   (`exportFormat.ts`) turns those into spaces or U+FFFD before it asks for a file, so a value can neither break the XML nor
 *   add, merge or split a row or a column. The writer never rewrites a value silently.
 */

import * as zlib from "node:zlib";

// ─── The model ───────────────────────────────────────────────────────────────

export interface XlsxStyle {
  /** A built-in number-format id (below 164) or a key of {@link XlsxSpec.numFmts}. 0 is General, 2 is `0.00`, 49 is `@`. */
  readonly numFmtId: number;
  readonly bold?: boolean;
  /** Required of every style a `text` cell uses. */
  readonly quotePrefix?: boolean;
  readonly horizontal?: "left" | "center" | "right";
}

export type XlsxCell =
  /** A shared string. The only way text enters the file. */
  | { readonly kind: "text"; readonly value: string; readonly style: number }
  /** A number, as its exact decimal text (`9.62`, `5832`, `46083`); never a float formatted by the writer. */
  | { readonly kind: "number"; readonly value: string; readonly style: number }
  /** No value, only the column's style. */
  | { readonly kind: "empty"; readonly style: number };

export interface XlsxSpec {
  /** At most 31 characters, none of `[ ] : * ? / \`. */
  readonly sheetName: string;
  /** Custom number formats by id (164 and up), e.g. `{ 164: "yyyy\\-mm\\-dd;@" }`. */
  readonly numFmts: Readonly<Record<number, string>>;
  /** `cellXfs`: a cell names its style by index. Index 0 is the default style and is required. */
  readonly styles: readonly XlsxStyle[];
  /** Column widths in characters, from column A. */
  readonly columnWidths: readonly number[];
  /** Row 1 first. A row may be shorter than the widest; it is not padded. */
  readonly rows: readonly (readonly XlsxCell[])[];
}

// ─── CRC-32 ──────────────────────────────────────────────────────────────────

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3, as ZIP uses), table-driven: the fallback of {@link crc32} and its cross-check in the tests. */
export function crc32Table(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `zlib.crc32` where the runtime has it (Node 22.2+, Bun), else the table. Always an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
  return typeof native === "function" ? native(bytes) >>> 0 : crc32Table(bytes);
}

// ─── ZIP (STORE) ─────────────────────────────────────────────────────────────

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const encoder = new TextEncoder();
/** 1980-01-01 00:00:00 in MS-DOS time and date fields. */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

/** A ZIP of the entries in the order given, all STORED, all dated 1980-01-01 00:00. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError("too many entries for a ZIP without ZIP64");
  const names = entries.map((entry) => encoder.encode(entry.name));
  const crcs = entries.map((entry) => crc32(entry.data));
  let size = 22;
  entries.forEach((entry, i) => {
    size += 30 + names[i]!.length + entry.data.length + 46 + names[i]!.length;
  });
  if (size > 0xffffffff) throw new RangeError("archive too large for a ZIP without ZIP64");

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number) => {
    view.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const put = (bytes: Uint8Array) => {
    out.set(bytes, at);
    at += bytes.length;
  };

  const offsets: number[] = [];
  entries.forEach((entry, i) => {
    offsets.push(at);
    u32(0x04034b50);
    u16(VERSION);
    u16(FLAG_UTF8);
    u16(0); // STORE
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(crcs[i]!);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(names[i]!.length);
    u16(0); // no extra field
    put(names[i]!);
    put(entry.data);
  });

  const directoryStart = at;
  entries.forEach((entry, i) => {
    u32(0x02014b50);
    u16(VERSION); // made by: DOS/FAT, 2.0
    u16(VERSION); // needed
    u16(FLAG_UTF8);
    u16(0);
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(crcs[i]!);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(names[i]!.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]!);
    put(names[i]!);
  });
  const directorySize = at - directoryStart;

  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(directorySize);
  u32(directoryStart);
  u16(0); // no archive comment
  return out;
}

// ─── XML ─────────────────────────────────────────────────────────────────────

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";

/** Throws unless every character is one XML 1.0 can carry AND is not a control character; then escapes `& < > " '`. */
export function escapeXml(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const xmlValid = (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    if (!xmlValid || control) {
      throw new RangeError(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} cannot be written to a worksheet: sanitise the text first`);
    }
    switch (cp) {
      case 0x26:
        out += "&amp;";
        break;
      case 0x3c:
        out += "&lt;";
        break;
      case 0x3e:
        out += "&gt;";
        break;
      case 0x22:
        out += "&quot;";
        break;
      case 0x27:
        out += "&apos;";
        break;
      default:
        out += value.slice(i, i + width);
    }
    i += width;
  }
  return out;
}

/** `0` -> `A`, `7` -> `H`, `26` -> `AA`. */
export function columnLetters(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 16383) throw new RangeError(`column index out of range: ${String(index)}`);
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** An exact decimal: optional minus, no leading zeros, an optional fraction. Anything else is refused, never repaired. */
const NUMBER_LEXICAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/;

function validate(spec: XlsxSpec): void {
  if (spec.sheetName.length === 0 || spec.sheetName.length > 31 || SHEET_NAME_FORBIDDEN.test(spec.sheetName)) {
    throw new RangeError(`not a valid sheet name: ${JSON.stringify(spec.sheetName)}`);
  }
  if (spec.styles.length === 0) throw new RangeError("the default style (index 0) is required");
  for (const style of spec.styles) {
    if (style.numFmtId >= 164 && spec.numFmts[style.numFmtId] === undefined) {
      throw new RangeError(`number format ${style.numFmtId} is not defined`);
    }
    if (!Number.isInteger(style.numFmtId) || style.numFmtId < 0) throw new RangeError("a number-format id is a non-negative integer");
  }
  for (const width of spec.columnWidths) {
    if (!(width > 0 && width <= 255)) throw new RangeError(`column width out of range: ${String(width)}`);
  }
  if (spec.rows.length > 1_048_576) throw new RangeError("more rows than a worksheet holds");
}

function stylesXml(spec: XlsxSpec): string {
  const customFormats = Object.entries(spec.numFmts)
    .map(([id, code]) => [Number(id), code] as const)
    .sort((a, b) => a[0] - b[0]);
  for (const [id] of customFormats) {
    if (!Number.isInteger(id) || id < 164) throw new RangeError(`a custom number format starts at 164, got ${id}`);
  }
  const numFmts =
    customFormats.length === 0
      ? ""
      : `<numFmts count="${customFormats.length}">${customFormats
          .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
          .join("")}</numFmts>`;
  const fonts =
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>';
  const fills = '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>';
  const borders = '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>';
  const cellStyleXfs = '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
  const xfs = spec.styles
    .map((style) => {
      const attributes =
        `numFmtId="${style.numFmtId}" fontId="${style.bold === true ? 1 : 0}" fillId="0" borderId="0" xfId="0"` +
        (style.numFmtId !== 0 ? ' applyNumberFormat="1"' : "") +
        (style.bold === true ? ' applyFont="1"' : "") +
        (style.horizontal !== undefined ? ' applyAlignment="1"' : "") +
        (style.quotePrefix === true ? ' quotePrefix="1"' : "");
      return style.horizontal !== undefined
        ? `<xf ${attributes}><alignment horizontal="${style.horizontal}"/></xf>`
        : `<xf ${attributes}/>`;
    })
    .join("");
  return (
    XML_DECLARATION +
    `<styleSheet xmlns="${NS_MAIN}">${numFmts}${fonts}${fills}${borders}${cellStyleXfs}` +
    `<cellXfs count="${spec.styles.length}">${xfs}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  );
}

interface Rendered {
  readonly sheet: string;
  readonly sharedStrings: string;
}

function renderSheet(spec: XlsxSpec): Rendered {
  const stringIndex = new Map<string, number>();
  const strings: string[] = [];
  let references = 0;
  const textIndex = (value: string): number => {
    references++;
    let index = stringIndex.get(value);
    if (index === undefined) {
      index = strings.length;
      stringIndex.set(value, index);
      strings.push(value);
    }
    return index;
  };

  let widest = 0;
  const rows = spec.rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      widest = Math.max(widest, cells.length);
      const rendered = cells
        .map((cell, columnIndex) => {
          const ref = `${columnLetters(columnIndex)}${r}`;
          const style = spec.styles[cell.style];
          if (style === undefined) throw new RangeError(`cell ${ref} names style ${cell.style}, which does not exist`);
          switch (cell.kind) {
            case "text":
              if (style.quotePrefix !== true) throw new RangeError(`text cell ${ref} must use a style with quotePrefix`);
              return `<c r="${ref}" s="${cell.style}" t="s"><v>${textIndex(cell.value)}</v></c>`;
            case "number":
              if (!NUMBER_LEXICAL.test(cell.value)) throw new RangeError(`cell ${ref}: not an exact decimal: ${JSON.stringify(cell.value)}`);
              return `<c r="${ref}" s="${cell.style}"><v>${cell.value}</v></c>`;
            case "empty":
              return `<c r="${ref}" s="${cell.style}"/>`;
          }
        })
        .join("");
      return `<row r="${r}">${rendered}</row>`;
    })
    .join("");

  const lastCell = `${columnLetters(Math.max(widest, 1) - 1)}${Math.max(spec.rows.length, 1)}`;
  const cols =
    spec.columnWidths.length === 0
      ? ""
      : `<cols>${spec.columnWidths
          .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
          .join("")}</cols>`;
  const sheet =
    XML_DECLARATION +
    `<worksheet xmlns="${NS_MAIN}"><dimension ref="A1:${lastCell}"/>` +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `${cols}<sheetData>${rows}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';

  const items = strings
    .map((value) => {
      const text = escapeXml(value);
      return value.startsWith(" ") || value.endsWith(" ") ? `<si><t xml:space="preserve">${text}</t></si>` : `<si><t>${text}</t></si>`;
    })
    .join("");
  const sharedStrings =
    XML_DECLARATION + `<sst xmlns="${NS_MAIN}" count="${references}" uniqueCount="${strings.length}">${items}</sst>`;
  return { sheet, sharedStrings };
}

/** The workbook, as the bytes of an `.xlsx` file. The same spec always gives the same bytes. */
export function writeXlsx(spec: XlsxSpec): Uint8Array {
  validate(spec);
  const { sheet, sharedStrings } = renderSheet(spec);
  const parts: [string, string][] = [
    [
      "[Content_Types].xml",
      XML_DECLARATION +
        `<Types xmlns="${NS_CONTENT_TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      XML_DECLARATION +
        `<Relationships xmlns="${NS_PACKAGE_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      XML_DECLARATION +
        `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr/><bookViews><workbookView/></bookViews>` +
        `<sheets><sheet name="${escapeXml(spec.sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      XML_DECLARATION +
        `<Relationships xmlns="${NS_PACKAGE_REL}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId3" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ["xl/worksheets/sheet1.xml", sheet],
    ["xl/styles.xml", stylesXml(spec)],
    ["xl/sharedStrings.xml", sharedStrings],
  ];
  return zipStore(parts.map(([name, text]) => ({ name, data: encoder.encode(text) })));
}
