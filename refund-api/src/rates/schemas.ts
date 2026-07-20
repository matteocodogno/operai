/**
 * Zod schemas for the mileage-rate management + effective-rate surfaces
 * (T4, specs/009-mileage-rate, plan.md § API contracts).
 *
 * Deliberately self-contained (no import from `requests/lines.schemas.ts`) —
 * the rates module is T2/T3-dependent only (tasks.md), never T5, so it
 * declares its own local ISO-date-only shape rather than reaching into a
 * sibling module that lands in a later task.
 */

import { z } from "zod";
import { CurrencySchema, EntitySchema } from "../requests/requests.schemas";

// ─── Shared calendar-validity check ────────────────────────────────────────
//
// A shape-only regex (`\d{4}-\d{2}-\d{2}`) would let "2026-02-30" pass — AC-4.5
// ("missing/invalid validFrom date") and the effective-rate query's `date`
// param both need the stricter, REAL-calendar-date check below.
const IsoDateOnlyShapeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO 8601 date (YYYY-MM-DD)");

export function isValidCalendarDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

const CalendarDateSchema = IsoDateOnlyShapeSchema.refine(isValidCalendarDate, {
  message: "must be a real calendar date (YYYY-MM-DD)",
});

// ─── POST /rates (AC-4.2, AC-4.5) ──────────────────────────────────────────

// Up to 6 decimal places — matches ratePerKmMicros' precision (1e-6 major
// units, ADR-0025). No leading '+'/'-' — a rate is always a positive
// magnitude typed by the admin; negativity/zero is rejected below (AC-4.5).
const RATE_PER_KM_DECIMAL_RE = /^\d+(\.\d{1,6})?$/;

export const AddRateBodySchema = z
  .object({
    entity: EntitySchema,
    ratePerKm: z
      .string()
      .regex(
        RATE_PER_KM_DECIMAL_RE,
        "ratePerKm must be a positive decimal number (up to 6 decimal places)",
      ),
    validFrom: CalendarDateSchema,
  })
  .superRefine((val, ctx) => {
    // AC-4.5 — non-positive value rejected. Parsed the SAME way
    // rates/service.ts's decimalToMicros does (exact, no float
    // multiplication) so a value that round-trips to 0 micros (e.g.
    // "0", "0.0000001" truncated below the micros floor) is caught here too.
    const [intPart = "0", fracPart = ""] = val.ratePerKm.split(".");
    const paddedFrac = (fracPart + "000000").slice(0, 6);
    const micros = Number(intPart) * 1_000_000 + Number(paddedFrac);
    if (micros <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ratePerKm"],
        message: "ratePerKm must be greater than zero",
      });
    }
  });
export type AddRateBody = z.infer<typeof AddRateBodySchema>;

// ─── GET /rates response (AC-4.1, AC-4.3, AC-5.3) ──────────────────────────

export const RateEntryResponseSchema = z.object({
  id: z.string(),
  ratePerKmMicros: z.number().int(),
  ratePerKm: z.string(), // decimal string, display only
  validFrom: z.string(), // YYYY-MM-DD
  createdAt: z.string().datetime(),
  createdByEmail: z.string(),
  inEffectToday: z.boolean(),
});
export type RateEntryResponse = z.infer<typeof RateEntryResponseSchema>;

export const EntityRateHistorySchema = z.object({
  entity: EntitySchema,
  currency: CurrencySchema,
  currentEntryId: z.string().nullable(),
  entries: z.array(RateEntryResponseSchema), // chronological, oldest -> newest
});
export type EntityRateHistory = z.infer<typeof EntityRateHistorySchema>;

export const RateHistoryResponseSchema = z.object({
  entities: z.array(EntityRateHistorySchema),
});
export type RateHistoryResponse = z.infer<typeof RateHistoryResponseSchema>;

// ─── GET /rates/effective (AC-2.1, AC-2.2) ─────────────────────────────────

export const EffectiveRateQuerySchema = z.object({
  entity: EntitySchema,
  date: CalendarDateSchema,
});
export type EffectiveRateQuery = z.infer<typeof EffectiveRateQuerySchema>;

export const EffectiveRateResponseSchema = z.object({
  entity: EntitySchema,
  date: z.string(),
  currency: CurrencySchema,
  inEffect: z.boolean(),
  ratePerKmMicros: z.number().int().optional(),
  ratePerKm: z.string().optional(),
  validFrom: z.string().optional(),
});
export type EffectiveRateResponse = z.infer<typeof EffectiveRateResponseSchema>;
