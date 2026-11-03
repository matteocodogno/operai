/**
 * @vitest-environment jsdom
 *
 * ContractFormDialog (AC-2.1 – AC-2.9): each project type shows only its own
 * terms (SLA prefilled 1 / 3), a maintenance contract without an SLA and an hour
 * package cannot be saved, the body that reaches POST / PATCH (the contract
 * version as If-Match), the server's refusals landing on the field they name, and
 * no amount, price or rate anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Contract, ContractTerms, ProjectType } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import ContractFormDialog from './ContractFormDialog'

const ACME = { id: 'c-acme', name: 'Acme SA', entity: 'welld_ch' }
const onSaved = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const project = (type: ProjectType) => ({
  id: 'p1',
  type,
  company: type === 'saas' || type === 'internal' ? null : { id: 'c1', name: 'Acme SA' },
})

const stored = (type: ProjectType, terms: ContractTerms, over: Partial<Contract> = {}): Contract => ({
  id: 'k1',
  type,
  company: { id: 'c1', name: 'Acme SA' },
  origin: 'manual',
  bexioOrderId: null,
  startDate: '2026-02-01',
  endDate: null,
  projectId: 'p1',
  dealId: null,
  terms,
  version: 4,
  ...over,
})

const renderDialog = (type: ProjectType, routes: Record<string, FakeHandler> = {}, contract?: Contract) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /companies': () => ({ status: 200, body: { items: [ACME] } }),
      'POST /projects/p1/contracts': () => ({ status: 201, body: stored(type, {}) }),
      'PATCH /projects/p1/contracts/k1': () => ({ status: 200, body: { ...contract, version: 5 } }),
      ...routes,
    }),
  )
  render(
    <ContractFormDialog
      project={project(type)}
      contract={contract}
      onSaved={onSaved}
      onCancel={onCancel}
      onStale={onStale}
    />,
  )
  return screen.getByRole('dialog')
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

const sent = () => {
  const call = apiFetch.mock.calls.find(([, init]) =>
    ['POST', 'PATCH'].includes((init as RequestInit | undefined)?.method ?? ''),
  )
  return call
    ? {
        method: (call[1] as RequestInit).method!,
        path: new URL(String(call[0])).pathname,
        ifMatch: ((call[1] as RequestInit).headers as Record<string, string>)['If-Match'],
        body: JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
      }
    : null
}

const fill = (dialog: HTMLElement, label: RegExp | string, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('contract-form-submit'))

/** The labelled inputs of the Terms area, by what the person sees. */
const FIELDS = {
  deadline: /^Deadline/,
  estimated: /^Estimated man-days/,
  maxEffort: /^Max effort/,
  withSla: /Include an SLA/,
  slaHigh: /High priority/,
  slaNormal: /Normal priority/,
  withHours: /Include an hour package/,
  hours: /^Hours/,
  kind: /Package type/,
  packageStart: /Package start date/,
  packageExpiry: /Package expiry date/,
  profile: /^Profile/,
  planned: /^Planned man-days/,
}
const present = (dialog: HTMLElement) =>
  Object.entries(FIELDS)
    .filter(([, label]) => within(dialog).queryAllByLabelText(label).length > 0)
    .map(([name]) => name)

describe('each type shows only its own terms (AC-2.3 – AC-2.8)', () => {
  it('fixed price: deadline, estimated man-days and max effort', () => {
    expect(present(renderDialog('fixed_price'))).toEqual(['deadline', 'estimated', 'maxEffort'])
  })

  it('maintenance: an SLA and an hour package, each opted into', () => {
    const dialog = renderDialog('maintenance')
    expect(present(dialog)).toEqual(['withSla', 'withHours'])
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withHours))
    expect(present(dialog)).toEqual([
      'withSla',
      'slaHigh',
      'slaNormal',
      'withHours',
      'hours',
      'kind',
      'packageStart',
      'packageExpiry',
    ])
  })

  it('SaaS: the same optional SLA and hour package, with the licence period dates', () => {
    const dialog = renderDialog('saas')
    expect(present(dialog)).toEqual(['withSla', 'withHours'])
    expect(within(dialog).getByLabelText(/Start date/)).not.toBeNull()
    expect(within(dialog).getByLabelText(/End date/)).not.toBeNull()
  })

  it('time and material: positions with a profile and planned man-days, one to start with', () => {
    const dialog = renderDialog('t_and_m')
    expect(present(dialog)).toEqual(['profile', 'planned'])
    expect(within(dialog).getAllByLabelText(FIELDS.profile)).toHaveLength(1)
  })

  it('every type has the start date and the optional end date, and none has an amount, price or rate (AC-2.9)', () => {
    for (const type of ['fixed_price', 'maintenance', 'saas', 't_and_m'] as const) {
      const dialog = renderDialog(type)
      expect(within(dialog).getByLabelText(/Start date/)).not.toBeNull()
      expect(within(dialog).getByLabelText(/End date/)).not.toBeNull()
      expect(dialog.textContent).not.toMatch(/\b(price|rate|amount|fee|budget|cost)\b|CHF|EUR|€/i)
      cleanup()
    }
  })

  it('a client project shows its own company, read-only; a SaaS asks for any company', () => {
    const own = renderDialog('t_and_m')
    expect((within(own).getByLabelText(/^Client/) as HTMLInputElement).readOnly).toBe(true)
    expect((within(own).getByLabelText(/^Client/) as HTMLInputElement).value).toBe('Acme SA')
    cleanup()
    const saas = renderDialog('saas')
    expect(within(saas).getByRole('combobox', { name: /^Client/ })).not.toBeNull()
  })
})

describe('the SLA (AC-2.5)', () => {
  it('is prefilled with 1 and 3 days, editable', () => {
    const dialog = renderDialog('maintenance')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    expect((within(dialog).getByLabelText(FIELDS.slaHigh) as HTMLInputElement).value).toBe('1')
    expect((within(dialog).getByLabelText(FIELDS.slaNormal) as HTMLInputElement).value).toBe('3')
  })

  it('refuses days outside 0–60 before any request, naming the field', () => {
    const dialog = renderDialog('saas')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, FIELDS.slaHigh, '61')
    submit(dialog)
    expect(within(dialog).getByText('Enter a whole number from 0 to 60.')).not.toBeNull()
    expect(within(dialog).getByLabelText(FIELDS.slaHigh).getAttribute('aria-invalid')).toBe('true')
    expect(sent()).toBeNull()
  })
})

describe('a maintenance contract needs an SLA or an hour package (AC-2.4)', () => {
  it('cannot be saved with neither: nothing is sent, and the dialog says why', async () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    submit(dialog)
    expect(await within(dialog).findByText('Add an SLA, an hour package, or both.')).not.toBeNull()
    expect(sent()).toBeNull()
  })

  it('is saved with an SLA alone', async () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body).toEqual({
      startDate: '2026-02-01',
      terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
    })
  })

  it('is saved with an hour package alone; a yearly package sends no expiry', async () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withHours))
    fill(dialog, FIELDS.hours, '120')
    fill(dialog, FIELDS.packageStart, '2026-02-01')
    fill(dialog, FIELDS.packageExpiry, '2027-02-01')
    fill(dialog, FIELDS.kind, 'yearly')
    expect(within(dialog).queryByLabelText(FIELDS.packageExpiry)).toBeNull()
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body.terms).toEqual({
      sla: null,
      hourPackage: { hours: 120, kind: 'yearly', startDate: '2026-02-01', expiryDate: null },
    })
  })

  it('refuses an expiry before the package start, on the expiry field', () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withHours))
    fill(dialog, FIELDS.hours, '120')
    fill(dialog, FIELDS.packageStart, '2026-02-01')
    fill(dialog, FIELDS.packageExpiry, '2026-01-01')
    submit(dialog)
    expect(within(dialog).getByText('The expiry must not be before the start date.')).not.toBeNull()
    expect(sent()).toBeNull()
  })
})

describe('creating a contract (AC-2.1 – AC-2.3, AC-2.7, AC-2.8)', () => {
  it('fixed price: sends the terms; the company is the project’s, so none is sent', async () => {
    const dialog = renderDialog('fixed_price')
    submit(dialog)
    expect(within(dialog).getAllByText('This field is required.').length).toBe(3)
    expect(sent()).toBeNull()
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, FIELDS.deadline, '2026-12-01')
    fill(dialog, FIELDS.maxEffort, '40,5')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toEqual({
      method: 'POST',
      path: '/projects/p1/contracts',
      ifMatch: undefined,
      body: {
        startDate: '2026-02-01',
        terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40.5 },
      },
    })
  })

  it('time and material: add and remove positions, then send them in order', async () => {
    const dialog = renderDialog('t_and_m')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, FIELDS.profile, 'Senior developer')
    fill(dialog, FIELDS.planned, '20')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add position' }))
    expect(within(dialog).getAllByLabelText(FIELDS.profile)).toHaveLength(2)
    submit(dialog)
    expect(within(dialog).getAllByText('This field is required.').length).toBeGreaterThan(0)
    expect(sent()).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove position 2' }))
    expect(within(dialog).getAllByLabelText(FIELDS.profile)).toHaveLength(1)
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body.terms).toEqual({ positions: [{ profile: 'Senior developer', plannedManDays: 20 }] })
  })

  it('time and material: the last position cannot be removed', () => {
    const dialog = renderDialog('t_and_m')
    expect((within(dialog).getByRole('button', { name: 'Remove position 1' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('SaaS: needs a company from the CRM, sends it, and takes neither SLA nor hours', async () => {
    const dialog = renderDialog('saas')
    fill(dialog, /Start date/, '2026-02-01')
    submit(dialog)
    expect(within(dialog).getByText('Choose a company from the list.')).not.toBeNull()
    expect(sent()).toBeNull()
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^Client/ }), { target: { value: 'acm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /Acme SA/ }))
    fill(dialog, /End date/, '2027-01-31')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body).toEqual({
      companyId: 'c-acme',
      startDate: '2026-02-01',
      endDate: '2027-01-31',
      terms: { sla: null, hourPackage: null },
    })
  })

  it('an end date before the start date is refused before any request', () => {
    const dialog = renderDialog('saas')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, /End date/, '2026-01-01')
    submit(dialog)
    expect(within(dialog).getByText('The end date must not be before the start date.')).not.toBeNull()
    expect(sent()).toBeNull()
  })
})

describe('the server’s refusals (AC-2.2 – AC-2.7)', () => {
  const fillMaintenance = (dialog: HTMLElement) => {
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
  }

  it('400 validation_failed names a dotted field, which lands on that input', async () => {
    const dialog = renderDialog('maintenance', {
      'POST /projects/p1/contracts': () =>
        problem(400, 'validation_failed', { field: 'terms.sla.highDays' }, 'terms.sla.highDays: Too big'),
    })
    fillMaintenance(dialog)
    submit(dialog)
    await waitFor(() => expect(within(dialog).getByLabelText(FIELDS.slaHigh).getAttribute('aria-invalid')).toBe('true'))
    expect(within(dialog).getByText('terms.sla.highDays: Too big')).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('400 on terms.hourPackage.expiryDate lands on the expiry input', async () => {
    const dialog = renderDialog('maintenance', {
      'POST /projects/p1/contracts': () =>
        problem(
          400,
          'validation_failed',
          { field: 'terms.hourPackage.expiryDate' },
          'Must not be before the start date',
        ),
    })
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withHours))
    fill(dialog, FIELDS.hours, '10')
    fill(dialog, FIELDS.packageStart, '2026-02-01')
    submit(dialog)
    await waitFor(() =>
      expect(within(dialog).getByLabelText(FIELDS.packageExpiry).getAttribute('aria-invalid')).toBe('true'),
    )
  })

  it('422 maintenance_needs_sla_or_hours is said in the terms area', async () => {
    const dialog = renderDialog('maintenance', {
      'POST /projects/p1/contracts': () => problem(422, 'maintenance_needs_sla_or_hours', { field: 'terms' }),
    })
    fillMaintenance(dialog)
    submit(dialog)
    expect(await within(dialog).findByText('Add an SLA, an hour package, or both.')).not.toBeNull()
  })

  it.each([
    ['company_not_found', 422, 'This company no longer exists in the CRM. Choose another.'],
    ['company_mismatch', 422, 'A client project takes contracts for its own company only.'],
  ])('422 %s lands on the company field', async (code, status, message) => {
    const dialog = renderDialog('saas', {
      'POST /projects/p1/contracts': () => problem(status, code, { field: 'companyId' }),
    })
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^Client/ }), { target: { value: 'acm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /Acme SA/ }))
    submit(dialog)
    expect(await within(dialog).findByText(message)).not.toBeNull()
  })

  it.each([
    ['project_not_open', 409, 'A closed or cancelled project takes no new contract. Reopen it first.'],
    ['contracts_not_allowed', 409, 'An internal project takes no contracts.'],
    ['crm_unavailable', 503, 'The CRM cannot be reached right now. Try again in a moment.'],
  ])('%s is the dialog’s own message, every value kept', async (code, status, message) => {
    const dialog = renderDialog('maintenance', { 'POST /projects/p1/contracts': () => problem(status, code) })
    fillMaintenance(dialog)
    submit(dialog)
    expect((await within(dialog).findByTestId('contract-form-error')).textContent).toBe(message)
    expect((within(dialog).getByLabelText(/Start date/) as HTMLInputElement).value).toBe('2026-02-01')
  })
})

describe('editing a contract (AC-1.7, AC-2.10)', () => {
  const fixed = stored('fixed_price', { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 })

  it('starts from the stored values; the company is fixed; nothing to save until something changes', () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    expect((within(dialog).getByLabelText(/Start date/) as HTMLInputElement).value).toBe('2026-02-01')
    expect((within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement).value).toBe('12.5')
    expect((within(dialog).getByLabelText(FIELDS.maxEffort) as HTMLInputElement).value).toBe('40')
    expect((within(dialog).getByLabelText(/^Client/) as HTMLInputElement).readOnly).toBe(true)
    expect((within(dialog).getByTestId('contract-form-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('PATCHes the dates and the whole terms with the contract version as If-Match', async () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    fill(dialog, FIELDS.maxEffort, '50')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toEqual({
      method: 'PATCH',
      path: '/projects/p1/contracts/k1',
      ifMatch: '"4"',
      body: {
        startDate: '2026-02-01',
        endDate: null,
        terms: { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 50 },
      },
    })
  })

  it('clearing the end date reopens an ended contract (endDate: null)', async () => {
    const dialog = renderDialog('fixed_price', {}, { ...fixed, endDate: '2026-06-30' })
    expect((within(dialog).getByLabelText(/End date/) as HTMLInputElement).value).toBe('2026-06-30')
    fill(dialog, /End date/, '')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body.endDate).toBeNull()
  })

  it('a stale save (409 version_conflict) is handed to the page', async () => {
    const dialog = renderDialog(
      'fixed_price',
      { 'PATCH /projects/p1/contracts/k1': () => problem(409, 'version_conflict', { currentVersion: 9 }) },
      fixed,
    )
    fill(dialog, FIELDS.maxEffort, '50')
    submit(dialog)
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a contract of a closed project is still editable (PATCH is allowed there)', async () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    fill(dialog, /End date/, '2026-06-30')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.method).toBe('PATCH')
  })
})
