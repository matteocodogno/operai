import { ApiError } from './api'
import { strings } from '../strings'

/** The message to show for a failed request: the Problem `detail`, else a generic line. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? strings.common.unknownError
  return strings.common.networkError
}

export const statusOf = (error: unknown): number | null => (error instanceof ApiError ? error.status : null)

/** The Problem `code` of a failed request, or null. */
export const codeOf = (error: unknown): string | null => (error instanceof ApiError ? (error.code ?? null) : null)

/**
 * A refusal that names a field: a 400 `validation_failed` or a 422, carrying a
 * `field` extension member (dotted for nested ones, e.g. `terms.sla.highDays`).
 * An empty `field` is a problem with the body as a whole, not with one input.
 */
export function fieldErrorOf(error: unknown): { field: string; message: string } | null {
  if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 422)) return null
  const field = error.extras['field']
  return typeof field === 'string' && field !== ''
    ? { field, message: error.detail ?? strings.common.validation.fixErrors }
    : null
}

/** The ids a 422 `not_project_user` refuses (a PM or team member without access, specs/021 AC-1.6). */
export function userIdsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return []
  const ids = error.extras['userIds']
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/**
 * Every Problem `code` of projects-api's routes that the UI knows (specs/021, and specs/022
 * tasks.md § API contracts T23–T28). One list so that no task edits this file to learn a code;
 * each group below picks the ones a screen words itself.
 */
export const PROJECT_ERROR_CODES = [
  // common
  'forbidden',
  'out_of_scope',
  'version_conflict',
  'validation_failed',
  'authz_unavailable',
  // terms (T23)
  'terms_exist',
  'terms_not_allowed',
  'terms_not_found',
  'terms_required',
  'estimated_man_days_from_estimate',
  'maintenance_needs_sla_or_hours',
  'project_not_open',
  // the purchase order (T23, T26)
  'purchase_order_not_found',
  'referent_invalid',
  // taking a deal (T23, T24)
  'deal_not_found',
  'deal_not_won',
  'deal_taken',
  'ops_manager_invalid',
  'estimai_unavailable',
  'estimai_unconfigured',
  // the services behind projects-api
  'crm_unavailable',
  'identity_unavailable',
  // the project-manager pick and the awaiting state (T27)
  'not_ops_manager',
  'project_manager_required',
  'not_project_user',
  'awaiting_project_manager',
  'invalid_transition',
  // creating a project by hand (T28, specs/021)
  'company_required',
  'company_not_allowed',
  'company_not_found',
] as const
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number]

/** The code of `error` when it is one of `known`, else null. */
function refusalIn<const Known extends readonly ProjectErrorCode[]>(
  known: Known,
  error: unknown,
): Known[number] | null {
  const code = codeOf(error)
  return known.find((candidate) => candidate === code) ?? null
}

/**
 * The refusals of taking a deal (`POST /queue/{dealId}/project`, and the reads behind its form)
 * that the UI words itself, each with its own message under `strings.queue.take.errors`
 * (AC-1.11, AC-4.2, AC-3.6). The server's `detail` is the fallback for any other failure.
 * `referent_invalid` is one message for every reason, never echoing an id, name or company (T18).
 */
export const TAKE_REFUSALS = [
  'deal_not_found',
  'deal_not_won',
  'deal_taken',
  'out_of_scope',
  'forbidden',
  'ops_manager_invalid',
  'referent_invalid',
  'identity_unavailable',
  'estimated_man_days_from_estimate',
  'crm_unavailable',
  'estimai_unavailable',
  'estimai_unconfigured',
] as const satisfies readonly ProjectErrorCode[]
export type TakeRefusal = (typeof TAKE_REFUSALS)[number]

/** The refusal of a take that has its own message, or null. */
export const takeRefusalOf = (error: unknown): TakeRefusal | null => refusalIn(TAKE_REFUSALS, error)

/** The refusals of the terms routes (`POST` / `PATCH` / `DELETE /projects/{id}/terms`), each worded under `strings.terms.errors`. */
export const TERMS_REFUSALS = [
  'terms_exist',
  'terms_not_allowed',
  'terms_not_found',
  'terms_required',
  'project_not_open',
  'maintenance_needs_sla_or_hours',
  'estimated_man_days_from_estimate',
  'crm_unavailable',
  'out_of_scope',
] as const satisfies readonly ProjectErrorCode[]
export type TermsRefusal = (typeof TERMS_REFUSALS)[number]
export const termsRefusalOf = (error: unknown): TermsRefusal | null => refusalIn(TERMS_REFUSALS, error)

/** The refusals of the purchase-order routes: the referent and its candidates, the Bexio order id. */
export const PURCHASE_ORDER_REFUSALS = [
  'purchase_order_not_found',
  'referent_invalid',
  'crm_unavailable',
  'out_of_scope',
] as const satisfies readonly ProjectErrorCode[]
export type PurchaseOrderRefusal = (typeof PURCHASE_ORDER_REFUSALS)[number]
export const purchaseOrderRefusalOf = (error: unknown): PurchaseOrderRefusal | null =>
  refusalIn(PURCHASE_ORDER_REFUSALS, error)

/** The refusals of creating, editing, moving a project and of picking its project manager. */
export const PROJECT_REFUSALS = [
  'invalid_transition',
  'awaiting_project_manager',
  'not_ops_manager',
  'project_manager_required',
  'not_project_user',
  'company_required',
  'company_not_allowed',
  'company_not_found',
  'terms_not_allowed',
  'identity_unavailable',
  'crm_unavailable',
  'out_of_scope',
] as const satisfies readonly ProjectErrorCode[]
export type ProjectRefusal = (typeof PROJECT_REFUSALS)[number]
export const projectRefusalOf = (error: unknown): ProjectRefusal | null => refusalIn(PROJECT_REFUSALS, error)
