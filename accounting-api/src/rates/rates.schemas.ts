/**
 * Zod schemas of the exchange-rate user routes (T12, specs/20261119-accounting, plan § API contracts; moved from
 * refund-api's `src/fx/fx.schemas.ts` and adapted: per entity, the minimal projection of D18/G13).
 *
 * The OUTPUT is what accounting-ui's `lib/exchangeRatesApi.ts` reads, and nothing more: a rate is `{ status: "missing" }`
 * or `{ status, rateMicros, rate }`, with no history, no `fetchedAt`, no `sourceUrl` and no who-corrected (the Accounting
 * app shows the origin, not who or when). The INPUT is strict: the fetch body takes `months` and nothing else, so a
 * `trigger` sent by a caller is refused, never read (the server derives who asks, ADR 20261119-on-demand-outbound-work-...).
 */

import { z } from "zod";
import { EntityParamSchema } from "../catalog/catalog.schemas";
import { isMonthKey } from "./months";

/** The oldest month a rate can be asked for, fetched or corrected: well inside the database's date range. */
export const RATE_MONTH_FLOOR = "2000-01";

/** `true` for a well-formed `YYYY-MM` that is not before {@link RATE_MONTH_FLOOR}. */
export const isRateMonth = (value: unknown): value is string => isMonthKey(value) && value >= RATE_MONTH_FLOOR;

const MonthSchema = z
  .string()
  .refine(isRateMonth, "must be a month, YYYY-MM, from 2000-01");

// ─── Input ───────────────────────────────────────────────────────────────────

export const EntityRatesParamsSchema = z.object({ entity: EntityParamSchema });

export const ListRatesQuerySchema = z.object({
  from: MonthSchema.optional().describe("First month of the window, `YYYY-MM`"),
  to: MonthSchema.optional().describe("Last month of the window, `YYYY-MM`"),
});

/** The months a manager asks for; default: every fetchable month that lacks a rate. Nothing else is accepted (no `trigger`). */
export const FetchRatesBodySchema = z.strictObject({
  months: z.array(MonthSchema).max(24).optional().describe("Months to fetch, `YYYY-MM`; default: every fetchable month missing a rate"),
});

/** Up to three integer digits and six decimals: `0.9246`, `1.063500`, `999.999999`. The range 0 < rate < 1000 is checked after (AC-2.5). */
export const RATE_RE = /^\d{1,3}(\.\d{1,6})?$/;

export const PutRateParamsSchema = EntityRatesParamsSchema.extend({
  month: z.string().describe("A completed month, `YYYY-MM`"),
  currency: z.string().describe("A currency the entity converts, e.g. `EUR`"),
});

export const PutRateBodySchema = z.object({
  rate: z
    .string()
    .trim()
    .regex(RATE_RE, "rate must be a positive decimal below 1000 with at most six decimals")
    .describe("The own currency for 1 unit of the foreign currency, e.g. `0.9300`"),
});

// ─── Output ──────────────────────────────────────────────────────────────────

export const RateSchema = z.union([
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({
    status: z.enum(["fetched", "corrected"]),
    rateMicros: z.number().int(),
    rate: z.string().describe("The server's display form, e.g. `0.9246`"),
  }),
]);
export type RateView = z.infer<typeof RateSchema>;

/** One row per month; `rates` holds one entry per currency the entity lists (empty for an entity with no source). */
export const MonthRowSchema = z.strictObject({
  month: z.string(),
  rates: z.record(z.string(), RateSchema),
});
export type MonthRow = z.infer<typeof MonthRowSchema>;

export const LastFetchSchema = z
  .strictObject({
    at: z.string().datetime(),
    outcome: z.string(),
    errorCode: z.string().nullable(),
    month: z.string(),
  })
  .nullable();
export type LastFetchView = z.infer<typeof LastFetchSchema>;

export const ListRatesResponseSchema = z.strictObject({
  entity: EntityParamSchema,
  ownCurrency: z.string(),
  currencies: z.array(z.string()).describe("The currencies that have a rate, in column order; empty for an entity with no source"),
  source: z.strictObject({ name: z.string() }).nullable().describe("`null`: no official source (AC-2.11)"),
  months: z.array(MonthRowSchema).describe("Newest first"),
  lastFetch: LastFetchSchema,
  fetchDue: z.boolean(),
});

export const FetchRatesResponseSchema = z.strictObject({
  attempts: z.array(
    z.strictObject({
      month: z.string(),
      /** `ok` | `failed` | `not_fetchable` | `disabled` | `throttled` (asked again within 15 minutes: nothing written) */
      outcome: z.enum(["ok", "failed", "not_fetchable", "disabled", "throttled"]),
      errorCode: z.string().nullable(),
      recorded: z.record(z.string(), z.number()).nullable(),
    }),
  ),
  /** Months over the limit of six per call, not attempted. */
  deferredMonths: z.array(z.string()),
  lastFetch: LastFetchSchema,
});

export const RatesProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
  field: z.string().optional(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
});
