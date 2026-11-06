/**
 * Making a project: the rules and the row, shared by every way a project is born (specs/021 T5 by
 * hand, specs/022 from a won deal). The routes own the request, the guards and the answer.
 */

import type { z } from "@hono/zod-openapi";
import { findActiveCompany, orCrmUnavailable } from "../lib/crm";
import type { Prisma } from "../lib/generated/prisma/client";
import { unprocessable } from "../lib/problem";
import { termsCreateData, type NewTerms } from "../terms/create";
import { parseTerms } from "../terms/terms";
import type { CreateTermsSchema } from "../terms/terms.schemas";
import { isClientType, type ProjectType } from "./projects.schemas";

/**
 * A client project has exactly one company, which the CRM knows and has not archived (the
 * picker never offers an archived one); an `internal` project has none. `saas` is a client type: one
 * project per licence, with its company (AC-1.1, AC-5.1, specs/022 D40).
 */
export async function assertCompanyFits(type: ProjectType, companyId: string | undefined): Promise<void> {
  if (!isClientType(type)) {
    if (companyId !== undefined) {
      throw unprocessable("An internal project has no company of its own", { field: "companyId" }, "company_not_allowed");
    }
    return;
  }
  if (companyId === undefined) {
    throw unprocessable("A company is required for this project type", { field: "companyId" }, "company_required");
  }
  if (!(await orCrmUnavailable(findActiveCompany(companyId)))) {
    throw unprocessable("The company does not exist in the CRM", { field: "companyId" }, "company_not_found");
  }
}

export interface NewProject {
  readonly name: string;
  readonly type: ProjectType;
  readonly entity: "welld_ch" | "welld_it";
  readonly companyId: string | null;
  /** `null` for a project made from a deal: it awaits the ops-manager's pick (specs/022 D42). */
  readonly projectManagerId: string | null;
  readonly createdById: string;
}

/** The columns of a new project: state `planned` and version 1 are the column defaults. */
export const projectCreateData = (project: NewProject): Prisma.ProjectUncheckedCreateInput => ({
  name: project.name,
  type: project.type,
  entity: project.entity,
  companyId: project.companyId,
  projectManagerId: project.projectManagerId,
  createdById: project.createdById,
});

/**
 * The terms a hand-made project is created with, validated against ITS type (AC-5.3, A38): `null` when it
 * is created without any. An `internal` project has no clients and takes none (`422 terms_not_allowed`). The
 * type's own rules apply in full, so a refusal never leaves a half-made project: it is thrown here, before
 * anything is written, naming the field by its path in the create body (`terms.terms.deadline`).
 */
export function creationTerms(type: ProjectType, input: z.infer<typeof CreateTermsSchema> | undefined): NewTerms | null {
  if (input === undefined) return null;
  if (type === "internal") {
    throw unprocessable("An internal project has no clients and takes no terms", { field: "terms" }, "terms_not_allowed");
  }
  return { type, startDate: input.startDate, endDate: input.endDate, terms: parseTerms(type, input.terms ?? {}, ["terms", "terms"]) };
}

/** The nested write that makes the terms in the same statement as the project: nothing is left behind on a refusal. */
export const termsCreate = (terms: NewTerms | null): Pick<Prisma.ProjectUncheckedCreateInput, "terms"> =>
  terms === null ? {} : { terms: { create: termsCreateData(terms) } };
