/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/collaboratorsApi.ts — typed API client for the five
 * `/estimates/:id/collaborators…` endpoints (T15, specs/013-estimate-sharing/
 * tasks.md).
 *
 * Strategy (mirrors estimatesApi.test.ts's established pattern):
 *   • `apiFetch` is mocked at the module level so tests control the raw
 *     Response objects and inspect the exact method/URL/body sent.
 *   • Every operation is tested for correct HTTP method + URL + body, and a
 *     successful response parsed to the typed shape.
 *   • The done-when's central claim — "each collaborator-endpoint error code
 *     maps to its own typed error" — gets one test per named `code` in
 *     plan.md's contract table, asserting the exact subclass via `instanceof`
 *     (not just `status`, which several codes share, e.g. two different 422s).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AlreadyCollaboratorError,
  AuthorizationServiceUnavailableError,
  CannotShareWithSelfError,
  CollaboratorNotEligibleError,
  InvalidInputError,
  NotACollaboratorError,
  OwnerOnlyError,
  RateLimitedError,
  add,
  leave,
  list,
  remove,
  updateLevel,
} from './collaboratorsApi'
import type { CollaboratorGrant } from './collaboratorsApi'
import { ApiError } from './estimatesApi'

// ---------------------------------------------------------------------------
// Module mock — apiFetch is replaced with a vi.fn() for all tests.
// ---------------------------------------------------------------------------

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from './api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'http://api.test'
const ESTIMATE_ID = 'est-001'
const COLLABORATORS_URL = `${API_URL}/estimates/${ESTIMATE_ID}/collaborators`

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixedGrant: CollaboratorGrant = {
  id: 'grant-001',
  email: 'colleague@welld.ch',
  accessLevel: 'viewer',
  createdAt: '2026-08-07T09:00:00.000Z',
  identity: { status: 'active', name: 'Marco Rossi' },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResponse = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const okResponse = (body: unknown, status = 200): Response => makeResponse(status, body)

const problemResponse = (
  status: number,
  code: string,
  detail?: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response =>
  makeResponse(
    status,
    {
      type: `https://httpstatuses.com/${status}`,
      title: 'Error',
      status,
      detail,
      instance: `/estimates/${ESTIMATE_ID}/collaborators`,
      code,
      ...extra,
    },
    headers,
  )

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const mockFn = vi.mocked(apiFetch)
  const calls = mockFn.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const [input, init] = calls[calls.length - 1]
  return { url: String(input), init }
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('list(estimateId)', () => {
  it('issues GET to /estimates/:id/collaborators (no body) and unwraps { collaborators }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ collaborators: [fixedGrant] }))

    const result = await list(ESTIMATE_ID)

    const { url, init } = lastCall()
    expect(url).toBe(COLLABORATORS_URL)
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(result).toEqual([fixedGrant])
  })

  it('returns [] when the estimate has no collaborators', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ collaborators: [] }))
    expect(await list(ESTIMATE_ID)).toEqual([])
  })

  it('throws OwnerOnlyError on 403 code:"owner_only" (list is owner-only — collaborators never see each other)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'owner_only'))

    let thrown: unknown
    try {
      await list(ESTIMATE_ID)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(OwnerOnlyError)
    expect(thrown).toBeInstanceOf(ApiError)
  })

  it('throws the base ApiError on a code-less 404 (no relationship)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(404, { title: 'Not Found', status: 404 }))

    let thrown: unknown
    try {
      await list(ESTIMATE_ID)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).not.toBeInstanceOf(OwnerOnlyError)
    expect((thrown as ApiError).status).toBe(404)
    expect((thrown as ApiError).code).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// add()
// ---------------------------------------------------------------------------

describe('add(estimateId, request)', () => {
  it('issues POST with { email, accessLevel } and returns the created grant (201)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedGrant, 201))

    const result = await add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'viewer' })

    const { url, init } = lastCall()
    expect(url).toBe(COLLABORATORS_URL)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'colleague@welld.ch', accessLevel: 'viewer' })
    expect(result).toEqual(fixedGrant)
  })

  it('throws InvalidInputError on 400 code:"invalid_input"', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(400, 'invalid_input', 'Malformed email'))
    await expect(add(ESTIMATE_ID, { email: 'not-an-email', accessLevel: 'viewer' })).rejects.toBeInstanceOf(
      InvalidInputError,
    )
  })

  it('throws OwnerOnlyError on 403 code:"owner_only" (AC-1.5 — a collaborator cannot add another)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'owner_only'))
    await expect(add(ESTIMATE_ID, { email: 'x@welld.ch', accessLevel: 'editor' })).rejects.toBeInstanceOf(
      OwnerOnlyError,
    )
  })

  it('throws AlreadyCollaboratorError on 409 code:"already_collaborator" (AC-1.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(409, 'already_collaborator', 'Already a collaborator (viewer). Use PATCH instead.'),
    )

    let thrown: unknown
    try {
      await add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'editor' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AlreadyCollaboratorError)
    expect((thrown as ApiError).detail).toContain('Use PATCH instead')
  })

  it('throws CannotShareWithSelfError on 422 code:"cannot_share_with_self" (AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'cannot_share_with_self'))
    await expect(add(ESTIMATE_ID, { email: 'me@welld.ch', accessLevel: 'viewer' })).rejects.toBeInstanceOf(
      CannotShareWithSelfError,
    )
  })

  it('throws CollaboratorNotEligibleError on 422 code:"collaborator_not_eligible" (AC-1.2, the one fixed generic rejection)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(
        422,
        'collaborator_not_eligible',
        "That address can't be added as a collaborator. Collaborators must be Operai users who already have EstimAI access.",
      ),
    )

    let thrown: unknown
    try {
      await add(ESTIMATE_ID, { email: 'stranger@example.com', accessLevel: 'viewer' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CollaboratorNotEligibleError)
    expect(thrown).not.toBeInstanceOf(CannotShareWithSelfError)
    expect((thrown as ApiError).detail).toBe(
      "That address can't be added as a collaborator. Collaborators must be Operai users who already have EstimAI access.",
    )
  })

  it('distinguishes the two different 422s by class, not just status (both share status:422)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'cannot_share_with_self'))
    const selfErr = await add(ESTIMATE_ID, { email: 'me@welld.ch', accessLevel: 'viewer' }).catch(
      (e: unknown) => e,
    )

    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'collaborator_not_eligible'))
    const notEligibleErr = await add(ESTIMATE_ID, { email: 'stranger@example.com', accessLevel: 'viewer' }).catch(
      (e: unknown) => e,
    )

    expect((selfErr as ApiError).status).toBe((notEligibleErr as ApiError).status)
    expect(selfErr).toBeInstanceOf(CannotShareWithSelfError)
    expect(selfErr).not.toBeInstanceOf(CollaboratorNotEligibleError)
    expect(notEligibleErr).toBeInstanceOf(CollaboratorNotEligibleError)
    expect(notEligibleErr).not.toBeInstanceOf(CannotShareWithSelfError)
  })

  it('throws RateLimitedError on 429 code:"rate_limited", carrying retryAfterSeconds from the header', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(429, 'rate_limited', 'Too many attempts.', {}, { 'Retry-After': '30' }))

    let thrown: unknown
    try {
      await add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'viewer' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RateLimitedError)
    expect((thrown as RateLimitedError).retryAfterSeconds).toBe(30)
  })

  it('RateLimitedError.retryAfterSeconds is undefined when the header is absent', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(429, 'rate_limited'))

    let thrown: unknown
    try {
      await add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'viewer' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RateLimitedError)
    expect((thrown as RateLimitedError).retryAfterSeconds).toBeUndefined()
  })

  it('throws AuthorizationServiceUnavailableError on 503 code:"authorization_service_unavailable" (auth outage fails closed)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(503, 'authorization_service_unavailable'))
    await expect(add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'viewer' })).rejects.toBeInstanceOf(
      AuthorizationServiceUnavailableError,
    )
  })

  it('sends POST to the base collaborators URL — a nested path would fail this assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedGrant, 201))
    await add(ESTIMATE_ID, { email: 'colleague@welld.ch', accessLevel: 'editor' })
    expect(lastCall().url).toBe(COLLABORATORS_URL)
    expect(lastCall().init?.method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// updateLevel()
// ---------------------------------------------------------------------------

describe('updateLevel(estimateId, collaboratorId, request)', () => {
  it('issues PATCH to /collaborators/:collaboratorId with { accessLevel } and returns the updated grant', async () => {
    const updated: CollaboratorGrant = { ...fixedGrant, accessLevel: 'editor' }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(updated))

    const result = await updateLevel(ESTIMATE_ID, 'grant-001', { accessLevel: 'editor' })

    const { url, init } = lastCall()
    expect(url).toBe(`${COLLABORATORS_URL}/grant-001`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ accessLevel: 'editor' })
    expect(result).toEqual(updated)
  })

  it('throws OwnerOnlyError on 403 code:"owner_only"', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'owner_only'))
    await expect(updateLevel(ESTIMATE_ID, 'grant-001', { accessLevel: 'viewer' })).rejects.toBeInstanceOf(
      OwnerOnlyError,
    )
  })

  it('throws the base ApiError on a code-less 404 (estimate or grant not found)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(404, { title: 'Not Found', status: 404 }))

    let thrown: unknown
    try {
      await updateLevel(ESTIMATE_ID, 'nonexistent-grant', { accessLevel: 'viewer' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(404)
  })

  it('sends PATCH — a PUT would not match this assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedGrant))
    await updateLevel(ESTIMATE_ID, 'grant-001', { accessLevel: 'editor' })
    expect(lastCall().init?.method).toBe('PATCH')
  })
})

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe('remove(estimateId, collaboratorId)', () => {
  it('issues DELETE to /collaborators/:collaboratorId and resolves void on 204', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await remove(ESTIMATE_ID, 'grant-001')

    const { url, init } = lastCall()
    expect(url).toBe(`${COLLABORATORS_URL}/grant-001`)
    expect(init?.method).toBe('DELETE')
    expect(result).toBeUndefined()
  })

  it('throws OwnerOnlyError on 403 code:"owner_only"', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'owner_only'))
    await expect(remove(ESTIMATE_ID, 'grant-001')).rejects.toBeInstanceOf(OwnerOnlyError)
  })

  it('throws the base ApiError on a code-less 404 (estimate or grant not found)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(404, { title: 'Not Found', status: 404 }))
    await expect(remove(ESTIMATE_ID, 'nonexistent-grant')).rejects.toBeInstanceOf(ApiError)
  })

  it('does not touch /me — removing a specific collaboratorId must never hit the self route', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await remove(ESTIMATE_ID, 'grant-001')
    expect(lastCall().url).not.toContain('/me')
  })
})

// ---------------------------------------------------------------------------
// leave()
// ---------------------------------------------------------------------------

describe('leave(estimateId)', () => {
  it('issues DELETE to /collaborators/me and resolves void on 204 (US-6)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await leave(ESTIMATE_ID)

    const { url, init } = lastCall()
    expect(url).toBe(`${COLLABORATORS_URL}/me`)
    expect(init?.method).toBe('DELETE')
    expect(result).toBeUndefined()
  })

  it('throws NotACollaboratorError on 404 code:"not_a_collaborator" (AC-6.2 — includes the owner)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'not_a_collaborator'))

    let thrown: unknown
    try {
      await leave(ESTIMATE_ID)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NotACollaboratorError)
    expect(thrown).toBeInstanceOf(ApiError)
  })

  it('distinguishes NotACollaboratorError (leave) from a plain code-less 404 (list/updateLevel/remove)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'not_a_collaborator'))
    const leaveErr = await leave(ESTIMATE_ID).catch((e: unknown) => e)

    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(404, { title: 'Not Found', status: 404 }))
    const plainErr = await remove(ESTIMATE_ID, 'grant-001').catch((e: unknown) => e)

    expect(leaveErr).toBeInstanceOf(NotACollaboratorError)
    expect(plainErr).not.toBeInstanceOf(NotACollaboratorError)
    expect((leaveErr as ApiError).status).toBe((plainErr as ApiError).status)
  })
})
