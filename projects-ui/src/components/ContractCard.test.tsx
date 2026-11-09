/**
 * @vitest-environment jsdom
 *
 * ContractCard (AC-2.1, AC-2.9, AC-2.10, AC-3.1): the contract with its terms per
 * type, no amount anywhere, no delete control, edit and "End contract" for a
 * holder of manage projects only (ending = setting the end date), and the Bexio
 * order id editable only with the `bexio` scope, whose save bumps the contract
 * version the next edit must send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ScopeContext } from '../hooks/useScope'
import { fakeApi, problem, projectDetail, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Contract, ContractSummary, ContractTerms, ProjectType, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import ContractCard from './ContractCard'

const SUMMARY: ContractSummary = {
  id: 'k1',
  type: 't_and_m',
  company: { id: 'c1', name: 'Acme SA' },
  origin: 'manual',
  bexioOrderId: 'AB-100',
  startDate: '2026-02-01',
  endDate: null,
}

const contractOf = (type: ProjectType, terms: ContractTerms, over: Partial<Contract> = {}): Contract => ({
  ...SUMMARY,
  type,
  projectId: 'p1',
  dealId: null,
  terms,
  version: 4,
  ...over,
})

const TERMS: Record<string, [ProjectType, ContractTerms, string[]]> = {
  fixed_price: [
    'fixed_price',
    { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 },
    ['Deadline', '01.12.2026', 'Estimated man-days', '12.5 man-days', 'Max effort', '40 man-days'],
  ],
  maintenance: [
    'maintenance',
    {
      sla: { highDays: 1, normalDays: 3 },
      hourPackage: { hours: 120, kind: 'yearly', startDate: '2026-03-01', expiryDate: null },
    },
    ['High priority: 1 working day · Normal priority: 3 working days', '120 hours', 'Yearly package', '01.03.2026'],
  ],
  saas: ['saas', { sla: null, hourPackage: null }, ['SLA', 'Hour package', 'None']],
  t_and_m: [
    't_and_m',
    { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] },
    ['Senior developer', '20'],
  ],
}

const onChanged = vi.fn()
const onStale = vi.fn()

const renderCard = async (
  contract: Contract,
  callerScope: Scope = scope({ manage: ['welld_ch'] }),
  routes: Record<string, FakeHandler> = {},
) => {
  apiFetch.mockImplementation(fakeApi(routes))
  render(
    <ScopeContext.Provider value={callerScope}>
      <ContractCard
        project={projectDetail({ type: contract.type })}
        contract={contract}
        canManage={callerScope.manage.includes('welld_ch')}
        onChanged={onChanged}
        onStale={onStale}
      />
    </ScopeContext.Provider>,
  )
  await screen.findByTestId('contract-terms')
  return screen.getByTestId('contract-k1')
}

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      ifMatch: ((init as RequestInit).headers as Record<string, string>)['If-Match'],
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as unknown,
    }))

describe('the contract and its terms (AC-2.1, AC-2.3 – AC-2.8)', () => {
  it.each(Object.entries(TERMS))(
    '%s: shows the client, origin, dates and its own terms',
    async (_name, [type, terms, texts]) => {
      const card = await renderCard(contractOf(type, terms))
      expect(within(card).getByRole('heading', { level: 4, name: 'Acme SA' })).not.toBeNull()
      expect(card.textContent).toContain('Entered by hand')
      expect(card.textContent).toContain('01.02.2026')
      expect(card.textContent).toContain('Open-ended')
      for (const text of texts) expect(card.textContent).toContain(text)
    },
  )

  it('shows an end date when the contract has one', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }, { endDate: '2026-12-31' }))
    expect(card.textContent).toContain('31.12.2026')
    expect(card.textContent).not.toContain('Open-ended')
  })

  it.each(Object.entries(TERMS))('%s: renders no amount, price or rate (AC-2.9)', async (_name, [type, terms]) => {
    const card = await renderCard(contractOf(type, terms))
    expect(card.textContent).not.toMatch(/\b(price|rate|amount|fee|budget|cost)\b|CHF|EUR|€/i)
  })

  it('renders the contract the project carries, with no request of its own (no N+1 reads)', async () => {
    await renderCard(contractOf('saas', { sla: null, hourPackage: null }))
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('no delete control (AC-2.10)', () => {
  it('a manager can edit and end a contract, and has no way to delete it', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }))
    const controls = [...within(card).queryAllByRole('button'), ...within(card).queryAllByRole('link')].map(
      (control) => control.textContent,
    )
    expect(controls).toContain('Edit')
    expect(controls).toContain('End contract')
    expect(controls.join(' | ')).not.toMatch(/delet|elimin|remove contract|rimuovi contratto/i)
    expect(card.querySelector('[data-testid*="delete"]')).toBeNull()
  })
})

describe('who may edit or end it (AC-4.4)', () => {
  it('a reader gets neither Edit nor End contract', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }), scope())
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'End contract' })).toBeNull()
  })

  it('an ended contract is edited (to change or clear the end date), not ended again', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }, { endDate: '2026-12-31' }))
    expect(within(card).getByRole('button', { name: 'Edit' })).not.toBeNull()
    expect(within(card).queryByRole('button', { name: 'End contract' })).toBeNull()
  })
})

describe('ending a contract sets its end date (AC-2.10)', () => {
  it('asks for the date, PATCHes only the end date with the version, and shows it', async () => {
    const stored = contractOf('saas', { sla: null, hourPackage: null })
    const card = await renderCard(stored, scope({ manage: ['welld_ch'] }), {
      'PATCH /projects/p1/contracts/k1': () => ({
        status: 200,
        body: { ...stored, endDate: '2026-06-30', version: 5 },
      }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'End contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'End this contract' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-06-30' } })
    fireEvent.click(within(dialog).getByTestId('contract-end-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([
      { method: 'PATCH', path: '/projects/p1/contracts/k1', ifMatch: '"4"', body: { endDate: '2026-06-30' } },
    ])
    expect(card.textContent).toContain('30.06.2026')
    expect(within(card).queryByRole('button', { name: 'End contract' })).toBeNull()
    expect(onChanged).toHaveBeenCalledWith('Contract ended.')
  })

  it('an end date before the start date is refused before any request', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }))
    fireEvent.click(within(card).getByRole('button', { name: 'End contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'End this contract' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-01-01' } })
    fireEvent.click(within(dialog).getByTestId('contract-end-submit'))
    expect(await within(dialog).findByText('The end date must not be before the start date.')).not.toBeNull()
    expect(writes()).toEqual([])
  })

  it('a stale end (409 version_conflict) closes the dialog and is the page’s to handle', async () => {
    const card = await renderCard(
      contractOf('saas', { sla: null, hourPackage: null }),
      scope({ manage: ['welld_ch'] }),
      {
        'PATCH /projects/p1/contracts/k1': () => problem(409, 'version_conflict', { currentVersion: 9 }),
      },
    )
    fireEvent.click(within(card).getByRole('button', { name: 'End contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'End this contract' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-06-30' } })
    fireEvent.click(within(dialog).getByTestId('contract-end-submit'))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('editing (AC-1.7)', () => {
  it('opens the form on the stored terms, saves, and shows the new terms', async () => {
    const stored = contractOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 })
    const card = await renderCard(stored, scope({ manage: ['welld_ch'] }), {
      'PATCH /projects/p1/contracts/k1': () => ({
        status: 200,
        body: {
          ...stored,
          terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 55 },
          version: 5,
        },
      }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit contract' })
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '55' } })
    fireEvent.click(within(dialog).getByTestId('contract-form-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(card.textContent).toContain('55 man-days')
    expect(onChanged).toHaveBeenCalledWith('Contract saved.')
  })
})

describe('the Bexio order id (AC-3.1)', () => {
  it('a project manager reads it and has no field; accounting gets the field', async () => {
    const stored = contractOf('saas', { sla: null, hourPackage: null }, { bexioOrderId: 'AB-100' })
    const card = await renderCard(stored, scope({ manage: ['welld_ch'] }))
    expect(within(card).queryByLabelText('Bexio order')).toBeNull()
    expect(card.textContent).toContain('AB-100')
    cleanup()
    const accounting = await renderCard(stored, scope({ bexio: true }))
    expect((within(accounting).getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-100')
  })

  it('saving it bumps the contract version, which a later edit by a manager must send', async () => {
    const stored = contractOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 })
    const card = await renderCard(stored, scope({ manage: ['welld_ch'], bexio: true }), {
      'PUT /projects/p1/contracts/k1/bexio-order': () => ({
        status: 200,
        body: { ...stored, bexioOrderId: 'AB-200', version: 5 },
      }),
      'PATCH /projects/p1/contracts/k1': () => ({ status: 200, body: { ...stored, version: 6 } }),
    })
    fireEvent.change(within(card).getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Bexio order saved.'))
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit contract' })
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '41' } })
    fireEvent.click(within(dialog).getByTestId('contract-form-submit'))
    await waitFor(() => expect(writes().length).toBe(2))
    expect(writes().map((write) => write.ifMatch)).toEqual(['"4"', '"5"'])
  })

  it('a stale Bexio save (the contract changed meanwhile) is the page’s to handle', async () => {
    const card = await renderCard(contractOf('saas', { sla: null, hourPackage: null }), scope({ bexio: true }), {
      'PUT /projects/p1/contracts/k1/bexio-order': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    fireEvent.change(within(card).getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
  })
})
