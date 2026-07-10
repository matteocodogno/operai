/**
 * @vitest-environment jsdom
 *
 * Delegation tests for src/lib/api.ts (T13, specs/003-suite-shell/tasks.md).
 *
 * Before T13, this file unit-tested the full JWT-cache + apiFetch interceptor
 * contract (Bearer attachment, 401 refresh-retry, trusted-origin guard,
 * sign-in redirect on exhausted retry) directly against this module's OWN
 * implementation. T13 removes that implementation: estimai-ui now runs as a
 * federated remote inside the shell (T12), and `apiFetch`/`clearJwtCache` are
 * re-exported from the shell-owned `shell/session` module (T4) instead, so
 * the ADR-0001 in-memory JWT is cached ONCE for the whole suite.
 *
 * That full interceptor-contract coverage was not dropped, only relocated:
 * it lives in shell/src/lib/session.test.ts now, ported verbatim from this
 * file's original suite at T4 — see that file for the authoritative
 * behavioral coverage (refresh-retry circuit, trusted-origin policy,
 * sign-in redirect). Re-testing that same contract here would just be
 * re-testing the delegation target's internals through an extra layer of
 * indirection.
 *
 * What remains testable AT THIS module boundary is the delegation itself:
 * `./api` must re-export the exact bindings `shell/session` provides, so
 * every caller in estimai-ui (estimatesApi.ts, EstimatorApp.tsx,
 * pages/EstimatesPage.tsx) transparently gets the shared suite-wide
 * implementation.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  clearJwtCache: vi.fn(),
  getSession: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
}))

import * as shellSession from 'shell/session'
import { apiFetch, clearJwtCache } from './api'

describe('./api delegates to shell/session (T13, AC-2.3)', () => {
  it('re-exports the exact same apiFetch binding as shell/session', () => {
    expect(apiFetch).toBe(shellSession.apiFetch)
  })

  it('re-exports the exact same clearJwtCache binding as shell/session', () => {
    expect(clearJwtCache).toBe(shellSession.clearJwtCache)
  })

  it('calling apiFetch here calls through to the shell/session implementation', async () => {
    const mockApiFetch = vi.mocked(shellSession.apiFetch)
    mockApiFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await apiFetch('/estimates')

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith('/estimates')
  })

  it('calling clearJwtCache here calls through to the shell/session implementation', () => {
    const mockClear = vi.mocked(shellSession.clearJwtCache)

    clearJwtCache()

    expect(mockClear).toHaveBeenCalledOnce()
  })
})
