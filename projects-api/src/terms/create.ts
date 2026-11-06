/**
 * Making terms: the rules and the row, shared by every way terms are born (specs/021 T8 by hand as
 * `POST /projects/{id}/terms`, specs/022 T23 with a project in the take of a deal). The routes own
 * the request, the guards and the answer; this module owns what a project must satisfy to take terms
 * and the data they are stored with, so the by-hand route and the take cannot drift apart.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { fromDateOnly } from "../lib/http";
import { conflict } from "../lib/problem";
import type { ProjectType } from "../projects/projects.schemas";
import { positionRows, termColumns, type Terms } from "./terms";

/** What a project must be for terms to be added to it (AC-2.1, AC-5.2). */
export interface TermsHost {
  readonly type: ProjectType;
  readonly state: string;
  readonly hasTerms: boolean;
}

/**
 * 409 unless the project takes new terms: an `internal` project has no clients, one that has terms
 * already edits them, and a `closed` or `cancelled` one takes none until it is reopened. The `detail`
 * is shown to the user.
 */
export function assertTakesTerms(project: TermsHost): void {
  if (project.type === "internal") {
    throw conflict("terms_not_allowed", "An internal project has no clients and takes no terms");
  }
  if (project.hasTerms) {
    throw conflict("terms_exist", "This project already has terms: edit them instead");
  }
  if (project.state === "closed" || project.state === "cancelled") {
    throw conflict("project_not_open", `A ${project.state} project takes no new terms`, { state: project.state });
  }
}

export interface NewTerms {
  readonly type: ProjectType;
  readonly startDate: string;
  readonly endDate?: string | null | undefined;
  readonly terms: Terms;
}

/**
 * The columns of new terms and their T&M positions, without the project: the terms route adds
 * `projectId`, a new project nests them under `terms.create`.
 */
export function termsCreateData(terms: NewTerms): Omit<Prisma.ProjectTermsUncheckedCreateInput, "projectId"> {
  return {
    type: terms.type,
    startDate: fromDateOnly(terms.startDate)!,
    endDate: fromDateOnly(terms.endDate) ?? null,
    ...termColumns(terms.terms),
    positions: { create: positionRows(terms.terms) },
  };
}
