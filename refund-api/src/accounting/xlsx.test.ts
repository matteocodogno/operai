/**
 * Unit tests of the OOXML + STORE-zip writer (T62, specs/20261119-accounting; SO-7, SO-10; AC-6.8, AC-6.15, 20261118).
 * Everything is read back with `test-support/xlsxReader.ts`, which shares no code with the writer (its own CRC-32, ZIP and
 * strict XML parser), so a test that writes with one and reads with the other checks both.
 */

import { describe, expect, it } from "bun:test";
import { readWorkbook, readZip, referenceCrc32, parseXml } from "../test-support/xlsxReader";
import { columnLetters, crc32, crc32Table, escapeXml, writeXlsx, zipStore, type XlsxCell, type XlsxSpec, type XlsxStyle } from "./xlsx";

const STYLES: readonly XlsxStyle[] = [
  { numFmtId: 0 },
  { numFmtId: 49, quotePrefix: true },
  { numFmtId: 164 },
  { numFmtId: 2 },
  { numFmtId: 49, bold: true, quotePrefix: true, horizontal: "center" },
];
const text = (value: string, style = 1): XlsxCell => ({ kind: "text", value, style });
const num = (value: string, style = 0): XlsxCell => ({ kind: "number", value, style });
const empty = (style = 0): XlsxCell => ({ kind: "empty", style });
const spec = (rows: XlsxCell[][], patch: Partial<XlsxSpec> = {}): XlsxSpec => ({
  sheetName: "Sheet 1",
  numFmts: { 164: "yyyy\\-mm\\-dd;@" },
  styles: STYLES,
  columnWidths: [12, 40],
  rows,
  ...patch,
});
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe("CRC-32", () => {
  it("matches the check value of the standard and the independent implementation", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc32(check)).toBe(0xcbf43926);
    expect(crc32Table(check)).toBe(0xcbf43926);
    expect(referenceCrc32(check)).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("the runtime's crc32 and the table fallback agree, and the result is always unsigned", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 40; round++) {
      const bytes = new Uint8Array(next() % 3000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
      const expected = referenceCrc32(bytes);
      expect(crc32Table(bytes)).toBe(expected);
      expect(crc32(bytes)).toBe(expected);
      expect(expected).toBeGreaterThanOrEqual(0);
    }
    expect(crc32Table(new Uint8Array(1000).fill(0xff))).toBeGreaterThan(0x7fffffff - 1); // a value above 2^31 stays positive
  });
});

describe("the ZIP container (SO-7)", () => {
  const entries = [
    { name: "a.txt", data: new TextEncoder().encode("alpha") },
    { name: "dir/b é.xml", data: new TextEncoder().encode("<b/>") },
    { name: "empty", data: new Uint8Array() },
  ];

  it("is STORE, in the order given, every entry dated 1980-01-01 00:00 with the UTF-8 flag, no extra field and no comment", () => {
    const zip = zipStore(entries);
    const read = readZip(zip);
    expect(read.map((e) => e.name)).toEqual(["a.txt", "dir/b é.xml", "empty"]);
    expect(read.map((e) => new TextDecoder().decode(e.data))).toEqual(["alpha", "<b/>", ""]);
    for (const entry of read) {
      expect([entry.method, entry.flags, entry.dosTime, entry.dosDate]).toEqual([0, 0x0800, 0, (0 << 9) | (1 << 5) | 1]);
    }
  });

  it("is the same bytes every time, and its CRCs are those of the data", () => {
    expect(same(zipStore(entries), zipStore(entries))).toBe(true);
    for (const entry of readZip(zipStore(entries))) expect(entry.crc32).toBe(referenceCrc32(entry.data));
  });

  it("the reader refuses a corrupted entry, a bad CRC and trailing bytes (so the tests that lean on it mean something)", () => {
    const zip = zipStore(entries);
    const damaged = zip.slice();
    damaged[36] = (damaged[36]! ^ 0xff) & 0xff; // inside the first entry's data (30 header bytes + 5 name bytes, then 'alpha')
    expect(() => readZip(damaged)).toThrow(/CRC-32/);
    expect(() => readZip(new Uint8Array([...zip, 0]))).toThrow();
    expect(() => readZip(zip.slice(0, zip.length - 3))).toThrow();
  });
});

describe("the workbook parts (SO-7, SO-8)", () => {
  const book = writeXlsx(spec([[text("Date", 4), text("Description", 4)], [num("46083", 2), text("Cancelleria")]]));

  it("has exactly the seven parts, in a fixed order, and no docProps, theme or table (no author, no timestamp)", () => {
    const names = readZip(book).map((e) => e.name);
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ]);
    expect(names.some((n) => n.startsWith("docProps") || n.includes("theme") || n.includes("table"))).toBe(false);
  });

  it("every XML part parses strictly, and the workbook reads back through its relationships", () => {
    const read = readWorkbook(book);
    expect(read.sheetNames).toEqual(["Sheet 1"]);
    expect(read.dimension).toBe("A1:B2");
    expect(read.columnWidths).toEqual([12, 40]);
    expect(read.rows.map((row) => row.map((c) => c.type))).toEqual([
      ["string", "string"],
      ["number", "string"],
    ]);
    const date = read.rows[1]![0]!;
    expect(date.type === "number" && date.value).toBe("46083");
    expect(date.style.formatCode).toBe("yyyy\\-mm\\-dd;@");
  });

  it("numbers are `<v>` with no type, text is a shared string, an empty cell has no value", () => {
    const sheet = readWorkbook(writeXlsx(spec([[text("a"), num("5832"), empty(1)]]))).parts["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('<c r="A1" s="1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="B1" s="0"><v>5832</v></c>');
    expect(sheet).toContain('<c r="C1" s="1"/>');
  });

  it("shared strings are numbered by first use, deduplicated, and counted", () => {
    const read = readWorkbook(writeXlsx(spec([[text("CHF"), text("x")], [text("CHF"), text("CHF")]])));
    const sst = read.parts["xl/sharedStrings.xml"]!;
    expect(sst).toContain('count="4" uniqueCount="2"');
    expect(sst.indexOf("<t>CHF</t>")).toBeLessThan(sst.indexOf("<t>x</t>"));
    expect(read.rows.map((r) => r.map((c) => (c.type === "string" ? c.value : null)))).toEqual([
      ["CHF", "x"],
      ["CHF", "CHF"],
    ]);
  });

  it("a string with a leading or trailing space keeps it (xml:space), an inner space is left alone", () => {
    const read = readWorkbook(writeXlsx(spec([[text(" lead"), text("trail "), text("in ner")]])));
    expect(read.parts["xl/sharedStrings.xml"]).toContain('<t xml:space="preserve"> lead</t>');
    expect(read.rows[0]!.map((c) => (c.type === "string" ? c.value : null))).toEqual([" lead", "trail ", "in ner"]);
  });

  it("styles: the custom date format, built-in ids, bold, alignment, and quotePrefix exactly where asked", () => {
    const read = readWorkbook(book);
    const styles = read.parts["xl/styles.xml"]!;
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd;@"/>');
    expect(styles).toContain('<cellXfs count="5">');
    const header = read.rows[0]![0]!.style;
    expect([header.numFmtId, header.quotePrefix, header.bold]).toEqual([49, true, true]);
    expect(read.rows[1]![0]!.style.quotePrefix).toBe(false);
  });

  it("a header-only sheet and a sheet with no row at all are valid", () => {
    expect(readWorkbook(writeXlsx(spec([[text("Date")]]))).dimension).toBe("A1:A1");
    const none = readWorkbook(writeXlsx(spec([])));
    expect(none.rows).toEqual([]);
    expect(none.dimension).toBe("A1:A1");
  });

  it("is the same bytes for the same cells, and different bytes for different cells", () => {
    const rows = [[text("a"), num("1.50")], [text("b"), num("2")]];
    expect(same(writeXlsx(spec(rows)), writeXlsx(spec(rows)))).toBe(true);
    expect(same(writeXlsx(spec(rows)), writeXlsx(spec([[text("a"), num("1.51")], [text("b"), num("2")]])))).toBe(false);
  });
});

describe("text can never become markup or a formula (AC-6.15, SO-10)", () => {
  const HOSTILE = [
    "=SUM(A1)",
    "+1+1",
    "-2",
    "@SUM(1)",
    '=HYPERLINK("http://example.test","x")',
    "</t></si><si><t>injected",
    "]]><f>1</f>",
    '"><script>alert(1)</script>',
    "a & b < c > d \" e ' f",
    "&amp; &#60; &lt;",
    "\u{1F600} é 中文 ～",
  ];

  it("round-trips every hostile string exactly, as a shared string, in its own cell", () => {
    const read = readWorkbook(writeXlsx(spec([HOSTILE.map((value) => text(value))])));
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.map((c) => (c.type === "string" ? c.value : `NOT TEXT: ${c.type}`))).toEqual(HOSTILE);
    expect(read.rows[0]!.every((c) => c.style.quotePrefix)).toBe(true);
  });

  it("no part of any workbook holds `<f`, and no cell is an inline string or has a child other than <v>", () => {
    const book = writeXlsx(spec([HOSTILE.map((value) => text(value)), [num("1"), num("-2.5"), empty()]]));
    for (const entry of readZip(book)) {
      const xml = new TextDecoder().decode(entry.data);
      // The formula element `<f>` or `<f ...>`, in any part. (`<fonts>` and `<fills>` of styles.xml start with `<f` too.)
      expect(xml).not.toMatch(/<f[\s>/]/);
      expect(xml).not.toContain("inlineStr");
      // The parts that carry cells and text hold no `<f` at all.
      if (/sheet1|sharedStrings/.test(entry.name)) expect(xml).not.toContain("<f");
    }
    expect(() => readWorkbook(book)).not.toThrow(); // the reader refuses any <c> child other than <v>
  });

  it("escapes the five XML characters and nothing else", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
    expect(escapeXml("plain é 中 \u{1F600}")).toBe("plain é 中 \u{1F600}");
  });

  it("refuses every control character, a lone surrogate and the two non-characters instead of writing or repairing them", () => {
    const bad = [
      ...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)), // C0, TAB, LF and CR included
      "\u007f",
      ...Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(0x7f + i)), // DEL and C1
      "\ud800",
      "\udfff",
      "a\ud83d",
      "\ude00b",
      "\ufffe",
      "\uffff",
    ];
    for (const value of bad) {
      expect(() => writeXlsx(spec([[text(`x${value}y`)]]))).toThrow(RangeError);
    }
    // The sheet name goes through the same escape.
    expect(() => writeXlsx(spec([], { sheetName: "a\u0001b" }))).toThrow(RangeError);
    expect(() => escapeXml("\u2028")).not.toThrow(); // the writer is not the sanitiser: U+2028 is legal XML (exportFormat turns it into a space)
  });

  it("a text cell whose style has no quotePrefix is refused, and so is a style that does not exist", () => {
    expect(() => writeXlsx(spec([[text("x", 0)]]))).toThrow(/quotePrefix/);
    expect(() => writeXlsx(spec([[text("x", 2)]]))).toThrow(/quotePrefix/);
    expect(() => writeXlsx(spec([[text("x", 99)]]))).toThrow(/style 99/);
    expect(() => writeXlsx(spec([[num("1", 99)]]))).toThrow(/style 99/);
  });

  it("a number cell holds an exact decimal and nothing else", () => {
    for (const ok of ["0", "5832", "46083", "9.62", "0.00", "2620.1", "-3", "123456789012345.5"]) {
      expect(() => writeXlsx(spec([[num(ok)]]))).not.toThrow();
    }
    for (const bad of ["", " 1", "1 ", "1e3", "1E3", "0x10", "01", "1.", ".5", "+1", "--1", "1,5", "NaN", "Infinity", "=1+1", "1</v>", "1.2.3", "\u0663"]) {
      expect(() => writeXlsx(spec([[num(bad)]]))).toThrow(RangeError);
    }
  });
});

describe("validation", () => {
  it("sheet names", () => {
    for (const bad of ["", "x".repeat(32), "a[b", "a]b", "a:b", "a*b", "a?b", "a/b", "a\\b"]) {
      expect(() => writeXlsx(spec([], { sheetName: bad }))).toThrow(RangeError);
    }
    expect(readWorkbook(writeXlsx(spec([], { sheetName: "Sheet 1" }))).sheetNames).toEqual(["Sheet 1"]);
    expect(readWorkbook(writeXlsx(spec([], { sheetName: "A & B" }))).sheetNames).toEqual(["A & B"]);
  });

  it("styles, number formats and widths", () => {
    expect(() => writeXlsx(spec([], { styles: [] }))).toThrow(RangeError);
    expect(() => writeXlsx(spec([], { styles: [{ numFmtId: 170 }] }))).toThrow(/not defined/);
    expect(() => writeXlsx(spec([], { numFmts: { 5: "0" } }))).toThrow(/164/);
    expect(() => writeXlsx(spec([], { columnWidths: [0] }))).toThrow(RangeError);
    expect(() => writeXlsx(spec([], { columnWidths: [300] }))).toThrow(RangeError);
  });

  it("column letters", () => {
    expect([0, 7, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLetters)).toEqual(["A", "H", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA", "XFD"]);
    expect(() => columnLetters(-1)).toThrow(RangeError);
    expect(() => columnLetters(16384)).toThrow(RangeError);
    expect(() => columnLetters(1.5)).toThrow(RangeError);
  });

  it("a row wider than the sheet's widths and a big sheet are fine", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [text(`row ${i}`), num(String(i)), empty(1), text("CHF")]);
    const read = readWorkbook(writeXlsx(spec(rows)));
    expect(read.rows).toHaveLength(500);
    expect(read.dimension).toBe("A1:D500");
    expect(read.rows[499]![0]).toMatchObject({ ref: "A500", value: "row 499" });
  });
});

describe("the reader's XML parser is strict (so 'parses' in the other tests means something)", () => {
  it("accepts well-formed documents", () => {
    const root = parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a x="1"><b>t &amp; &#65;&#x42;</b><c/></a>');
    expect(root.name).toBe("a");
    expect(root.children.map((c) => c.name)).toEqual(["b", "c"]);
    expect(root.children[0]!.text).toBe("t & AB");
  });

  it("refuses malformed ones", () => {
    for (const bad of [
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "<a x=1/>",
      "<a x='1'/>",
      '<a x="1" x="2"/>',
      "<a>&bogus;</a>",
      "<a>a & b</a>",
      "<a>&#0;</a>",
      "<a>&#xD800;</a>",
      "<a><!-- c --></a>",
      "<a><![CDATA[x]]></a>",
      "<!DOCTYPE a><a/>",
      "<a><?pi x?></a>",
      "text<a/>",
      "<a>\u0001</a>",
      "<a>\ufffe</a>",
      '<a x="<"/>',
      "",
    ]) {
      expect(() => parseXml(bad)).toThrow();
    }
  });
});
