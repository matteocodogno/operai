/**
 * The `PurchaseOrder` view (specs/022 T23, T26, tasks.md § API contracts): what a project made from a won
 * deal shows of its order — the deal, live; the estimate link; the Bexio order id; the referent, live; the
 * ops-manager, live.
 *
 * Shared by the project page (`projects.routes.ts`), the Bexio route (`bexio.routes.ts`) and the referent
 * routes (`referent.routes.ts`), which is why it is not in any of them.
 *
 * The referent is a third party's personal data (D49, T18): it is read from the CRM at every call, shown
 * and forgotten — never stored on the order (which holds only the contact's id), never cached. Any view
 * that can carry it is therefore answered with `Cache-Control: no-store` (`noStore`).
 */

import { contactName, contactsById, dealsById, type CrmContact, type CrmDeal } from "../lib/crm";
import type { Prisma } from "../lib/generated/prisma/client";
import { type HeaderSource } from "../lib/http";
import { loadPeople, type People } from "../lib/people";
import { ProblemError } from "../lib/problem";
import type { DealRef, ReferentView } from "../projects/projects.schemas";

export type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<object>;

/** A hand-made project has no purchase order, ever (D38): what every route on a purchase order answers for one. */
export const purchaseOrderNotFound = (): ProblemError =>
  new ProblemError({ status: 404, code: "purchase_order_not_found", detail: "This project has no purchase order" });

/** What a view that can carry the referent needs of the request: its headers in, and a way to set one out. */
export interface ViewContext extends HeaderSource {
  header(name: string, value: string): void;
}

/** A response with a referent in it must never be stored by a browser or a proxy (T18 M5). */
export const noStore = (c: ViewContext): void => c.header("Cache-Control", "no-store");

/**
 * A lookup that never misses, for reads, the deal twin of `companyRefs`: a `DealRef` per deal id,
 * from ONE `dealsById` call however many ids are asked, and none at all for none. `title` and `won`
 * are `null` when crm-api cannot answer or no longer knows the deal (fail soft): a project must still
 * load with the CRM down (tasks.md § Decided here). `won: false` is the "no longer won" notice (AC-2.3).
 */
export async function dealRefs(
  ids: readonly (string | null | undefined)[],
): Promise<(id: string) => DealRef> {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id !== "");
  let found = new Map<string, CrmDeal>();
  if (wanted.length > 0) {
    try {
      found = await dealsById(wanted);
    } catch (error) {
      console.error(
        "[crm] could not read deals — degrading them to unknown:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return (id) => {
    const deal = found.get(id);
    return { id, title: deal?.title ?? null, won: deal ? deal.stage === "won" : null };
  };
}

/**
 * The referent of a purchase order as the CRM has it NOW (AC-3.8 – AC-3.10, S6; T18 M3, L3, L7).
 *
 *   - no referent set → `null`, and NO call to the CRM;
 *   - the CRM item whose id equals the stored id exactly AND whose company is the project's → `ok`, its
 *     fields picked by name (never spread), archived or not (S6: archiving hides a contact from lists,
 *     erasing deletes it);
 *   - absent (erased), moved to another company or unlinked → `null`, with none of its data: the check that
 *     admitted the referent when it was set is made again at every read;
 *   - the CRM cannot answer → `unavailable`, every member but the id `null` (AC-3.10; fail soft, the page
 *     must load).
 *
 * One `ids` call per request. Meant to run in parallel with the page's other reads.
 */
export async function loadReferent(
  contactId: string | null | undefined,
  companyId: string | null,
): Promise<ReferentView | null> {
  if (!contactId) return null;
  let contact: CrmContact | undefined;
  try {
    contact = (await contactsById([contactId])).get(contactId);
  } catch (error) {
    // The message names the HTTP status or the failure kind, never a body: nothing of a contact is logged.
    console.error(
      "[crm] could not read the referent — showing it as unavailable:",
      error instanceof Error ? error.message : error,
    );
    return { id: contactId, status: "unavailable", name: null, jobTitle: null, email: null, phone: null };
  }
  // `companyId === null` first: a contact with no company must never "match" a project that has none.
  if (!contact || companyId === null || contact.companyId !== companyId) return null;
  return {
    id: contact.id,
    status: "ok",
    name: contactName(contact),
    jobTitle: contact.jobTitle,
    email: contact.email,
    phone: contact.phone,
  };
}

/** The `PurchaseOrder` of tasks.md § API contracts, from a row and the live lookups. */
export function purchaseOrderView(
  row: PurchaseOrderRow,
  deal: (id: string) => DealRef,
  person: People,
  referent: ReferentView | null,
) {
  return {
    id: row.id,
    deal: deal(row.dealId),
    estimate: row.estimateId === null ? null : { id: row.estimateId },
    bexioOrderId: row.bexioOrderId,
    referent,
    opsManager: person(row.opsManagerId),
    version: row.version,
  };
}

/**
 * The `PurchaseOrder` for a route that answers with it alone: the deal, the referent and the ops-manager
 * are read live, in parallel. `companyId` is the PROJECT's (the referent must belong to it); the response is
 * marked `no-store`.
 */
export async function toPurchaseOrderView(c: ViewContext, row: PurchaseOrderRow, companyId: string | null) {
  noStore(c);
  const [deal, referent, people] = await Promise.all([
    dealRefs([row.dealId]),
    loadReferent(row.referentContactId, companyId),
    loadPeople(c, [row.opsManagerId]),
  ]);
  return purchaseOrderView(row, deal, people.person, referent);
}
