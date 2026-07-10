/**
 * @vitest-environment jsdom
 *
 * Delegation tests for src/lib/authClient.ts (T13, specs/003-suite-shell/tasks.md).
 *
 * Before T13, this file created its OWN `better-auth/react` client instance.
 * T13 replaces that with a facade over the shell-exposed `shell/session`
 * module (T4) so the whole suite shares one better-auth client / session
 * state instead of estimai-ui holding an independent copy. There is no
 * session-resolution *behavior* left to unit-test here (that behavior, and
 * its coverage, now lives in shell/src/lib/session.ts /
 * shell/src/lib/session.test.ts) — what this file asserts is that
 * `authClient.getSession`/`useSession`/`signOut` are the EXACT bindings
 * `shell/session` provides, so every caller (EstimatorApp.tsx,
 * pages/EstimatesPage.tsx) transparently gets the shared suite-wide session.
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
import { authClient } from './authClient'

describe('authClient delegates to shell/session (T13, AC-2.3)', () => {
  it('authClient.getSession is the exact shell/session.getSession binding', () => {
    expect(authClient.getSession).toBe(shellSession.getSession)
  })

  it('authClient.useSession is the exact shell/session.useSession binding', () => {
    expect(authClient.useSession).toBe(shellSession.useSession)
  })

  it('authClient.signOut is the exact shell/session.signOut binding', () => {
    expect(authClient.signOut).toBe(shellSession.signOut)
  })

  it('calling authClient.signOut() calls through to the shell/session implementation', async () => {
    const mockSignOut = vi.mocked(shellSession.signOut)

    await authClient.signOut()

    expect(mockSignOut).toHaveBeenCalledOnce()
  })
})
