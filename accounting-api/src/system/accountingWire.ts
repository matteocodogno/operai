/**
 * `accountingWire` — the wire schema of the two 200 bodies of accounting-api's `/system/v1/*` routes
 * (specs/20261119-accounting T7; plan § API contracts, "accounting-api — system routes"; D23, ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-… point 7).
 *
 *   GET /system/v1/entities/{entity}/reference-data   -> `referenceDataWire`
 *   GET /system/v1/entities/{entity}/rates?pairs=…    -> `ratesWire`
 *
 * PRODUCER SIDE. accounting-api validates every answer with these schemas BEFORE sending it (T13), so a
 * route that drifts from the contract fails its own test instead of reaching a consumer. The same
 * region sits in refund-api/src/accounting/accountingWire.ts, where the `AccountingPort` parses what
 * it receives with the same code, so the two sides cannot each read the wire their own way and drift
 * without either test failing. `scripts/check-shared-copies.ts` (`mise run shared:check`, in CI) fails
 * when the regions differ by a byte: a change to the wire is a change to both files in one commit.
 *
 * STRICT, both ways. Every object refuses a key it does not list (a field added on one side only is a
 * failure, never silently dropped), and every list refuses a second element of the same natural key.
 * The wire has no ids (D1, D24): entries are named by number or code, a month by `YYYY-MM`.
 *
 * Only what the wire itself fixes lives here: its shape, its enums and the bounds the database already
 * guarantees (`rateMicros`, `rateBasisPoints`, the number of pairs). The field limits of AC-1.2 and
 * AC-1.5 (20, 120, 16, 80 characters) are `catalog/limits.ts`'s (D31) and are not repeated.
 */

// shared-copy:begin accountingWire
import { z } from "zod";

/** The legal entities Accounting keeps data for. */
export const wireEntity = z.enum(["welld_ch", "welld_it"]);

/** The own currency of an entity: the one every rate is expressed in (CHF for welld_ch, EUR for welld_it). */
export const wireOwnCurrency = z.enum(["CHF", "EUR"]);

/** A foreign currency with a rate to the own currency (the source's: EUR, USD and GBP to CHF). */
export const wireRateCurrency = z.enum(["EUR", "USD", "GBP"]);

/** A calendar month, `YYYY-MM`. */
export const wireMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

/** How many distinct (currency, month) pairs one rates request may carry, and so one answer holds. */
export const WIRE_RATE_PAIRS_MAX = 36;

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): boolean =>
  new Set(items.map(key)).size === items.length;

// ─── GET /system/v1/entities/{entity}/reference-data ──────────────────────────

/** A ledger account, named by its number; `active` is its current state (AC-1.4, AC-1.9). */
export const ledgerAccountWire = z.strictObject({
  number: z.string().min(1),
  name: z.string().min(1),
  active: z.boolean(),
});

/** A VAT code, named by its code; the rate is in basis points (8.1 % = 810), 0..10000, and never changes (AC-1.7). */
export const vatCodeWire = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});

/** The reader's projection of an entity's reference data (AC-3.8): no ids, no who-added, no history (D18). */
export const referenceDataWire = z.strictObject({
  entity: wireEntity,
  ownCurrency: wireOwnCurrency,
  ledgerAccounts: z
    .array(ledgerAccountWire)
    .refine((items) => uniqueBy(items, (a) => a.number), "ledgerAccounts: a number appears twice"),
  vatCodes: z
    .array(vatCodeWire)
    .refine((items) => uniqueBy(items, (v) => v.code), "vatCodes: a code appears twice"),
});

// ─── GET /system/v1/entities/{entity}/rates?pairs=… ───────────────────────────

/**
 * A rate in effect: own currency per 1 unit of `currency`, times 1e6, an integer in 1..999_999_999
 * (0 < rate < 1000, AC-2.5). `origin` says whether the source's value or a manager's correction is in
 * effect. `attempted`: this call asked the source for that month (feeds refund-api's `fetchAttempted`, G10).
 */
export const inEffectRateWire = z.strictObject({
  currency: wireRateCurrency,
  month: wireMonth,
  status: z.literal("in_effect"),
  rateMicros: z.number().int().min(1).max(999_999_999),
  origin: z.enum(["fetched", "corrected"]),
  attempted: z.boolean(),
});

/** No rate in effect, and why: not yet published (SA-2), the source failed, or the entity has no source (AC-2.11). */
export const missingRateWire = z.strictObject({
  currency: wireRateCurrency,
  month: wireMonth,
  status: z.literal("missing"),
  attempted: z.boolean(),
  reason: z.enum(["not_published", "fetch_failed", "no_source"]),
});

export const ratePairWire = z.discriminatedUnion("status", [inEffectRateWire, missingRateWire]);

/** Each asked pair exactly once, in the asked order (the order is the producer's to keep; the set is checked here). */
export const ratesWire = z.strictObject({
  entity: wireEntity,
  rates: z
    .array(ratePairWire)
    .min(1)
    .max(WIRE_RATE_PAIRS_MAX)
    .refine((items) => uniqueBy(items, (r) => `${r.currency}:${r.month}`), "rates: a (currency, month) pair appears twice"),
});

export const accountingWire = { referenceData: referenceDataWire, rates: ratesWire } as const;

export type WireEntity = z.infer<typeof wireEntity>;
export type WireOwnCurrency = z.infer<typeof wireOwnCurrency>;
export type WireRateCurrency = z.infer<typeof wireRateCurrency>;
export type LedgerAccountWire = z.infer<typeof ledgerAccountWire>;
export type VatCodeWire = z.infer<typeof vatCodeWire>;
export type ReferenceDataWire = z.infer<typeof referenceDataWire>;
export type RatePairWire = z.infer<typeof ratePairWire>;
export type RatesWire = z.infer<typeof ratesWire>;
// shared-copy:end accountingWire
