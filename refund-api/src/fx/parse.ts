/**
 * Pure, strict parser of the federal monthly-average answer (T5,
 * specs/20261118-refund-accounting-export; AC-5.1; ADR
 * 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-...
 * decision 4; plan "FX source rules"; security surface 3).
 *
 * The source (BAZG, `https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=YYYY&m=MM`)
 * answers one XML document per month with ~70 currencies:
 *
 *   <monatsmittelkurs ...>
 *     <monat>2026-03</monat>
 *     <devise code="eur"> ... <waehrung>1 EUR</waehrung> <kurs>0.9246</kurs> </devise>
 *     ...
 *
 * The answer is CHECKED BEFORE IT IS BELIEVED, and a document that does not
 * answer exactly the question asked is refused, never "repaired":
 *
 * - NO XML LIBRARY, no entity resolution. A document carrying `<!DOCTYPE` or
 *   `<!ENTITY` (or a CDATA section, which the source never sends) is refused
 *   outright, so entity expansion and external entities cannot happen. Comments
 *   are removed before reading, so a commented-out `<devise>` is never read.
 * - the `<monat>` echo must be present exactly once and equal the REQUESTED
 *   month (the source answers for the wrong period without complaint).
 * - only `eur`, `usd` and `gbp` are read, each exactly once; any other currency
 *   is ignored (its unit may be 100 or 10000, which is none of our business).
 * - the unit is normalised to "per 1 unit": `1` stays, `100` is divided by 100;
 *   any other unit for these three currencies is refused.
 * - the rate must be a plain positive decimal, and after normalisation
 *   greater than 0 and less than 1000 CHF per unit.
 *
 * The result is in integer micros (CHF per 1 unit x 1e6; 0.9246 -> 924600), the
 * unit every rate travels in (ADR 20260720-mileage-rate-money-precision-integer-micros),
 * rounded half up once if the source ever sent more than six decimals.
 *
 * Failures are DATA, not exceptions: `{ ok: false, code }` where `code` is the
 * attempt-log error code (`parse`, `month_mismatch`, `currency_missing`), and
 * `detail` is a short human-readable reason that never contains the document.
 */

import { isMonthKey } from "./months";

export const FX_CURRENCIES = ["EUR", "USD", "GBP"] as const;
export type FxCurrency = (typeof FX_CURRENCIES)[number];

/** Defence in depth behind the client's 512 KiB body cap (`bazgSource.ts`). */
export const MAX_DOCUMENT_CHARS = 512 * 1024;
/** The rate must stay below this many CHF per unit (plan: "< 1000"). */
const MAX_RATE_MICROS_EXCLUSIVE = 1_000n * 1_000_000n;
/** Longest `<kurs>` text accepted: the source sends 4 decimals; this bounds the BigInt work. */
const MAX_KURS_CHARS = 24;

export type FxParseErrorCode = "parse" | "month_mismatch" | "currency_missing";

export type FxParseResult =
  | {
      readonly ok: true;
      /** The `<monat>` echo, equal to the requested month. */
      readonly month: string;
      /** CHF per 1 unit x 1e6, for each of EUR, USD and GBP. */
      readonly rates: Readonly<Record<FxCurrency, number>>;
    }
  | { readonly ok: false; readonly code: FxParseErrorCode; readonly detail: string };

const refuse = (code: FxParseErrorCode, detail: string): FxParseResult => ({ ok: false, code, detail });

/**
 * @param xml the response body, as text
 * @param requestedMonth the month the request asked for, `YYYY-MM`; the echo must equal it
 */
export function parseBazgMonth(xml: string, requestedMonth: string): FxParseResult {
  if (!isMonthKey(requestedMonth)) {
    throw new RangeError(`requestedMonth must be YYYY-MM, got ${JSON.stringify(requestedMonth)}`);
  }
  if (typeof xml !== "string" || xml.length === 0) return refuse("parse", "empty document");
  if (xml.length > MAX_DOCUMENT_CHARS) return refuse("parse", "document too large");

  // Constructs this document never needs, refused before anything is read.
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) return refuse("parse", "DOCTYPE and ENTITY declarations are refused");
  if (/<!\[CDATA\[/i.test(xml)) return refuse("parse", "CDATA sections are refused");

  const text = xml.replace(/<!--[\s\S]*?-->/g, "");
  if (text.includes("<!--") || text.includes("-->")) return refuse("parse", "unterminated comment");

  // ── <monat>: exactly one, equal to the month asked for ──────────────────
  const monats = [...text.matchAll(/<monat>([^<]*)<\/monat>/g)];
  if (monats.length !== 1) return refuse("parse", `expected one <monat>, found ${monats.length}`);
  const echoed = monats[0]![1]!.trim();
  if (!isMonthKey(echoed)) return refuse("parse", "<monat> is not a YYYY-MM month");
  if (echoed !== requestedMonth) {
    return refuse("month_mismatch", `asked for ${requestedMonth}, the source answered ${echoed}`);
  }

  // ── <devise> blocks of the three currencies we read ─────────────────────
  const blocks = new Map<FxCurrency, string>();
  for (const match of text.matchAll(/<devise(\s[^>]*)?>([\s\S]*?)<\/devise>/g)) {
    const code = /\bcode\s*=\s*"([^"]*)"/.exec(match[1] ?? "")?.[1]?.trim().toUpperCase();
    if (code === undefined || !isFxCurrency(code)) continue;
    if (blocks.has(code)) return refuse("parse", `${code} appears more than once`);
    blocks.set(code, match[2]!);
  }

  const rates: Partial<Record<FxCurrency, number>> = {};
  for (const currency of FX_CURRENCIES) {
    const block = blocks.get(currency);
    if (block === undefined) return refuse("currency_missing", `${currency} is missing from the answer`);
    const micros = readRate(block, currency);
    if (typeof micros === "string") return refuse("parse", micros);
    rates[currency] = micros;
  }

  return { ok: true, month: echoed, rates: rates as Record<FxCurrency, number> };
}

function isFxCurrency(value: string): value is FxCurrency {
  return (FX_CURRENCIES as readonly string[]).includes(value);
}

/** Rate in micros per 1 unit, or a reason string when the block is not acceptable. */
function readRate(block: string, currency: FxCurrency): number | string {
  const waehrung = [...block.matchAll(/<waehrung>([^<]*)<\/waehrung>/g)];
  const kurs = [...block.matchAll(/<kurs>([^<]*)<\/kurs>/g)];
  if (waehrung.length !== 1 || kurs.length !== 1) return `${currency}: expected one <waehrung> and one <kurs>`;

  const unitMatch = /^(\d{1,6})\s+([A-Za-z]{3})$/.exec(waehrung[0]![1]!.trim());
  if (!unitMatch) return `${currency}: <waehrung> is not "<unit> <currency>"`;
  if (unitMatch[2]!.toUpperCase() !== currency) return `${currency}: <waehrung> names ${unitMatch[2]!.toUpperCase()}`;
  const unit = Number(unitMatch[1]);
  if (unit !== 1 && unit !== 100) return `${currency}: unit ${unit} is not 1 or 100`;

  const kursText = kurs[0]![1]!.trim();
  if (kursText.length > MAX_KURS_CHARS || !/^\d+(\.\d+)?$/.test(kursText)) {
    return `${currency}: <kurs> is not a plain decimal`;
  }

  // kurs / 10^decimals / unit * 1e6, as one exact division, rounded half up once.
  const [whole = "0", fraction = ""] = kursText.split(".");
  const digits = BigInt(whole + fraction);
  const denominator = 10n ** BigInt(fraction.length) * BigInt(unit);
  const micros = (2n * digits * 1_000_000n + denominator) / (2n * denominator);

  if (micros <= 0n) return `${currency}: rate must be greater than 0`;
  if (micros >= MAX_RATE_MICROS_EXCLUSIVE) return `${currency}: rate must be less than 1000`;
  return Number(micros);
}
