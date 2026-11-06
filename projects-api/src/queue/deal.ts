/**
 * The deal behind a take (specs/022 T7, T24), read live from crm-api and checked against the caller.
 * Shared by the take, the ops-manager candidates and the referent contacts of the to-start queue, so
 * every route that answers about a queued deal refuses it the same way: unknown (404), not the
 * caller's to take (403 `out_of_scope`), taken (409), no longer won (409).
 *
 * The CRM, not the request, says which entity a deal belongs to and which company it is for: a client
 * never names either (T18 M1).
 */

import { assertCanTake, type AuthzSource } from "../auth/guards";
import { dealsById, orCrmUnavailable, type CrmDeal } from "../lib/crm";
import { db } from "../lib/db";
import { ProblemError, conflict } from "../lib/problem";

export const dealTaken = (): ProblemError =>
  conflict("deal_taken", "This deal already has a purchase order: a deal feeds one project only");

/** The deal the CRM knows by `dealId`, whatever its stage; 404 `deal_not_found` otherwise, 503 when the CRM is down. */
export async function loadDeal(dealId: string): Promise<CrmDeal> {
  const deal = (await orCrmUnavailable(dealsById([dealId]))).get(dealId);
  if (!deal) {
    throw new ProblemError({ status: 404, code: "deal_not_found", detail: "The CRM does not know this deal" });
  }
  return deal;
}

/** A deal the caller may act on: it exists and the caller may take deals of its entity (`handoff:take` + `project:manage`). */
export async function loadDealForCaller(c: AuthzSource, dealId: string): Promise<CrmDeal> {
  const deal = await loadDeal(dealId);
  assertCanTake(c, deal.entity);
  return deal;
}

/**
 * The deal to take: it must exist, be the caller's to take, have no purchase order and be won now. A
 * taken deal says `deal_taken` even if it was reopened since — that is the truer answer.
 */
export async function loadTakeableDeal(c: AuthzSource, dealId: string): Promise<CrmDeal> {
  const deal = await loadDealForCaller(c, dealId);
  if (await db.purchaseOrder.findUnique({ where: { dealId }, select: { id: true } })) {
    throw dealTaken();
  }
  if (deal.stage !== "won") {
    throw conflict("deal_not_won", "This deal is no longer won in the CRM, so it cannot be taken", { stage: deal.stage });
  }
  return deal;
}
