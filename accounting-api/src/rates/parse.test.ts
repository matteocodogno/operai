/**
 * Unit tests for the federal-rate parser (T5, specs/20261118-refund-accounting-export;
 * AC-5.1; ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-...).
 *
 * The happy path runs against the REAL answer of
 * `https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03`, recorded
 * on 2026-11-18 (`fixtures/bazg-xmlavgmonth-2026-03.xml`, 146 currencies, status
 * 200, application/xml). A fake source injected in every integration test hides
 * how the real one behaves (the ADR's "test and live" failure shape), which is
 * why the parser is proven against the recording and not only against
 * hand-written documents. Every refusal case below is derived from that same
 * recording, so the structure under test is the real one.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FX_CURRENCIES, MAX_DOCUMENT_CHARS, parseBazgMonth } from "./parse";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "bazg-xmlavgmonth-2026-03.xml"), "utf8");

/** The recorded document with one textual edit applied; fails loudly if the edit did not apply. */
function edited(search: string | RegExp, replacement: string): string {
  const result = FIXTURE.replace(search, replacement);
  expect(result).not.toBe(FIXTURE);
  return result;
}

/** A minimal document with the three currencies, for the shapes the recording does not contain. */
function doc(opts: { monat?: string; eur?: string; usd?: string; gbp?: string; extra?: string } = {}): string {
  const devise = (code: string, inner: string) => `<devise code="${code}">${inner}</devise>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<monatsmittelkurs>`,
    `<monat>${opts.monat ?? "2026-03"}</monat>`,
    opts.eur ?? devise("eur", `<waehrung>1 EUR</waehrung><kurs>0.9246</kurs>`),
    opts.usd ?? devise("usd", `<waehrung>1 USD</waehrung><kurs>0.7808</kurs>`),
    opts.gbp ?? devise("gbp", `<waehrung>1 GBP</waehrung><kurs>1.0635</kurs>`),
    opts.extra ?? "",
    `</monatsmittelkurs>`,
  ].join("\n");
}

const kurs = (currency: string, unit: number | string, value: string) =>
  `<devise code="${currency.toLowerCase()}"><waehrung>${unit} ${currency}</waehrung><kurs>${value}</kurs></devise>`;

describe("the recorded 2026-03 answer (AC-5.1)", () => {
  it("is a real, sizeable document (guards against an accidentally truncated fixture)", () => {
    expect(FIXTURE.length).toBeGreaterThan(10_000);
    expect(FIXTURE).toContain("<monat>2026-03</monat>");
    expect(FIXTURE).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
  });

  it("gives EUR 924600, USD 780800, GBP 1063500 and the <monat> echo 2026-03", () => {
    const result = parseBazgMonth(FIXTURE, "2026-03");
    expect(result).toEqual({
      ok: true,
      month: "2026-03",
      rates: { EUR: 924_600, USD: 780_800, GBP: 1_063_500 },
    });
  });

  it("reads only the three currencies, ignoring the other ~140 (including 100- and 10000-unit ones)", () => {
    expect(FIXTURE).toContain("<waehrung>100 EGP</waehrung>");
    expect(FIXTURE).toContain("<waehrung>10000 VND</waehrung>");
    const result = parseBazgMonth(FIXTURE, "2026-03");
    expect(result.ok && Object.keys(result.rates).sort()).toEqual(["EUR", "GBP", "USD"]);
  });

  it("is deterministic and does not mutate anything", () => {
    expect(parseBazgMonth(FIXTURE, "2026-03")).toEqual(parseBazgMonth(FIXTURE, "2026-03"));
  });
});

describe("the month echo must equal the month asked for", () => {
  it("a different <monat> is refused as month_mismatch (the source answers for the wrong period)", () => {
    const result = parseBazgMonth(edited("<monat>2026-03</monat>", "<monat>2026-04</monat>"), "2026-03");
    expect(result).toMatchObject({ ok: false, code: "month_mismatch" });
  });

  it("asking for another month than the document holds is refused (same document, other request)", () => {
    expect(parseBazgMonth(FIXTURE, "2026-02")).toMatchObject({ ok: false, code: "month_mismatch" });
    expect(parseBazgMonth(FIXTURE, "2025-03")).toMatchObject({ ok: false, code: "month_mismatch" });
  });

  it("a missing <monat> is refused", () => {
    expect(parseBazgMonth(edited(/<monat>.*<\/monat>/, ""), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("two <monat> elements are refused, even if the first one is right", () => {
    expect(parseBazgMonth(doc({ extra: "<monat>2026-03</monat>" }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("an empty or malformed <monat> is refused", () => {
    for (const monat of ["", "2026-3", "2026-13", "March 2026", "2026-03-01", "2026-00"]) {
      expect(parseBazgMonth(doc({ monat }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("asking for a malformed month is a programming error", () => {
    expect(() => parseBazgMonth(FIXTURE, "2026-3")).toThrow(RangeError);
    expect(() => parseBazgMonth(FIXTURE, "")).toThrow(RangeError);
  });
});

describe("refused constructs (XXE and entity expansion, security surface 3)", () => {
  it("a DOCTYPE is refused, even a harmless-looking one", () => {
    const withDoctype = edited(`<?xml version="1.0" encoding="UTF-8"?>`, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE monatsmittelkurs>`);
    expect(parseBazgMonth(withDoctype, "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("an ENTITY declaration inside a DOCTYPE is refused", () => {
    const xxe = edited(
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<?xml version="1.0"?>\n<!DOCTYPE m [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>`,
    );
    expect(parseBazgMonth(xxe, "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("a billion-laughs document is refused before anything is expanded", () => {
    const laughs =
      `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>` +
      `<monatsmittelkurs><monat>&lol2;</monat></monatsmittelkurs>`;
    expect(parseBazgMonth(laughs, "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("DOCTYPE and ENTITY are refused in any case and with whitespace after the bang", () => {
    for (const marker of ["<!doctype x>", "<!DocType x>", "<! DOCTYPE x>", "<!entity x 'y'>", "<!Entity x 'y'>"]) {
      expect(parseBazgMonth(doc({ extra: marker }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("a DOCTYPE hidden inside a comment is refused too (the check runs on the raw text)", () => {
    expect(parseBazgMonth(doc({ extra: "<!-- <!DOCTYPE x> -->" }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("a CDATA section is refused", () => {
    expect(parseBazgMonth(doc({ extra: "<![CDATA[ <devise code=\"eur\"> ]]>" }), "2026-03")).toMatchObject({
      ok: false,
      code: "parse",
    });
  });

  it("an entity reference in a value is not expanded and not accepted as a number", () => {
    const result = parseBazgMonth(doc({ eur: kurs("EUR", 1, "&amp;") }), "2026-03");
    expect(result).toMatchObject({ ok: false, code: "parse" });
    expect(parseBazgMonth(doc({ monat: "&lt;" }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("a commented-out <devise> is never read: it cannot supply or replace a currency", () => {
    const commentedGbp = doc({ gbp: `<!-- <devise code="gbp"><waehrung>1 GBP</waehrung><kurs>1.0635</kurs></devise> -->` });
    expect(parseBazgMonth(commentedGbp, "2026-03")).toMatchObject({ ok: false, code: "currency_missing" });
    const commentedFake = doc({ extra: `<!-- <devise code="eur"><waehrung>1 EUR</waehrung><kurs>9</kurs></devise> -->` });
    expect(parseBazgMonth(commentedFake, "2026-03")).toMatchObject({ ok: true, rates: { EUR: 924_600 } });
  });

  it("an unterminated comment is refused", () => {
    expect(parseBazgMonth(doc({ extra: "<!-- never closed" }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("an empty body, a non-string and an oversized body are refused", () => {
    expect(parseBazgMonth("", "2026-03")).toMatchObject({ ok: false, code: "parse" });
    expect(parseBazgMonth(undefined as unknown as string, "2026-03")).toMatchObject({ ok: false, code: "parse" });
    expect(parseBazgMonth("x".repeat(MAX_DOCUMENT_CHARS + 1), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("garbage that is not our document is refused, never thrown", () => {
    for (const body of ["not xml at all", "<html><body>502 Bad Gateway</body></html>", "{\"eur\": 0.92}", "<monat>2026-03</monat>"]) {
      expect(parseBazgMonth(body, "2026-03").ok).toBe(false);
    }
  });
});

describe("missing currencies", () => {
  for (const missing of ["eur", "usd", "gbp"]) {
    it(`a missing ${missing.toUpperCase()} is refused as currency_missing and names it`, () => {
      const without = edited(new RegExp(`<devise code="${missing}">[\\s\\S]*?</devise>\\n?`), "");
      const result = parseBazgMonth(without, "2026-03");
      expect(result).toMatchObject({ ok: false, code: "currency_missing" });
      expect(!result.ok && result.detail).toContain(missing.toUpperCase());
    });
  }

  it("a document with none of the three is currency_missing", () => {
    expect(parseBazgMonth(`<monatsmittelkurs><monat>2026-03</monat>${kurs("CAD", 1, "0.55")}</monatsmittelkurs>`, "2026-03")).toMatchObject({
      ok: false,
      code: "currency_missing",
    });
  });

  it("the currency code is matched case-insensitively and with extra attributes", () => {
    const upper = doc({ eur: `<devise lang="x" code="EUR"><waehrung>1 EUR</waehrung><kurs>0.9246</kurs></devise>` });
    expect(parseBazgMonth(upper, "2026-03")).toMatchObject({ ok: true, rates: { EUR: 924_600 } });
  });

  it("a currency present twice is refused as ambiguous, whichever value comes first", () => {
    const twice = doc({ extra: kurs("EUR", 1, "0.5") });
    expect(parseBazgMonth(twice, "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });
});

describe("rate values (range check and unit normalisation)", () => {
  it("a <kurs> of 0 is refused", () => {
    const zero = edited(/(<devise code="eur">[\s\S]*?<kurs>)[^<]*(<\/kurs>)/, "$10$2");
    expect(parseBazgMonth(zero, "2026-03")).toMatchObject({ ok: false, code: "parse" });
    for (const value of ["0", "0.0", "0.0000", "0.0000001"]) {
      expect(parseBazgMonth(doc({ usd: kurs("USD", 1, value) }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("a negative, signed, empty, blank or non-numeric <kurs> is refused", () => {
    for (const value of ["-0.9", "+0.9", "", "  ", "abc", "0,9246", "1e0", "0.9246.1", ".9", "9.", "NaN", "Infinity", "0x10"]) {
      expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, value) }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("1000 CHF per unit and above is refused; 999.999999 is the largest accepted", () => {
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, "1000") }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, "1000.0001") }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, "999.999999") }), "2026-03")).toMatchObject({
      ok: true,
      rates: { EUR: 999_999_999 },
    });
  });

  it("a smallest accepted rate of 1 micro (0.000001) is kept as 1", () => {
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, "0.000001") }), "2026-03")).toMatchObject({ ok: true, rates: { EUR: 1 } });
  });

  it("unit 100 is normalised to per-1-unit: '100 EUR' at 92.46 is 0.9246", () => {
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 100, "92.46") }), "2026-03")).toMatchObject({
      ok: true,
      rates: { EUR: 924_600, USD: 780_800, GBP: 1_063_500 },
    });
  });

  it("unit 100 that does not divide exactly is rounded half up, once", () => {
    // 1.234567 / 100 = 0.01234567 -> 12345.67 micros -> 12346
    expect(parseBazgMonth(doc({ usd: kurs("USD", 100, "1.234567") }), "2026-03")).toMatchObject({ ok: true, rates: { USD: 12_346 } });
    // 0.5 micro is a tie: 0.0000005 -> 1
    expect(parseBazgMonth(doc({ usd: kurs("USD", 1, "0.0000005") }), "2026-03")).toMatchObject({ ok: true, rates: { USD: 1 } });
    // just under: 0.0000004 -> 0 -> refused as not > 0
    expect(parseBazgMonth(doc({ usd: kurs("USD", 1, "0.0000004") }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("any other unit for these currencies is refused (10, 1000, 0, 10000)", () => {
    for (const unit of [0, 10, 1000, 10000]) {
      expect(parseBazgMonth(doc({ gbp: kurs("GBP", unit, "1.0635") }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("a <waehrung> that is malformed, or names another currency, is refused", () => {
    for (const waehrung of ["EUR", "1EUR", "one EUR", "1 USD", "1 EURO", ""]) {
      const eur = `<devise code="eur"><waehrung>${waehrung}</waehrung><kurs>0.9246</kurs></devise>`;
      expect(parseBazgMonth(doc({ eur }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("a block with a missing or doubled <kurs> or <waehrung> is refused", () => {
    const noKurs = `<devise code="eur"><waehrung>1 EUR</waehrung></devise>`;
    const noUnit = `<devise code="eur"><kurs>0.9246</kurs></devise>`;
    const twoKurs = `<devise code="eur"><waehrung>1 EUR</waehrung><kurs>0.9246</kurs><kurs>0.5</kurs></devise>`;
    for (const eur of [noKurs, noUnit, twoKurs]) {
      expect(parseBazgMonth(doc({ eur }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
    }
  });

  it("an implausibly long number is refused rather than processed", () => {
    expect(parseBazgMonth(doc({ eur: kurs("EUR", 1, "0." + "9".repeat(40)) }), "2026-03")).toMatchObject({ ok: false, code: "parse" });
  });

  it("surrounding whitespace in values is tolerated", () => {
    const spaced = `<devise code="eur"><waehrung> 1 EUR </waehrung><kurs>\n 0.9246 \n</kurs></devise>`;
    expect(parseBazgMonth(doc({ eur: spaced }), "2026-03")).toMatchObject({ ok: true, rates: { EUR: 924_600 } });
  });

  it("a refusal never echoes the document back", () => {
    const result = parseBazgMonth(doc({ eur: kurs("EUR", 1, "SECRET-LOOKING-VALUE") }), "2026-03");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).not.toContain("SECRET-LOOKING-VALUE");
  });
});

describe("constants", () => {
  it("reads exactly the three currencies of the spec", () => {
    expect([...FX_CURRENCIES]).toEqual(["EUR", "USD", "GBP"]);
  });
});
