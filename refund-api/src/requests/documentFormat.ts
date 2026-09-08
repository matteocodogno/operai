/**
 * ONE locale for a refund document. Every number and every date rendered into
 * a PDF goes through here.
 *
 * The export used to mix three conventions in a single page: amounts with a
 * comma decimal (`206,50`), the mileage rate with a dot (`0.70 CHF/km`)
 * because it was interpolated straight from the API's decimal string, and the
 * rate's validity as a raw ISO date (`2021-01-31`) while every other date was
 * something else again. Timestamps were raw ISO with milliseconds and a UTC
 * `Z` — a log line, not a document. Currency sat before the amount here and
 * after it on screen.
 *
 * The settled convention, matching what refund-ui shows:
 *   money      206,50 CHF        (comma decimal, currency SUFFIX)
 *   rate       0,70 CHF/km
 *   date       31.01.2021
 *   timestamp  08.09.2026 08:45 (CEST)
 */

/** Currency label per code — the SUFFIX form refund-ui's `formatMoney` established. */
const CURRENCY_SUFFIX: Record<string, string> = {
  EUR: "€",
  CHF: "CHF",
  USD: "$",
  GBP: "£",
};

const suffixFor = (currency: string): string => CURRENCY_SUFFIX[currency] ?? currency;

/**
 * Integer minor units → `206,50 CHF`.
 *
 * Currency AFTER the amount, reversing this renderer's previous `CHF 206,50`.
 * Both forms are defensible in isolation — Swiss practice prefixes, Italian
 * suffixes — so the tie-break is that refund-ui already suffixes everywhere,
 * and a reader comparing the PDF against the screen it came from should not
 * have to notice a difference. `batches/pdf.ts` still prefixes; see this
 * module's doc in the changeset for that remaining gap.
 */
export const formatMoney = (cents: number, currency: string): string => {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`formatMoney: cents must be an integer, got ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const decimals = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole},${decimals} ${suffixFor(currency)}`;
};

/**
 * `0,70 CHF/km`. `ratePerKm` arrives as a decimal STRING with a dot
 * (`microsToDecimalString`), which is correct on the wire and wrong on paper —
 * mirrors refund-ui's `formatRatePerKm` exactly.
 */
export const formatRatePerKm = (ratePerKm: string, currency: string): string =>
  `${ratePerKm.replace(".", ",")} ${suffixFor(currency)}/km`;

/** `2026-08-11` → `11.08.2026`. Date-only in, date-only out — never parsed, so no timezone can shift it. */
export const formatDate = (isoDate: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
};

/**
 * The single timezone every refund document is rendered in.
 *
 * Both legal entities sit in it: Europe/Rome and Europe/Zurich share CET/CEST
 * year-round, so one zone serves welld_it and welld_ch without choosing
 * between them. Rendering in UTC instead — which is what the raw
 * `toISOString()` did — silently shifts the DATE by a day for anything
 * stamped late evening local time, which on an audit artifact is not a
 * cosmetic problem.
 */
export const DOCUMENT_TIME_ZONE = "Europe/Zurich";

/**
 * `08.09.2026 08:45 (CEST)` — local civil time, minute precision, with the
 * zone named.
 *
 * The abbreviation is not decoration: it is what lets a reader reconcile this
 * document against a UTC log or a differently-zoned system, and it makes the
 * summer/winter shift explicit rather than something the reader has to infer
 * from the month. Milliseconds are dropped — no accounting question has ever
 * turned on them.
 */
export const formatTimestamp = (value: Date): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DOCUMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(value);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")} (${get("timeZoneName")})`;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The period a request's expenses fall in — "August 2026", or
 * "August – September 2026" when its lines straddle a month boundary.
 *
 * Derived from the LINE dates, not from when the request was submitted or
 * decided: an expense filed in September for an August trip belongs to
 * August, and that is the question an accountant filing the document is
 * actually asking.
 */
export const formatPeriod = (isoDates: readonly string[]): string | null => {
  const sorted = [...isoDates].filter((d) => /^\d{4}-\d{2}/.test(d)).sort();
  if (sorted.length === 0) return null;

  const label = (iso: string): string => {
    const [year, month] = iso.split("-");
    return `${MONTHS[Number(month) - 1]} ${year}`;
  };
  const first = label(sorted[0]!);
  const last = label(sorted[sorted.length - 1]!);
  return first === last ? first : `${first} – ${last}`;
};

/**
 * `2026-08` — the period in the SORTABLE form a filename wants, from the
 * earliest line date.
 *
 * Deliberately not `formatPeriod`'s prose ("August 2026"): a folder sorted by
 * name must put August before September, which "August"/"September" does not.
 * A request straddling two months takes its earliest — the filename is an
 * address, and the document itself states the full range on its first page.
 */
export const formatFilePeriod = (isoDates: readonly string[]): string | null => {
  const sorted = [...isoDates].filter((d) => /^\d{4}-\d{2}/.test(d)).sort();
  return sorted.length === 0 ? null : sorted[0]!.slice(0, 7);
};

/** `2026-09` — the batch period, from its cutoff. Sortable, unambiguous, and what a folder name wants. */
export const formatBatchPeriod = (cutoff: Date): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DOCUMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(cutoff);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
};
