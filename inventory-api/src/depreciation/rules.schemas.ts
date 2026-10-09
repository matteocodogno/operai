/**
 * Request/response schemas for the rules routes (T10, specs/015) plus the
 * calendar-date schema other inventory routes reuse.
 */

import { z } from "@hono/zod-openapi";
import { ENTITIES } from "../authz/conditions";

export const EntitySchema = z.enum(ENTITIES);

/** Prisma `Int` is 32-bit: a larger value would be a 500 from the database. */
export const MAX_INT = 2_147_483_647;
/** A schedule is materialised year by year, so the life is bounded. */
export const MAX_USEFUL_LIFE_YEARS = 100;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a strict `YYYY-MM-DD` into a UTC-midnight Date; `null` when it is not a real date. */
export function parseIsoDate(value: string): Date | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/** `YYYY-MM-DD` of a `@db.Date` value. */
export const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

/** A real calendar date, `YYYY-MM-DD`, between 1900 and 2999. */
export const isoDate = (min = "1900-01-01") =>
  z
    .string()
    .refine((v) => parseIsoDate(v) !== null, "must be a calendar date (YYYY-MM-DD)")
    .refine((v) => v >= min && v <= "2999-12-31", `must be between ${min} and 2999-12-31`);

export const RuleInputSchema = z.object({
  entity: EntitySchema,
  effectiveFrom: isoDate(),
  usefulLifeYears: z.number().int().min(1).max(MAX_USEFUL_LIFE_YEARS),
  firstYearShare: z.enum(["full", "half"]),
  lowValueThresholdCents: z.number().int().min(0).max(MAX_INT).nullable(),
  residualCents: z.number().int().min(0).max(MAX_INT),
});

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown", "system"]),
});

export const RuleSchema = z.object({
  id: z.string(),
  entity: EntitySchema,
  effectiveFrom: z.string(),
  usefulLifeYears: z.number().int(),
  firstYearShare: z.enum(["full", "half"]),
  lowValueThresholdCents: z.number().int().nullable(),
  residualCents: z.number().int(),
  createdBy: IdentitySchema,
  createdAt: z.string(),
});

export const RulesListSchema = z.object({
  rules: z.array(RuleSchema),
  inForceId: z.string(),
});

export const RulesQuerySchema = z.object({ entity: EntitySchema });
