/**
 * Request and response shapes of the contract routes (specs/024-projects T8, tasks.md § API
 * contracts; AC-2.1 – AC-2.9).
 *
 * A contract's `terms` depend on the project's type, which only the handler knows, so the request
 * body carries `terms` as an open object and `terms.ts` validates it against the schema of the
 * type. The shapes below are those per-type schemas. There is no amount, price or rate anywhere
 * (D14, AC-2.9): man-days and hours are units of work, not money.
 */

import { z } from "@hono/zod-openapi";
import { DateOnlySchema, IdSchema, requiredText } from "../lib/http";
import { ContractSummarySchema } from "../projects/projects.schemas";

// ─── Terms (input) ───────────────────────────────────────────────────────────

/** numeric(6,1): five digits and one decimal. */
export const MAX_MAN_DAYS = 99_999.9;
/** A generous cap on purchased hours; keeps the value inside the database's integer. */
export const MAX_HOURS = 1_000_000;
/** A T&M contract lists profiles, not a roster; also keeps the body small. */
export const MAX_POSITIONS = 50;
/** SLA take-in-charge times are whole working days, 0–60 (the database CHECK). */
export const MAX_SLA_DAYS = 60;

const atMostOneDecimal = (v: number): boolean => Math.round(v * 10) / 10 === v;

/** Man-days ≥ 0, one decimal. */
const manDaysOrZero = z.number().min(0).max(MAX_MAN_DAYS).refine(atMostOneDecimal, "At most one decimal");
/** Man-days > 0, one decimal. */
const manDays = z.number().gt(0).max(MAX_MAN_DAYS).refine(atMostOneDecimal, "At most one decimal");

const slaDays = z.number().int().min(0).max(MAX_SLA_DAYS);

export const SlaSchema = z.object({ highDays: slaDays, normalDays: slaDays }).strict();

export const HourPackageSchema = z
  .object({
    hours: z.number().int().gt(0).max(MAX_HOURS),
    kind: z.enum(["capacity", "yearly"]),
    startDate: DateOnlySchema,
    expiryDate: DateOnlySchema.nullable().optional(),
  })
  .strict()
  .superRefine((pkg, ctx) => {
    if (pkg.expiryDate == null) return;
    if (pkg.kind !== "capacity") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "Only a capacity package expires" });
    } else if (pkg.expiryDate < pkg.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "Must not be before the start date" });
    }
  });

export const PositionSchema = z.object({ profile: requiredText(120), plannedManDays: manDays }).strict();

export const FixedPriceTermsSchema = z
  .object({
    deadline: DateOnlySchema,
    estimatedManDays: manDaysOrZero.nullable().optional(),
    maxEffortManDays: manDays,
  })
  .strict();

/** `maintenance` and `saas`: an SLA, an hour package, or both (maintenance needs one, saas may have neither). */
export const SlaAndHoursTermsSchema = z
  .object({ sla: SlaSchema.nullable().optional(), hourPackage: HourPackageSchema.nullable().optional() })
  .strict();

export const TAndMTermsSchema = z.object({ positions: z.array(PositionSchema).min(1).max(MAX_POSITIONS) }).strict();

// ─── Terms (output): every member present, `null` when absent ────────────────

const SlaView = z.object({ highDays: z.number().int(), normalDays: z.number().int() });
const HourPackageView = z.object({
  hours: z.number().int(),
  kind: z.enum(["capacity", "yearly"]),
  startDate: z.string(),
  expiryDate: z.string().nullable(),
});

export const TermsViewSchema = z.union([
  z.object({ deadline: z.string(), estimatedManDays: z.number().nullable(), maxEffortManDays: z.number() }),
  z.object({ sla: SlaView.nullable(), hourPackage: HourPackageView.nullable() }),
  z.object({ positions: z.array(z.object({ profile: z.string(), plannedManDays: z.number() })) }),
  z.object({}),
]);

// ─── Contract ────────────────────────────────────────────────────────────────

export const ContractSchema = ContractSummarySchema.extend({
  projectId: z.string(),
  /** Filled by the CRM hand-off (specs/025); `null` for a contract entered by hand. */
  dealId: z.string().nullable(),
  terms: TermsViewSchema,
  version: z.number().int(),
});

export const ContractParams = z.object({ id: IdSchema, contractId: IdSchema });

const termsDescription =
  "By project type — fixed_price: { deadline, estimatedManDays?, maxEffortManDays }; maintenance: " +
  "{ sla?, hourPackage? } (one required); saas: { sla?, hourPackage? }; t_and_m: { positions: " +
  "[{ profile, plannedManDays }] } (at least one). Validated against the project's type.";

const TermsInput = z.record(z.unknown()).openapi({ description: termsDescription });

const startsBeforeEnd = (body: { startDate?: string | undefined; endDate?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (body.startDate !== undefined && body.endDate != null && body.endDate < body.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "Must not be before the start date" });
  }
};

export const CreateContractSchema = z
  .object({
    /** A client project's own company by default; required for `saas`. */
    companyId: IdSchema.optional(),
    startDate: DateOnlySchema,
    endDate: DateOnlySchema.nullable().optional(),
    terms: TermsInput.optional(),
  })
  .strict()
  .superRefine(startsBeforeEnd);

/** `terms`, when given, REPLACES the contract's terms; `endDate: null` reopens an ended contract. */
export const UpdateContractSchema = z
  .object({
    startDate: DateOnlySchema.optional(),
    endDate: DateOnlySchema.nullable().optional(),
    terms: TermsInput.optional(),
  })
  .strict()
  .superRefine(startsBeforeEnd)
  .refine((body) => body.startDate !== undefined || body.endDate !== undefined || body.terms !== undefined, "Nothing to change");
