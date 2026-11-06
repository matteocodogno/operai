/**
 * crm-api client for CRM companies (specs/021-projects T5, ADR-0059) and deals (specs/022 T5, ADR-0060).
 *
 * projects-api reads `GET /system/companies` as ITSELF: a 5-minute service JWT with scope
 * `crm.companies.read` (`serviceTokens`, ADR-0044/0049), never the caller's token — a
 * project-module user may hold no `crm:access` (D13), and the CRM rejects a user JWT on
 * that route anyway.
 *
 * Two ways to fail, chosen by the caller:
 *   - `searchCompanies` / `findActiveCompany` throw `CrmUnavailableError`; a route turns it into
 *     503 `crm_unavailable` (the picker, and a write that must know the company exists);
 *   - `companyRefs` FAILS SOFT: reads show `CompanyRef.name = null` rather than failing
 *     (a page of projects must not die because the CRM is down).
 *
 * Deals are read the same way (`GET /system/deals`, scope `crm.deals.read`), live, never cached or
 * synced: `wonDeals()` (the to-start queue's source) and `dealsById(ids)` (a purchase order's deal) throw
 * `CrmUnavailableError`; the route decides between a 503 and degrading to unknown.
 *
 * Contacts (specs/022 T24, scope `crm.contacts.read`) are read the same way and are personal data of a
 * third party: `companyContacts(companyId)` for the referent picker, `contactsById(ids)` for the checks,
 * `assertValidReferent(id, companyId)` for a referent being set. Never cached, never stored.
 *
 * Nothing here logs a token or a response body.
 */

import { env } from "./env";
import { ProblemError } from "./problem";
import { serviceTokens } from "./serviceToken";

export interface CrmCompany {
  readonly id: string;
  readonly name: string;
  readonly entity: "welld_ch" | "welld_it";
  readonly archived: boolean;
}

/** `{ id, name }`; `name` is `null` when the CRM cannot answer or no longer knows the company. */
export interface CompanyRef {
  readonly id: string;
  readonly name: string | null;
}

const REQUEST_TIMEOUT_MS = 5_000;
/** crm-api's cap on `ids`; keep in sync (tasks.md § API contracts). */
const MAX_IDS_PER_REQUEST = 100;
/** The picker's page: crm-api's own default. */
const PICKER_LIMIT = 20;

export class CrmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmUnavailableError";
  }
}

/** The 503 a route answers when a company lookup it cannot do without fails. */
export const crmUnavailable = (): ProblemError =>
  new ProblemError({
    status: 503,
    code: "crm_unavailable",
    detail: "The CRM is unavailable; companies could not be looked up",
  });

/** The crm-api `/system/*` read `path` with `params`, as the service principal; the parsed body. */
async function crmGet(path: string, params: URLSearchParams): Promise<{ items?: unknown; truncated?: unknown }> {
  if (!serviceTokens || !env.CRM_INTERNAL_URL) {
    throw new CrmUnavailableError("the crm-api service credential is not configured");
  }
  let token: string;
  try {
    token = await serviceTokens.getToken();
  } catch (error) {
    throw new CrmUnavailableError(error instanceof Error ? error.message : "no service token");
  }
  let res: Response;
  try {
    res = await fetch(`${env.CRM_INTERNAL_URL}${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CrmUnavailableError(`crm-api request failed (${error instanceof Error ? error.name : "unknown error"})`);
  }
  // crm-api answers every credential failure with one 401: drop the token so the next call mints a fresh one.
  if (res.status === 401) serviceTokens.invalidate(token);
  if (!res.ok) throw new CrmUnavailableError(`crm-api GET ${path} responded with HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { items?: unknown; truncated?: unknown } | null;
  if (!Array.isArray(body?.items)) throw new CrmUnavailableError("crm-api returned an unreadable body");
  return body;
}

async function fetchCompanies(params: URLSearchParams): Promise<CrmCompany[]> {
  return (await crmGet("/system/companies", params)).items as CrmCompany[];
}

/** Active (non-archived) companies whose name contains `q`, by name — the company picker. */
export function searchCompanies(q: string | undefined): Promise<CrmCompany[]> {
  const params = new URLSearchParams({ limit: String(PICKER_LIMIT) });
  if (q?.trim()) params.set("q", q.trim());
  return fetchCompanies(params);
}

/** The companies with these ids (archived included), keyed by id; unknown ids are absent. */
export async function companiesById(ids: readonly string[]): Promise<Map<string, CrmCompany>> {
  const distinct = [...new Set(ids)];
  const found = new Map<string, CrmCompany>();
  for (let i = 0; i < distinct.length; i += MAX_IDS_PER_REQUEST) {
    const batch = distinct.slice(i, i + MAX_IDS_PER_REQUEST);
    for (const company of await fetchCompanies(new URLSearchParams({ ids: batch.join(",") }))) {
      found.set(company.id, company);
    }
  }
  return found;
}

/** The company, when it exists and is not archived (what a new project may point at); else `null`. */
export async function findActiveCompany(id: string): Promise<CrmCompany | null> {
  const company = (await companiesById([id])).get(id);
  return company && !company.archived ? company : null;
}

/**
 * A lookup that never misses, for reads: a `CompanyRef` per id, `name: null` when the CRM
 * cannot answer or does not know the id (fail soft, tasks.md § API contracts).
 */
export async function companyRefs(ids: readonly (string | null | undefined)[]): Promise<(id: string) => CompanyRef> {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id !== "");
  let found = new Map<string, CrmCompany>();
  if (wanted.length > 0) {
    try {
      found = await companiesById(wanted);
    } catch (error) {
      console.error(
        "[crm] could not resolve company names — degrading them to null:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return (id) => ({ id, name: found.get(id)?.name ?? null });
}

/**
 * Runs a lookup a route cannot do without: a CRM failure becomes the 503 `crm_unavailable`
 * problem. (Reads that can degrade use `companyRefs` instead.)
 */
export async function orCrmUnavailable<T>(lookup: Promise<T>): Promise<T> {
  try {
    return await lookup;
  } catch (error) {
    if (!(error instanceof CrmUnavailableError)) throw error;
    console.error("[crm] lookup failed:", error.message);
    throw crmUnavailable();
  }
}

// ─── Deals (specs/022) ───────────────────────────────────────────────────────

export type CrmDealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

/**
 * crm-api's `DealSummary`. It carries no amount, currency, owner or notes, and projects-api never
 * asks for them (D14). `wonAt` is the win date while the stage is `won`, else `null`.
 */
export interface CrmDeal {
  readonly id: string;
  readonly title: string;
  readonly stage: CrmDealStage;
  readonly entity: "welld_ch" | "welld_it";
  readonly company: { readonly id: string; readonly name: string };
  readonly wonAt: string | null;
  readonly estimate: { readonly id: string; readonly name: string } | null;
}

/**
 * The won deals, newest win first (crm-api caps the list at 500 and says so with `truncated`).
 * The queue subtracts the deals that already have a purchase order itself.
 */
export async function wonDeals(): Promise<{ items: CrmDeal[]; truncated: boolean }> {
  const body = await crmGet("/system/deals", new URLSearchParams({ stage: "won" }));
  return { items: body.items as CrmDeal[], truncated: body.truncated === true };
}

/** The deals with these ids, in any stage, keyed by id; unknown ids are absent. */
export async function dealsById(ids: readonly string[]): Promise<Map<string, CrmDeal>> {
  const distinct = [...new Set(ids)];
  const found = new Map<string, CrmDeal>();
  for (let i = 0; i < distinct.length; i += MAX_IDS_PER_REQUEST) {
    const batch = distinct.slice(i, i + MAX_IDS_PER_REQUEST);
    const body = await crmGet("/system/deals", new URLSearchParams({ ids: batch.join(",") }));
    for (const deal of body.items as CrmDeal[]) found.set(deal.id, deal);
  }
  return found;
}

// ─── Contacts (specs/022 T24; T18 M1, M3, L1, L3) ────────────────────────────

/**
 * The CRM contacts of a purchase order's company, read as the service principal (`crm.contacts.read`,
 * `GET /system/contacts`). A contact is PERSONAL DATA of a third party, so nothing here is cached or
 * stored (D49, T18 M5): every call asks the CRM again, and a caller keeps what it reads for the length
 * of one request. Each member is picked by name, never spread, so a field the CRM adds later cannot
 * reach a response.
 */

/** A contact as the picker lists it: no email, phone, company or archived flag (T18 M2). */
export interface ContactChoice {
  readonly id: string;
  readonly name: string;
  readonly jobTitle: string | null;
}

/** crm-api's `ids` mode for one contact: what the referent shows and what the checks read. */
export interface CrmContact {
  readonly id: string;
  readonly companyId: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly archived: boolean;
}

/** crm-api's cap on `ids` for `GET /system/contacts`; keep in sync (tasks.md § API contracts, T21). */
const MAX_CONTACT_IDS_PER_REQUEST = 20;
/** What a contact id may look like (T18 L1): the CRM's cuids, and nothing that could split or alter the `ids` list. */
const CONTACT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
/** A contact's display name: first then last, trimmed (a contact lacking one of them shows the other). */
export const contactName = (contact: { readonly firstName: string; readonly lastName: string }): string =>
  `${contact.firstName} ${contact.lastName}`.trim();
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The non-archived contacts of `companyId` (crm-api's `companyId` mode: at most 500, by last then first name). */
export async function companyContacts(companyId: string): Promise<{ items: ContactChoice[]; truncated: boolean }> {
  const body = await crmGet("/system/contacts", new URLSearchParams({ companyId }));
  const items = (body.items as Record<string, unknown>[]).map((raw) => ({
    id: text(raw["id"]),
    name: contactName({ firstName: text(raw["firstName"]), lastName: text(raw["lastName"]) }),
    jobTitle: textOrNull(raw["jobTitle"]),
  }));
  return { items, truncated: body.truncated === true };
}

/** The contacts with these ids (archived included), keyed by id; unknown or erased ids are absent. */
export async function contactsById(ids: readonly string[]): Promise<Map<string, CrmContact>> {
  const distinct = [...new Set(ids)];
  const found = new Map<string, CrmContact>();
  for (let i = 0; i < distinct.length; i += MAX_CONTACT_IDS_PER_REQUEST) {
    const batch = distinct.slice(i, i + MAX_CONTACT_IDS_PER_REQUEST);
    const body = await crmGet("/system/contacts", new URLSearchParams({ ids: batch.join(",") }));
    for (const raw of body.items as Record<string, unknown>[]) {
      const id = text(raw["id"]);
      if (id === "") continue;
      found.set(id, {
        id,
        companyId: textOrNull(raw["companyId"]),
        firstName: text(raw["firstName"]),
        lastName: text(raw["lastName"]),
        jobTitle: textOrNull(raw["jobTitle"]),
        email: textOrNull(raw["email"]),
        phone: textOrNull(raw["phone"]),
        archived: raw["archived"] === true,
      });
    }
  }
  return found;
}

/**
 * The one refusal for a referent that cannot be used (AC-3.6, T18 L1): unknown, of another company, with
 * no company, archived, or an id that is not even shaped like one. Always this body, with no extras:
 * it never says which, and never echoes the id, a name or a company.
 */
export const referentInvalid = (): ProblemError =>
  new ProblemError({
    status: 422,
    code: "referent_invalid",
    detail: "The referent must be a current contact of this company",
  });

/**
 * 422 `referent_invalid` unless `contactId` is a non-archived CRM contact of `companyId` (T18 M3): the
 * item whose id equals it EXACTLY, with that company (the live deal's, or the project's; derived by the
 * server, never from a request body). crm-api down is a 503 `crm_unavailable`, not a refusal.
 */
export async function assertValidReferent(contactId: string, companyId: string): Promise<void> {
  if (!CONTACT_ID.test(contactId)) throw referentInvalid();
  const contact = (await orCrmUnavailable(contactsById([contactId]))).get(contactId);
  if (!contact || contact.companyId !== companyId || contact.archived) throw referentInvalid();
}
