/**
 * Zod validation for expense-line create/update bodies (T8,
 * specs/20260716-refund-service, AC-1.2/1.6).
 *
 * Required: date, type, motivo, entity; `km`: required and > 0 IFF
 * type === "travel_km"; rejected (422) if present for any other type. PUT
 * reuses the SAME schema as POST — "editing a line commits the whole line
 * object" (plan.md § API contracts).
 *
 * `currency`/`requestedAmountCents` (specs/20260720-mileage-rate amendment):
 * REQUIRED for every type EXCEPT `travel_km` (2026-07-17 amendment —
 * independently-stored, NOT derived from entity; any (entity, currency)
 * combination is valid, see 007 plan.md § Money handling — unchanged for
 * every non-mileage type). For `travel_km`, both are OPTIONAL at the schema
 * level and, if sent, IGNORED — never trusted (AC-1.6, Security A04): the
 * server ALWAYS derives `currency` from `entity` (ENTITY_CURRENCY) and
 * computes `requestedAmountCents` from `km x the effective rate`
 * (lines.repo.ts).
 */

import { z } from "zod";
import { noNul } from "../lib/inputText";
import { CurrencySchema, EntitySchema, ExpenseTypeSchema } from "./requests.schemas";

const IsoDateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO 8601 date (YYYY-MM-DD)");

/** One address of a mileage trip: trimmed, 1 to 300 characters. */
export const TripAddressSchema = noNul(
  z
    .string()
    .trim()
    .min(1, "the address must not be empty")
    .max(300, "the address is at most 300 characters"),
);

export const LineBodySchema = z
  .object({
    date: IsoDateOnlySchema,
    type: ExpenseTypeSchema,
    motivo: noNul(z.string().min(1, "motivo is required").max(2000)),
    entity: EntitySchema,
    currency: CurrencySchema.optional(),
    requestedAmountCents: z
      .number()
      .int("requestedAmountCents must be an integer")
      .nonnegative("requestedAmountCents must be >= 0")
      .optional(),
    km: z.number().int("km must be an integer").optional(),
    // A mileage line's trip is there and back. Informative only: `km` is always the whole distance, never doubled.
    roundTrip: z.boolean().optional(),
    // A mileage trip's start and end: the text of the chosen address suggestion (or typed when Google is unavailable).
    fromAddress: TripAddressSchema.optional(),
    toAddress: TripAddressSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "travel_km") {
      if (val.km === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["km"],
          message: "km is required and must be > 0 when type is travel_km",
        });
      } else if (val.km <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["km"],
          message: "km must be > 0 when type is travel_km",
        });
      }
      // Since 2026-11-25 a mileage trip states where it starts and ends.
      for (const key of ["fromAddress", "toAddress"] as const) {
        if (val[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when type is travel_km`,
          });
        }
      }
      // currency/requestedAmountCents are deliberately NOT validated here —
      // server-derived, a client value (if sent) is simply ignored
      // (lines.repo.ts), never rejected and never trusted.
    } else {
      if (val.km !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["km"],
          message: "km must not be provided unless type is travel_km",
        });
      }
      for (const key of ["fromAddress", "toAddress"] as const) {
        if (val[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} applies only to travel_km`,
          });
        }
      }
      if (val.roundTrip === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roundTrip"],
          message: "roundTrip applies only to travel_km",
        });
      }
      // Every non-travel_km type keeps 007's original required fields.
      if (val.currency === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["currency"],
          message: "currency is required unless type is travel_km",
        });
      }
      if (val.requestedAmountCents === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requestedAmountCents"],
          message: "requestedAmountCents is required unless type is travel_km",
        });
      }
    }
  });

export type LineBody = z.infer<typeof LineBodySchema>;

/**
 * Re-validates a PERSISTED line's completeness against the same rules as
 * `LineBodySchema` (T10's submit-time defense-in-depth, AC-1.6) — a line
 * created via the routes above can never actually fail this (the schema
 * already enforces it at write time), but a row inserted by direct DB access
 * (bypassing the API — e.g. a future migration/bug) must still be caught at
 * submit time, not silently accepted.
 */
export function isLineComplete(line: {
  readonly motivo: string;
  readonly requestedAmountCents: number;
  readonly type: string;
  readonly km: number | null;
  readonly fromAddress?: string | null;
  readonly toAddress?: string | null;
}): boolean {
  if (line.motivo.trim().length === 0) return false;
  if (!Number.isInteger(line.requestedAmountCents)) return false;
  if (line.requestedAmountCents < 0) return false;
  if (line.type === "travel_km") {
    // A draft mileage line written before From and To existed must get them before it is submitted.
    const hasAddress = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;
    return (
      line.km !== null &&
      Number.isInteger(line.km) &&
      line.km > 0 &&
      hasAddress(line.fromAddress) &&
      hasAddress(line.toAddress)
    );
  }
  return line.km === null;
}
