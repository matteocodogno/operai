import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import {
  HOURS_ERROR_CODES,
  HoursApiError,
  codeOf,
  errorFromResponse,
  errorMessage,
  isCode,
  statusOf,
  type HoursErrorCode,
} from './errors'

/** A Problem JSON answer (RFC 7807) as hours-api sends it. */
const problem = (status: number, body: Record<string, unknown>, init: ResponseInit = {}) =>
  new Response(JSON.stringify({ type: 'about:blank', title: `Problem ${status}`, status, ...body }), {
    status,
    ...init,
  })

/**
 * plan § API contracts › Errors (entries and totals) and § Lists, one row each: the status and the
 * `code` hours-api answers. Written out here, not read from the module, so a code added to the plan
 * and forgotten in the UI (or the other way round) fails.
 */
const PLAN_CODES: [number, HoursErrorCode][] = [
  [400, 'invalid_request'],
  [422, 'invalid_minutes'],
  [422, 'future_day'],
  [422, 'note_too_long'],
  [422, 'note_required'],
  [422, 'category_not_found'],
  [422, 'category_retired'],
  [422, 'work_type_not_allowed'],
  [422, 'work_type_not_found'],
  [422, 'work_type_retired'],
  [422, 'activity_not_allowed'],
  [403, 'not_on_project'],
  [403, 'not_involved_in_deal'],
  [403, 'owner_only'],
  [403, 'read_all_required'],
  [404, 'not_found'],
  [503, 'host_unavailable'],
  [503, 'authz_unavailable'],
  [403, 'time_list_manage_required'],
  [409, 'name_taken'],
]

describe('errorFromResponse: each Problem `code` of the plan becomes a typed error', () => {
  it.each(PLAN_CODES)('%i %s', async (status, code) => {
    const error = await errorFromResponse(problem(status, { code, detail: `about ${code}` }))
    expect(error).toBeInstanceOf(HoursApiError)
    expect(error.status).toBe(status)
    expect(error.code).toBe(code)
    expect(error.detail).toBe(`about ${code}`)
  })

  it('knows exactly the codes of the plan, no more and no fewer', () => {
    expect([...HOURS_ERROR_CODES].sort()).toEqual(PLAN_CODES.map(([, code]) => code).sort())
  })

  it('keeps a code it does not know as `rawCode`, with a null typed code', async () => {
    const error = await errorFromResponse(problem(422, { code: 'something_new' }))
    expect(error.code).toBeNull()
    expect(error.rawCode).toBe('something_new')
    expect(error.status).toBe(422)
  })

  it('an answer without a code has neither', async () => {
    const error = await errorFromResponse(problem(500, {}))
    expect(error.code).toBeNull()
    expect(error.rawCode).toBeNull()
  })

  it('an answer that is not JSON falls back to the HTTP status', async () => {
    const error = await errorFromResponse(
      new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    )
    expect(error.status).toBe(502)
    expect(error.code).toBeNull()
    expect(error.title).toBe('Bad Gateway')
  })

  it('an answer that is JSON but not an object falls back too', async () => {
    const error = await errorFromResponse(new Response('[1,2]', { status: 503 }))
    expect(error.status).toBe(503)
    expect(error.code).toBeNull()
  })

  it('a code that is not a string is not a code', async () => {
    const error = await errorFromResponse(problem(422, { code: 42 }))
    expect(error.code).toBeNull()
    expect(error.rawCode).toBeNull()
  })

  it('keeps the members a screen may need (e.g. which field) apart from the standard ones', async () => {
    const error = await errorFromResponse(problem(422, { code: 'invalid_minutes', field: 'minutes' }))
    expect(error.extras).toEqual({ field: 'minutes' })
  })
})

describe('predicates', () => {
  const hostDown = new HoursApiError({ status: 503, title: 'x', rawCode: 'host_unavailable' })

  it('statusOf and codeOf read an HoursApiError, and nothing else', () => {
    expect(statusOf(hostDown)).toBe(503)
    expect(codeOf(hostDown)).toBe('host_unavailable')
    expect(statusOf(new TypeError('Failed to fetch'))).toBeNull()
    expect(codeOf(new TypeError('Failed to fetch'))).toBeNull()
    expect(statusOf(undefined)).toBeNull()
  })

  it('isCode matches one of the named codes only', () => {
    expect(isCode(hostDown, 'host_unavailable')).toBe(true)
    expect(isCode(hostDown, 'authz_unavailable', 'host_unavailable')).toBe(true)
    expect(isCode(hostDown, 'authz_unavailable')).toBe(false)
    expect(isCode(new TypeError('Failed to fetch'), 'host_unavailable')).toBe(false)
  })

  it('a 503 with an unknown code is not a `host_unavailable`', () => {
    const other = new HoursApiError({ status: 503, title: 'x', rawCode: 'brand_new' })
    expect(isCode(other, 'host_unavailable')).toBe(false)
  })
})

describe('errorMessage', () => {
  it('is the Problem detail when there is one', () => {
    expect(errorMessage(new HoursApiError({ status: 422, title: 't', detail: 'Day is in the future' }))).toBe(
      'Day is in the future',
    )
  })

  it('is the generic line for a Problem without detail', () => {
    expect(errorMessage(new HoursApiError({ status: 500, title: 't' }))).toBe(strings.common.unknownError)
  })

  it('is the network line for anything that is not a Problem (a fetch that did not reach the server)', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(strings.common.networkError)
  })
})
