import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, it as italian } from '../strings'
import { ApiError } from './api'
import { codeOf, describeFailure, errorMessage, fieldErrorsOf, isAuthUnavailable, statusOf } from './errors'

const problem = (status: number, code?: string, extras: Record<string, unknown> = {}, detail?: string) =>
  new ApiError({ status, title: 'Problem', code, detail, extras })

/**
 * Every problem `code` the plan's API contracts and design.md § S11 name. S11 is parsed from the
 * design (so a code added there without a message fails here); the rest are the codes the plan
 * names outside that list.
 */
const DESIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../specs/021-meetings/design.md')
const designCodes = (): string[] => {
  const text = readFileSync(DESIGN, 'utf-8')
  // The code list is the first paragraph; the paragraph after it mentions `lib/errors.ts` and other tokens.
  const section = /### S11\.[\s\S]*?Unknown codes/.exec(text)?.[0] ?? ''
  // `code` is the heading's own word and `reason` the extension member that qualifies `upload_rejected`.
  const notCodes = new Set(['code', 'reason'])
  return [...section.matchAll(/`([a-z][a-z_]+)`/g)].map((match) => match[1]!).filter((code) => !notCodes.has(code))
}
// Named in plan.md outside S11: AC-2.11's `interrupted` and the 404 body.
const PLAN_EXTRA_CODES = ['interrupted', 'not_found']

describe('problem codes have a message in both languages (exhaustiveness)', () => {
  it.skipIf(!existsSync(DESIGN))('design.md § S11 lists the codes this test then checks', () => {
    expect(designCodes().length).toBeGreaterThanOrEqual(39)
  })

  it.skipIf(!existsSync(DESIGN))('every code of design.md § S11 has an English and an Italian message', () => {
    for (const code of designCodes()) {
      expect(en.common.errors, code).toHaveProperty(code)
      expect(italian.common.errors, code).toHaveProperty(code)
    }
  })

  it.each(PLAN_EXTRA_CODES)('the plan code %s has a message too', (code) => {
    expect(en.common.errors).toHaveProperty(code)
    expect(italian.common.errors).toHaveProperty(code)
  })

  it('has no orphan message: every key is a code the plan or the design names', () => {
    const known = new Set([
      ...(existsSync(DESIGN) ? designCodes() : Object.keys(en.common.errors)),
      ...PLAN_EXTRA_CODES,
    ])
    for (const key of Object.keys(en.common.errors)) expect(known.has(key), key).toBe(true)
  })

  it('every message is a non-empty sentence in both languages', () => {
    for (const [code, message] of Object.entries(en.common.errors)) {
      expect(message.trim(), code).not.toBe('')
      expect(italian.common.errors[code as keyof typeof en.common.errors].trim(), code).not.toBe('')
    }
  })
})

describe('errorMessage', () => {
  it('a known code gives its catalog message, not the server detail (the catalog is localised)', () => {
    expect(errorMessage(problem(409, 'summary_limit', {}, 'Too many'))).toBe(en.common.errors.summary_limit)
  })

  it('an unknown code falls back to the Problem detail', () => {
    expect(errorMessage(problem(500, 'brand_new_code', {}, 'The server said this'))).toBe('The server said this')
  })

  it('no code and no detail gives the generic line', () => {
    expect(errorMessage(problem(500))).toBe(en.common.unknownError)
  })

  it('a non-ApiError (the network) gives the network line', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(en.common.networkError)
  })

  it('does not treat an Object prototype key as a code', () => {
    expect(errorMessage(problem(400, 'constructor', {}, 'fallback'))).toBe('fallback')
    expect(errorMessage(problem(400, 'toString', {}, 'fallback'))).toBe('fallback')
  })
})

describe('statusOf and codeOf', () => {
  it('read an ApiError and return null for anything else', () => {
    expect(statusOf(problem(404))).toBe(404)
    expect(codeOf(problem(409, 'frozen'))).toBe('frozen')
    expect(statusOf(new Error('x'))).toBeNull()
    expect(codeOf(undefined)).toBeNull()
    expect(codeOf(problem(500))).toBeNull()
  })
})

describe('isAuthUnavailable (AC-10.6)', () => {
  it('is a 503 with no code of its own', () => {
    expect(isAuthUnavailable(problem(503))).toBe(true)
  })

  it.each(['storage_unavailable', 'host_unavailable', 'identity_unavailable'])(
    'is NOT a 503 %s: those have their own message and keep the dialog open',
    (code) => {
      expect(isAuthUnavailable(problem(503, code))).toBe(false)
    },
  )

  it('is not a 502 or a 500', () => {
    expect(isAuthUnavailable(problem(502))).toBe(false)
    expect(isAuthUnavailable(problem(500))).toBe(false)
  })
})

describe('describeFailure (the LoadFailure states)', () => {
  it('404 is the not-found state', () => {
    expect(describeFailure(problem(404, 'not_found')).kind).toBe('notFound')
  })

  it('403 is the permission-denied state', () => {
    expect(describeFailure(problem(403)).kind).toBe('forbidden')
  })

  it.each(['frozen', 'creator_only', 'meetings_access_required', 'author_only', 'builtin_readonly'])(
    'a 403 %s means the person CAN open the page: an inline refusal, not a replaced page (AC-5.8)',
    (code) => {
      const failure = describeFailure(problem(403, code))
      expect(failure.kind).toBe('refused')
      expect(failure.message).toBe(en.common.errors[code as keyof typeof en.common.errors])
    },
  )

  it('503 without a code is the authorization-unavailable banner', () => {
    expect(describeFailure(problem(503)).kind).toBe('authUnavailable')
  })

  it('anything else is a retryable failure carrying its message', () => {
    expect(describeFailure(problem(500, undefined, {}, 'Boom'))).toEqual({ kind: 'other', message: 'Boom' })
    expect(describeFailure(new TypeError('x')).kind).toBe('other')
  })
})

describe('fieldErrorsOf (AC-1.3 names every invalid field)', () => {
  it('reads an errors[] list of {field, message}', () => {
    const error = problem(422, 'validation', {
      field: 'title',
      errors: [
        { field: 'title', message: 'Required' },
        { field: 'startsAt', message: 'Not a date' },
      ],
    })
    expect(fieldErrorsOf(error)).toEqual([
      { field: 'title', message: 'Required' },
      { field: 'startsAt', message: 'Not a date' },
    ])
  })

  it('falls back to the single `field` with the Problem detail', () => {
    expect(fieldErrorsOf(problem(422, undefined, { field: 'title' }, 'Too long'))).toEqual([
      { field: 'title', message: 'Too long' },
    ])
  })

  it('a single `field` with no detail gets the generic "fix the fields" line', () => {
    expect(fieldErrorsOf(problem(422, undefined, { field: 'title' }))).toEqual([
      { field: 'title', message: en.common.fixErrors },
    ])
  })

  it('skips malformed entries instead of throwing', () => {
    const error = problem(422, undefined, { errors: [null, 'x', { field: 3 }, { field: 'title', message: 'Bad' }] })
    expect(fieldErrorsOf(error)).toEqual([{ field: 'title', message: 'Bad' }])
  })

  it('is empty for a non-422 and for a non-ApiError', () => {
    expect(fieldErrorsOf(problem(409, undefined, { field: 'title' }))).toEqual([])
    expect(fieldErrorsOf(new Error('x'))).toEqual([])
  })

  it('is empty for a 422 that names no field (a host or participant error is handled by its code)', () => {
    expect(fieldErrorsOf(problem(422, 'host_entity_not_found'))).toEqual([])
  })
})
