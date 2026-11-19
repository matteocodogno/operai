import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { codeOf, errorMessage, statusOf } from './errors'
import { strings } from '../strings'

describe('errors', () => {
  it('shows the Problem detail, else a generic line, and a network failure as such', () => {
    expect(errorMessage(new ApiError({ status: 500, title: 't', detail: 'Boom.' }))).toBe('Boom.')
    expect(errorMessage(new ApiError({ status: 500, title: 't' }))).toBe(strings.common.unknownError)
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(strings.common.networkError)
  })

  it('reads the status and the code of an ApiError only', () => {
    const error = new ApiError({ status: 403, title: 't', code: 'accounting_forbidden' })
    expect(statusOf(error)).toBe(403)
    expect(codeOf(error)).toBe('accounting_forbidden')
    expect(statusOf(new TypeError('x'))).toBeNull()
    expect(codeOf(new TypeError('x'))).toBeNull()
    expect(codeOf(new ApiError({ status: 500, title: 't' }))).toBeNull()
  })
})
