/**
 * Zod schemas for the exchange-rate routes (T10, specs/20261118-refund-
 * accounting-export, plan § API contracts "Exchange rates"; AC-5.2 to AC-5.7).
 */

import { z } from "zod";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month, YYYY-MM");

export const ListRatesQuerySchema = z.object({
  from: MonthSchema.optional(),
  to: MonthSchema.optional(),
});

export const FetchRatesBodySchema = z.object({
  /** Months to fetch; default: every fetchable month missing a rate. */
  months: z.array(MonthSchema).max(24).optional(),
  /** Who is asking, for the attempt log. The Settings view says `settings_view`; default `admin`. */
  trigger: z.enum(["admin", "settings_view"]).optional(),
});
export type FetchRatesBody = z.infer<typeof FetchRatesBodySchema>;

/** Up to three integer digits and six decimals: `0.9246`, `1.063500`, `999.999999`. The range 0 < rate < 1000 is checked after (IS-6). */
export const RATE_RE = /^\d{1,3}(\.\d{1,6})?$/;

export const PutRateBodySchema = z.object({
  rate: z.string().trim().regex(RATE_RE, "rate must be a positive decimal below 1000 with at most six decimals"),
});

export const RatePathParamSchema = z.object({ month: z.string(), currency: z.string() });

const HistoryEntrySchema = z.object({
  origin: z.enum(["fetched", "corrected"]),
  rate: z.string(),
  at: z.string().datetime(),
  byEmail: z.string(),
});

export const RateSchema = z.union([
  z.object({ status: z.literal("missing") }),
  z.object({
    status: z.enum(["fetched", "corrected"]),
    rateMicros: z.number().int(),
    rate: z.string(),
    fetchedAt: z.string().datetime().optional(),
    sourceUrl: z.string().optional(),
    correctedAt: z.string().datetime().optional(),
    correctedByEmail: z.string().optional(),
    history: z.array(HistoryEntrySchema),
  }),
]);
export type RateView = z.infer<typeof RateSchema>;

export const MonthRowSchema = z.object({
  month: z.string(),
  rates: z.object({ EUR: RateSchema, USD: RateSchema, GBP: RateSchema }),
});
export type MonthRow = z.infer<typeof MonthRowSchema>;

export const LastFetchSchema = z
  .object({ at: z.string().datetime(), outcome: z.string(), errorCode: z.string().nullable(), month: z.string() })
  .nullable();

export const ListRatesResponseSchema = z.object({
  /** Newest first. */
  months: z.array(MonthRowSchema),
  lastFetch: LastFetchSchema,
  fetchDue: z.boolean(),
});

export const FetchRatesResponseSchema = z.object({
  attempts: z.array(
    z.object({
      month: z.string(),
      /** `ok` | `failed` | `not_fetchable` | `disabled` | `throttled` (asked again within 15 minutes: nothing written) */
      outcome: z.string(),
      errorCode: z.string().nullable(),
      recorded: z.record(z.string(), z.number()).nullable(),
    }),
  ),
  /** Months over the limit of six per call, not attempted. */
  deferredMonths: z.array(z.string()),
  lastFetch: LastFetchSchema,
});

export const FxProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});
