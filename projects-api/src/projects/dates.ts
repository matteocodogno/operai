/**
 * A project has no dates of its own (A8): the page shows the earliest contract start and
 * the latest contract end (AC-1.5, tasks.md "Derived dates").
 */

import { toDateOnly } from "../lib/http";

export interface ContractDates {
  readonly startDate: Date;
  readonly endDate: Date | null;
}

export interface DerivedDates {
  readonly startDate: string | null;
  readonly endDate: string | null;
}

/**
 * `startDate` is the earliest contract start, `null` with no contract; `endDate` is the
 * latest contract end, `null` with no contract OR when any contract is open-ended (a project
 * with an open-ended contract has no end yet).
 */
export function deriveDates(contracts: readonly ContractDates[]): DerivedDates {
  if (contracts.length === 0) return { startDate: null, endDate: null };
  const starts = contracts.map((contract) => contract.startDate.getTime());
  const ends = contracts.map((contract) => contract.endDate?.getTime() ?? null);
  const openEnded = ends.some((end) => end === null);
  return {
    startDate: toDateOnly(new Date(Math.min(...starts))),
    endDate: openEnded ? null : toDateOnly(new Date(Math.max(...(ends as number[])))),
  };
}
