/**
 * @vitest-environment jsdom
 *
 * useCanManageLegalEntity (specs/20261117-legal-entities plan E2, AC-6.1): `GET /legal-entities/manageable` on auth, asked once
 * per session, and failing closed: any error, a non-200 or a body that is not the contract means "may not manage".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { resetManageableLegalEntities, useCanManageLegalEntity } from './useCanManageLegalEntity'
import { fakeApi, problemAnswer } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'

const { apiFetch, session } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  session: { userId: 'u-ada' as string | null },
}))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: session.userId === null ? null : { user: { id: session.userId } } }),
}))

const answerWith = (answer: () => FakeAnswer | Promise<FakeAnswer>) =>
  apiFetch.mockImplementation(fakeApi({ 'GET /legal-entities/manageable': answer }))
const manageableCalls = () =>
  apiFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/legal-entities/manageable')

beforeEach(() => {
  session.userId = 'u-ada'
  resetManageableLegalEntities()
})
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

describe('useCanManageLegalEntity', () => {
  it('is true for an entity the answer lists and false for one it does not', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    const ch = renderHook(() => useCanManageLegalEntity('welld_ch'))
    const it = renderHook(() => useCanManageLegalEntity('welld_it'))
    // pending is "may not": the link never shows before the answer
    expect(ch.result.current).toBe(false)
    await waitFor(() => expect(ch.result.current).toBe(true))
    expect(it.result.current).toBe(false)
    expect(String(manageableCalls()[0]?.[0])).toBe('http://auth.test/legal-entities/manageable')
  })

  it('asks auth once per session, however many readers and mounts', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_it', 'welld_ch'] } }))
    const first = renderHook(() => useCanManageLegalEntity('welld_it'))
    const second = renderHook(() => useCanManageLegalEntity('welld_ch'))
    await waitFor(() => expect(first.result.current && second.result.current).toBe(true))
    first.unmount()
    const later = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(later.result.current).toBe(true))
    expect(manageableCalls()).toHaveLength(1)
  })

  it('answers false for a person who manages none', async () => {
    answerWith(() => ({ status: 200, body: { entities: [] } }))
    const { result } = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(manageableCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBe(false)
  })

  it.each([
    ['a 403', () => problemAnswer(403, 'forbidden')],
    ['a 503', () => problemAnswer(503, 'unavailable')],
    ['a body that is not the contract', () => ({ status: 200, body: { entities: 'welld_it' } })],
    ['no body', () => ({ status: 200, body: { nope: true } })],
  ])('fails closed on %s', async (_name, answer) => {
    answerWith(answer)
    const { result } = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(manageableCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBe(false)
  })

  it('fails closed when the request itself rejects, and asks again at the next mount', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('network down'))
    const down = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(manageableCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(down.result.current).toBe(false)
    down.unmount()

    answerWith(() => ({ status: 200, body: { entities: ['welld_it'] } }))
    const back = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(back.result.current).toBe(true))
    expect(manageableCalls()).toHaveLength(2)
  })

  it('does not ask before the session knows the person, and is false while signed out', async () => {
    session.userId = null
    answerWith(() => ({ status: 200, body: { entities: ['welld_it'] } }))
    const { result } = renderHook(() => useCanManageLegalEntity('welld_it'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBe(false)
    expect(manageableCalls()).toHaveLength(0)
  })

  it('never lets another person read the previous person’s answer', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_it'] } }))
    const ada = renderHook(() => useCanManageLegalEntity('welld_it'))
    await waitFor(() => expect(ada.result.current).toBe(true))
    ada.unmount()

    session.userId = 'u-bob'
    answerWith(() => ({ status: 200, body: { entities: [] } }))
    const bob = renderHook(() => useCanManageLegalEntity('welld_it'))
    expect(bob.result.current).toBe(false)
    await waitFor(() => expect(manageableCalls()).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bob.result.current).toBe(false)
  })
})
