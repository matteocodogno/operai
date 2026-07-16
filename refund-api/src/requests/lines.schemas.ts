/**
 * Zod validation for expense-line create/update bodies (T8,
 * specs/007-refund-service, AC-1.2/1.6).
 *
 * Required: date, type, motivo, requestedAmountCents (>=0 int), entity.
 * `km`: required and > 0 IFF type === "travel_km"; rejected (422) if present
 * for any other type. PUT reuses the SAME schema as POST — "editing a line
 * commits the whole line object" (plan.md § API contracts).
 */

import { z } from "zod";
import { EntitySchema, ExpenseTypeSchema } from "./requests.schemas";

const IsoDateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO 8601 date (YYYY-MM-DD)");

export const LineBodySchema = z
  .object({
    date: IsoDateOnlySchema,
    type: ExpenseTypeSchema,
    motivo: z.string().min(1, "motivo is required").max(2000),
    entity: EntitySchema,
    requestedAmountCents: z
      .number()
      .int("requestedAmountCents must be an integer")
      .nonnegative("requestedAmountCents must be >= 0"),
    km: z.number().int("km must be an integer").optional(),
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
    } else if (val.km !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["km"],
        message: "km must not be provided unless type is travel_km",
      });
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
}): boolean {
  if (line.motivo.trim().length === 0) return false;
  if (!Number.isInteger(line.requestedAmountCents)) return false;
  if (line.requestedAmountCents < 0) return false;
  if (line.type === "travel_km") {
    return line.km !== null && Number.isInteger(line.km) && line.km > 0;
  }
  return line.km === null;
}
