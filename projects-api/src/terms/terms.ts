/**
 * A project's terms, by project type (specs/20261103-projects T8 as renamed by specs/20261103-projects-handoff T23; AC-2.3 –
 * AC-2.8, AC-1.8, AC-5.3): validation of the request's `terms`, the columns they are stored in, and
 * the view they are read back as.
 *
 * The database CHECKs already refuse a malformed row; these rules exist so a bad request is a
 * 400 / 422 naming the field, never a 500 from a constraint.
 *
 * The wire shape is specs/20261103-projects's contract shape, renamed: `{ id, type, startDate, endDate, terms,
 * version }`, with the type-specific `terms` nested (`termsView`).
 */

import type { z } from "@hono/zod-openapi";
import type { Prisma } from "../lib/generated/prisma/client";
import { businessDay } from "../lib/businessDay";
import { fromDateOnly, toDateOnly } from "../lib/http";
import { ProblemError, conflict, unprocessable } from "../lib/problem";
import type { ProjectType } from "../projects/projects.schemas";
import {
  FixedPriceTermsSchema,
  SlaAndHoursTermsSchema,
  TAndMTermsSchema,
  type HourPackageSchema,
  type SlaSchema,
} from "./terms.schemas";
import { packagePeriod } from "./packagePeriod";

type Sla = z.infer<typeof SlaSchema>;
type HourPackage = z.infer<typeof HourPackageSchema>;

/** Validated terms, one shape per type, absent members explicit (`null`). */
export type Terms =
  | { readonly type: "fixed_price"; readonly deadline: string; readonly estimatedManDays: number | null; readonly maxEffortManDays: number }
  | { readonly type: "maintenance" | "saas"; readonly sla: Sla | null; readonly hourPackage: HourPackage | null }
  | { readonly type: "t_and_m"; readonly positions: readonly { profile: string; plannedManDays: number }[] };

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** The 400 of `validationHook` (src/lib/problem.ts), for a failure found after the body was parsed. */
export function validationFailed(issues: readonly IssueLike[], prefix: readonly string[] = []): ProblemError {
  const errors = issues.map((issue) => ({ field: [...prefix, ...issue.path.map(String)].join("."), message: issue.message }));
  return new ProblemError({
    status: 400,
    code: "validation_failed",
    detail: errors[0] ? `${errors[0].field || "body"}: ${errors[0].message}` : "Invalid request",
    extras: { field: errors[0]?.field ?? "", errors },
  });
}

/**
 * Parses `raw` as `terms` for a project of `type`; throws the 400 / 422 problem when it is not valid.
 * `at` is where `terms` sits in the request body, so a problem names the field by its full path in
 * the body: `terms` on a terms write (`terms.deadline`), `terms.terms` when taking a deal
 * (`terms.terms.deadline`, specs/20261103-projects-handoff).
 */
export function parseTerms(type: ProjectType, raw: unknown, at: readonly string[] = ["terms"]): Terms {
  const fail = (error: { issues: readonly IssueLike[] }): never => {
    throw validationFailed(error.issues, at);
  };
  switch (type) {
    case "fixed_price": {
      const parsed = FixedPriceTermsSchema.safeParse(raw);
      if (!parsed.success) return fail(parsed.error);
      const { deadline, estimatedManDays, maxEffortManDays } = parsed.data;
      return { type, deadline, estimatedManDays: estimatedManDays ?? null, maxEffortManDays };
    }
    case "maintenance":
    case "saas": {
      const parsed = SlaAndHoursTermsSchema.safeParse(raw);
      if (!parsed.success) return fail(parsed.error);
      const sla = parsed.data.sla ?? null;
      const hourPackage = parsed.data.hourPackage ?? null;
      if (type === "maintenance" && sla === null && hourPackage === null) {
        throw unprocessable(
          "Maintenance terms need an SLA, an hour package, or both",
          { field: at.join(".") },
          "maintenance_needs_sla_or_hours",
        );
      }
      return { type, sla, hourPackage };
    }
    case "t_and_m": {
      const parsed = TAndMTermsSchema.safeParse(raw);
      if (!parsed.success) return fail(parsed.error);
      return { type, positions: parsed.data.positions };
    }
    case "internal":
      // An internal project takes no terms; the routes refuse it before it gets here.
      throw conflict("terms_not_allowed", "An internal project has no clients and takes no terms");
  }
}

type TermColumns = Pick<
  Prisma.ProjectTermsUncheckedCreateInput,
  | "deadline"
  | "estimatedManDays"
  | "maxEffortManDays"
  | "slaHighDays"
  | "slaNormalDays"
  | "hourPackageHours"
  | "hourPackageKind"
  | "hourPackageStart"
  | "hourPackageExpiry"
>;

/** The term columns of `ProjectTerms`: every column of the type's terms is set, so a replacement clears what it drops. */
export function termColumns(terms: Terms): TermColumns {
  switch (terms.type) {
    case "fixed_price":
      return {
        deadline: fromDateOnly(terms.deadline)!,
        estimatedManDays: terms.estimatedManDays,
        maxEffortManDays: terms.maxEffortManDays,
      };
    case "maintenance":
    case "saas":
      return {
        slaHighDays: terms.sla?.highDays ?? null,
        slaNormalDays: terms.sla?.normalDays ?? null,
        hourPackageHours: terms.hourPackage?.hours ?? null,
        hourPackageKind: terms.hourPackage?.kind ?? null,
        hourPackageStart: fromDateOnly(terms.hourPackage?.startDate ?? null) ?? null,
        hourPackageExpiry: fromDateOnly(terms.hourPackage?.expiryDate ?? null) ?? null,
      };
    case "t_and_m":
      return {};
  }
}

/** The `ProjectTermsPosition` rows of T&M terms, in the order given. */
export const positionRows = (terms: Terms): { profile: string; plannedManDays: number; position: number }[] =>
  terms.type === "t_and_m"
    ? terms.positions.map((position, index) => ({
        profile: position.profile,
        plannedManDays: position.plannedManDays,
        position: index,
      }))
    : [];

type Decimalish = { toNumber(): number };
const num = (value: Decimalish | null): number | null => (value === null ? null : value.toNumber());

/** What `toTermsView` reads from stored terms. */
export interface TermsRow {
  readonly id: string;
  readonly type: ProjectType;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly deadline: Date | null;
  readonly estimatedManDays: Decimalish | null;
  readonly maxEffortManDays: Decimalish | null;
  readonly slaHighDays: number | null;
  readonly slaNormalDays: number | null;
  readonly hourPackageHours: number | null;
  readonly hourPackageKind: "capacity" | "yearly" | null;
  readonly hourPackageStart: Date | null;
  readonly hourPackageExpiry: Date | null;
  readonly positions: readonly { profile: string; plannedManDays: Decimalish }[];
  readonly version: number;
}

/** An hour package as the view shows it: what is stored, and the window that is current at `today` (derived, never stored). */
const hourPackageView = (
  pkg: { readonly hours: number; readonly kind: "capacity" | "yearly"; readonly startDate: string; readonly expiryDate: string | null },
  today: string,
) => ({ ...pkg, currentPeriod: packagePeriod(pkg, today) });

/**
 * The type-specific `terms` of the `Terms` view: the stored terms of the project's type, absent members `null`. An hour
 * package carries its `currentPeriod` at `today`, the Europe/Zurich business day (specs/20261112-project-hours T3).
 */
export function termsView(row: TermsRow, today: string = businessDay()) {
  switch (row.type) {
    case "fixed_price":
      return {
        deadline: toDateOnly(row.deadline)!,
        estimatedManDays: num(row.estimatedManDays),
        maxEffortManDays: num(row.maxEffortManDays)!,
      };
    case "maintenance":
    case "saas":
      return {
        sla:
          row.slaHighDays === null || row.slaNormalDays === null
            ? null
            : { highDays: row.slaHighDays, normalDays: row.slaNormalDays },
        hourPackage:
          row.hourPackageHours === null || row.hourPackageKind === null || row.hourPackageStart === null
            ? null
            : hourPackageView(
                {
                  hours: row.hourPackageHours,
                  kind: row.hourPackageKind,
                  startDate: toDateOnly(row.hourPackageStart)!,
                  expiryDate: toDateOnly(row.hourPackageExpiry),
                },
                today,
              ),
      };
    case "t_and_m":
      return {
        positions: row.positions.map((position) => ({
          profile: position.profile,
          plannedManDays: position.plannedManDays.toNumber(),
        })),
      };
    case "internal":
      return {};
  }
}

/** The `Terms` of tasks.md § API contracts: `{ id, type, startDate, endDate, terms, version }`. */
export function toTermsView(row: TermsRow, today: string = businessDay()) {
  return {
    id: row.id,
    type: row.type,
    startDate: toDateOnly(row.startDate)!,
    endDate: toDateOnly(row.endDate),
    terms: termsView(row, today),
    version: row.version,
  };
}
