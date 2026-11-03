/**
 * @vitest-environment jsdom
 *
 * BexioOrderField (AC-3.1 – AC-3.3): editable only for a holder of the Bexio
 * order capability (`GET /scope`'s `bexio`); the id is trimmed, empty clears it,
 * more than 64 characters is refused before any request, and a stale save
 * (409 `version_conflict`, e.g. after a project manager edited the contract)
 * is the page's to handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScopeContext } from '../hooks/useScope'
import { fakeApi, problem, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import BexioOrderField from './BexioOrderField'

const contract = { id: 'k1', bexioOrderId: 'AB-100' as string | null, version: 4 }
const onSaved = vi.fn()
const onStale = vi.fn()

const renderField = (
  callerScope: Scope,
  routes: Record<string, FakeHandler> = {},
  current: { id: string; bexioOrderId: string | null; version: number } = contract,
) => {
  apiFetch.mockImplementation(fakeApi(routes))
  render(
    <ScopeContext.Provider value={callerScope}>
      <BexioOrderField projectId="p1" contract={current} onSaved={onSaved} onStale={onStale} />
    </ScopeContext.Provider>,
  )
}

const answer = (bexioOrderId: string | null) => () => ({
  status: 200,
  body: { ...contract, bexioOrderId, version: 5 },
})

const put = () => {
  const call = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
  return call
    ? {
        path: new URL(String(call[0])).pathname,
        ifMatch: ((call[1] as RequestInit).headers as Record<string, string>)['If-Match'],
        body: JSON.parse(String((call[1] as RequestInit).body)) as unknown,
      }
    : null
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('who may write the Bexio order id (AC-3.1)', () => {
  it('without the capability the id is read-only text and there is no control', () => {
    renderField(scope({ manage: ['welld_ch'] }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTestId('contract-bexio-k1').textContent).toContain('AB-100')
  })

  it('without the capability and without an id it says it is not set', () => {
    renderField(scope(), {}, { ...contract, bexioOrderId: null })
    expect(screen.getByTestId('contract-bexio-k1').textContent).toContain('Not set')
  })

  it('with the capability the id is an input holding the current value', () => {
    renderField(scope({ bexio: true }))
    expect((screen.getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-100')
  })
})

describe('setting, changing and clearing it (AC-3.1, AC-3.2)', () => {
  it('there is nothing to save until the value changes', () => {
    renderField(scope({ bexio: true }))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('PUTs the trimmed id with the contract version as If-Match, and hands back the contract', async () => {
    renderField(scope({ bexio: true }), {
      'PUT /projects/p1/contracts/k1/bexio-order': answer('AB-200'),
    })
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: '  AB-200 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(put()).toEqual({
      path: '/projects/p1/contracts/k1/bexio-order',
      ifMatch: '"4"',
      body: { bexioOrderId: 'AB-200' },
    })
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ bexioOrderId: 'AB-200', version: 5 })
  })

  it('an emptied field clears the id (null)', async () => {
    renderField(scope({ bexio: true }), { 'PUT /projects/p1/contracts/k1/bexio-order': answer(null) })
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(put()!.body).toEqual({ bexioOrderId: null })
  })

  it('65 characters are refused before any request, 64 are fine', async () => {
    renderField(scope({ bexio: true }), { 'PUT /projects/p1/contracts/k1/bexio-order': answer('x') })
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: 'x'.repeat(65) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Use at most 64 characters.')).not.toBeNull()
    expect(put()).toBeNull()
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: 'x'.repeat(64) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put()).not.toBeNull())
  })

  it('a stale save (409 version_conflict) is handed to the page and changes nothing here', async () => {
    renderField(scope({ bexio: true }), {
      'PUT /projects/p1/contracts/k1/bexio-order': () => problem(409, 'version_conflict', { currentVersion: 6 }),
    })
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('any other refusal is said under the field, the value kept', async () => {
    renderField(scope({ bexio: true }), {
      'PUT /projects/p1/contracts/k1/bexio-order': () => problem(403, 'forbidden', {}, 'Missing permission'),
    })
    fireEvent.change(screen.getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Missing permission')).not.toBeNull()
    expect((screen.getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-200')
  })
})
