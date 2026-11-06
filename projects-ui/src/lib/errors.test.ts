import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  PROJECT_ERROR_CODES,
  PURCHASE_ORDER_REFUSALS,
  PROJECT_REFUSALS,
  TAKE_REFUSALS,
  TERMS_REFUSALS,
  codeOf,
  errorMessage,
  fieldErrorOf,
  purchaseOrderRefusalOf,
  projectRefusalOf,
  statusOf,
  takeRefusalOf,
  termsRefusalOf,
  userIdsOf,
} from './errors'

const problem = (status: number, code: string | undefined, extras: Record<string, unknown> = {}, detail = 'Why') =>
  new ApiError({ status, title: 'T', detail, ...(code ? { code } : {}), extras })

describe('errorMessage', () => {
  it('shows the Problem detail of an API error', () => {
    expect(errorMessage(problem(409, 'version_conflict'))).toBe('Why')
  })

  it('falls back to a generic line when the API gave no detail, and to the network line for anything else', () => {
    expect(errorMessage(new ApiError({ status: 500, title: 'x' }))).toBe('Something went wrong. Try again.')
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(
      'The server could not be reached. Check your connection and try again.',
    )
  })
})

describe('fieldErrorOf', () => {
  it('reads a 400 validation_failed: the dotted field and its message', () => {
    expect(
      fieldErrorOf(problem(400, 'validation_failed', { field: 'terms.sla.highDays' }, 'terms.sla.highDays: Too big')),
    ).toEqual({ field: 'terms.sla.highDays', message: 'terms.sla.highDays: Too big' })
  })

  it('reads a 422 that names a field', () => {
    expect(fieldErrorOf(problem(422, 'company_not_found', { field: 'companyId' }, 'No such company'))).toEqual({
      field: 'companyId',
      message: 'No such company',
    })
  })

  it('is null for a body-level problem (empty field), another status, or a network failure', () => {
    expect(fieldErrorOf(problem(400, 'validation_failed', { field: '' }))).toBeNull()
    expect(fieldErrorOf(problem(409, 'version_conflict', { field: 'name' }))).toBeNull()
    expect(fieldErrorOf(problem(422, 'company_required'))).toBeNull()
    expect(fieldErrorOf(new TypeError('network'))).toBeNull()
  })
})

describe('codeOf, statusOf, userIdsOf', () => {
  it('read the discriminator, the status and the refused user ids', () => {
    const error = problem(422, 'not_project_user', { userIds: ['u1', 'u2'] })
    expect(codeOf(error)).toBe('not_project_user')
    expect(statusOf(error)).toBe(422)
    expect(userIdsOf(error)).toEqual(['u1', 'u2'])
  })

  it('are null / empty for anything that is not an API error', () => {
    expect(codeOf(new TypeError('x'))).toBeNull()
    expect(statusOf(new TypeError('x'))).toBeNull()
    expect(userIdsOf(new TypeError('x'))).toEqual([])
    expect(userIdsOf(problem(422, 'not_project_user', { userIds: 'u1' }))).toEqual([])
  })
})

describe('takeRefusalOf', () => {
  it.each([
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
  ])('recognises the refusal %s of taking a deal (AC-1.11, AC-4.2, AC-3.6)', (code) => {
    expect(takeRefusalOf(problem(409, code))).toBe(code)
  })

  it.each(['not_project_user', 'contracts_not_allowed', 'project_not_open', 'company_mismatch'])(
    'no longer knows %s: a take has no project manager and attaches nothing (D39, D42)',
    (code) => {
      expect(takeRefusalOf(problem(422, code))).toBeNull()
    },
  )

  it('knows nothing of other codes, a Problem without one, or a network failure', () => {
    expect(takeRefusalOf(problem(409, 'version_conflict'))).toBeNull()
    expect(takeRefusalOf(problem(500, undefined))).toBeNull()
    expect(takeRefusalOf(new TypeError('Failed to fetch'))).toBeNull()
  })
})

describe('the refusals of the other routes', () => {
  it.each(['terms_exist', 'terms_not_allowed', 'terms_not_found', 'terms_required', 'project_not_open'])(
    'the terms routes: %s',
    (code) => {
      expect(termsRefusalOf(problem(409, code))).toBe(code)
    },
  )

  it.each(['purchase_order_not_found', 'referent_invalid', 'crm_unavailable', 'out_of_scope'])(
    'the purchase-order routes: %s',
    (code) => {
      expect(purchaseOrderRefusalOf(problem(422, code))).toBe(code)
    },
  )

  it.each([
    'not_ops_manager',
    'project_manager_required',
    'not_project_user',
    'awaiting_project_manager',
    'invalid_transition',
    'company_required',
    'company_not_allowed',
    'terms_not_allowed',
  ])('editing, picking, moving and creating a project: %s', (code) => {
    expect(projectRefusalOf(problem(409, code))).toBe(code)
  })

  it('each helper is null for a code of another group, and for a network failure', () => {
    expect(termsRefusalOf(problem(409, 'deal_taken'))).toBeNull()
    expect(purchaseOrderRefusalOf(problem(409, 'terms_exist'))).toBeNull()
    expect(projectRefusalOf(new TypeError('x'))).toBeNull()
  })
})

describe('PROJECT_ERROR_CODES carries every code of tasks.md § API contracts (T23 – T28), so no later task edits errors.ts', () => {
  // The codes as the contract names them, written out here independently of lib/errors.ts.
  const CONTRACT_CODES = [
    // common
    'forbidden',
    'out_of_scope',
    'version_conflict',
    'validation_failed',
    'authz_unavailable',
    // T23 terms, purchase order, the take
    'terms_exist',
    'terms_not_allowed',
    'terms_not_found',
    'terms_required',
    'estimated_man_days_from_estimate',
    'purchase_order_not_found',
    'deal_not_found',
    'deal_not_won',
    'deal_taken',
    'estimai_unavailable',
    'estimai_unconfigured',
    'project_not_open',
    // T24, T26 the take's rules, the referent
    'ops_manager_invalid',
    'identity_unavailable',
    'crm_unavailable',
    'referent_invalid',
    // T27 the pick, the awaiting state
    'not_ops_manager',
    'project_manager_required',
    'not_project_user',
    'awaiting_project_manager',
    'invalid_transition',
    // T28 hand-made
    'company_required',
    'company_not_allowed',
    'company_not_found',
    'maintenance_needs_sla_or_hours',
  ]

  it.each(CONTRACT_CODES)('%s', (code) => {
    expect(PROJECT_ERROR_CODES as readonly string[]).toContain(code)
  })

  it('the groups only use codes of the list', () => {
    for (const code of [...TAKE_REFUSALS, ...TERMS_REFUSALS, ...PURCHASE_ORDER_REFUSALS, ...PROJECT_REFUSALS]) {
      expect(PROJECT_ERROR_CODES as readonly string[]).toContain(code)
    }
  })
})
