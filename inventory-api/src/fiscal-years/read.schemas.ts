/** Schemas for the fiscal-year reads (T19, specs/015; plan.md § Ledger). */

import { z } from "@hono/zod-openapi";
import { EntitySchema } from "../depreciation/rules.schemas";

export const CURRENCY = { welld_ch: "CHF", welld_it: "EUR" } as const;

export const YearSchema = z
  .string()
  .regex(/^\d{4}$/, "must be a four-digit year")
  .transform(Number);

export const ListQuerySchema = z.object({ entity: EntitySchema });
export const ViewParamsSchema = z.object({ entity: EntitySchema, year: YearSchema });

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown", "system"]),
});

export const YearsListSchema = z.object({
  years: z.array(
    z.object({
      year: z.number().int(),
      status: z.enum(["open", "closed"]),
      closedAt: z.string().nullable(),
      closable: z.boolean(),
    }),
  ),
});

export const FiscalYearViewSchema = z.object({
  entity: EntitySchema,
  year: z.number().int(),
  currency: z.enum(["CHF", "EUR"]),
  status: z.enum(["open", "closed"]),
  closedAt: z.string().nullable(),
  rollForward: z.object({
    openingCents: z.number().int(),
    disposalsCents: z.number().int(),
    purchasesCents: z.number().int(),
    depreciationCents: z.number().int(),
    closingCents: z.number().int(),
  }),
  assets: z.array(
    z.object({
      assetId: z.string(),
      purchaseDate: z.string(),
      description: z.string(),
      serialNumber: z.string().nullable(),
      holder: IdentitySchema.nullable(),
      purchasePriceCents: z.number().int(),
      openingCents: z.number().int(),
      purchaseCents: z.number().int(),
      depreciationCents: z.number().int(),
      disposalCents: z.number().int(),
      closingCents: z.number().int(),
    }),
  ),
});
