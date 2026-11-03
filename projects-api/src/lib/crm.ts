/**
 * crm-api client for CRM companies (specs/021-projects T5, ADR-0059).
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

async function fetchCompanies(params: URLSearchParams): Promise<CrmCompany[]> {
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
    res = await fetch(`${env.CRM_INTERNAL_URL}/system/companies?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CrmUnavailableError(`crm-api request failed (${error instanceof Error ? error.name : "unknown error"})`);
  }
  // crm-api answers every credential failure with one 401: drop the token so the next call mints a fresh one.
  if (res.status === 401) serviceTokens.invalidate(token);
  if (!res.ok) throw new CrmUnavailableError(`crm-api GET /system/companies responded with HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) throw new CrmUnavailableError("crm-api returned an unreadable body");
  return body.items as CrmCompany[];
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
