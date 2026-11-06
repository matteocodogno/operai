import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { codeOf, errorMessage, fieldErrorOf, statusOf, userIdsOf } from './errors'

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
