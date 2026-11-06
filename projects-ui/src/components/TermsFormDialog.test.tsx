/**
 * @vitest-environment jsdom
 *
 * TermsFormDialog (specs/021 AC-2.3 – AC-2.9, specs/022 AC-1.8, AC-5.3, AC-5.4): each project type
 * shows only its own terms (SLA prefilled 1 / 3), maintenance terms without an SLA and an hour
 * package cannot be saved, the body that reaches POST / PATCH (the terms version as If-Match) —
 * the dates and the type's members side by side — the server's refusals landing on the field they
 * name, and no amount, price or rate anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Project, ProjectType, Terms } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TermsFormDialog from './TermsFormDialog'

const onSaved = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const project = (type: ProjectType, over: Partial<Project> = {}): Pick<Project, 'id' | 'type' | 'purchaseOrder'> => ({
  id: 'p1',
  type,
  purchaseOrder: null,
  ...over,
})

const renderDialog = (
  type: ProjectType,
  routes: Record<string, FakeHandler> = {},
  terms?: Terms,
  projectOver: Partial<Project> = {},
) => {
  apiFetch.mockImplementation(
    fakeApi({
      'POST /projects/p1/terms': () => ({ status: 201, body: termsOf('saas', { sla: null, hourPackage: null }) }),
      'PATCH /projects/p1/terms': () => ({ status: 200, body: { ...terms, version: 5 } }),
      ...routes,
    }),
  )
  render(
    <TermsFormDialog
      project={project(type, projectOver)}
      terms={terms}
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
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('terms-form-submit'))

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

  it('has no company field: the project’s company is fixed when the project is made (D40)', () => {
    const dialog = renderDialog('saas')
    expect(within(dialog).queryByLabelText(/^Client/)).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: /^Client|company/i })).toBeNull()
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

describe('maintenance terms need an SLA or an hour package (AC-2.4)', () => {
  it('cannot be saved with neither: nothing is sent, and the dialog says why', async () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    submit(dialog)
    expect(await within(dialog).findByText('Add an SLA, an hour package, or both.')).not.toBeNull()
    expect(sent()).toBeNull()
  })

  it('are saved with an SLA alone', async () => {
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

  it('are saved with an hour package alone; a yearly package sends no expiry', async () => {
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
    expect(sent()!.body).toMatchObject({
      terms: { sla: null, hourPackage: { hours: 120, kind: 'yearly', startDate: '2026-02-01', expiryDate: null } },
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

describe('adding terms (AC-2.1 – AC-2.3, AC-2.7, AC-2.8, AC-5.3)', () => {
  it('fixed price: sends the dates and the members side by side, with no If-Match', async () => {
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
      path: '/projects/p1/terms',
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
    expect(sent()!.body).toEqual({
      startDate: '2026-02-01',
      terms: { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] },
    })
  })

  it('time and material: the last position cannot be removed', () => {
    const dialog = renderDialog('t_and_m')
    expect((within(dialog).getByRole('button', { name: 'Remove position 1' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('SaaS: the licence period and, optionally, neither SLA nor hours', async () => {
    const dialog = renderDialog('saas')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, /End date/, '2027-01-31')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body).toEqual({
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

  it.each(['terms.sla.highDays'])(
    '400 validation_failed on %s (the terms routes’ path, T23) lands on the SLA input',
    async (field) => {
      const dialog = renderDialog('maintenance', {
        'POST /projects/p1/terms': () => problem(400, 'validation_failed', { field }, `${field}: Too big`),
      })
      fillMaintenance(dialog)
      submit(dialog)
      await waitFor(() =>
        expect(within(dialog).getByLabelText(FIELDS.slaHigh).getAttribute('aria-invalid')).toBe('true'),
      )
      expect(within(dialog).getByText(`${field}: Too big`)).not.toBeNull()
      expect(onSaved).not.toHaveBeenCalled()
    },
  )

  it('400 on terms.hourPackage.expiryDate lands on the expiry input', async () => {
    const dialog = renderDialog('maintenance', {
      'POST /projects/p1/terms': () =>
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
      'POST /projects/p1/terms': () => problem(422, 'maintenance_needs_sla_or_hours', { field: 'terms' }),
    })
    fillMaintenance(dialog)
    submit(dialog)
    expect(await within(dialog).findByText('Add an SLA, an hour package, or both.')).not.toBeNull()
  })

  it.each([
    ['project_not_open', 409, 'A closed or cancelled project takes no new terms. Reopen it first.'],
    ['terms_exist', 409, 'This project already has terms. Reload to see them.'],
    ['terms_not_allowed', 409, 'An internal project takes no terms.'],
    ['terms_not_found', 404, 'This project has no terms yet. Reload the page.'],
    ['out_of_scope', 403, 'You may not change the terms of this entity.'],
    ['crm_unavailable', 503, 'The CRM cannot be reached right now. Try again in a moment.'],
  ])('%s is the dialog’s own message, every value kept', async (code, status, message) => {
    const dialog = renderDialog('maintenance', { 'POST /projects/p1/terms': () => problem(status, code) })
    fillMaintenance(dialog)
    submit(dialog)
    expect((await within(dialog).findByTestId('terms-form-error')).textContent).toBe(message)
    expect((within(dialog).getByLabelText(/Start date/) as HTMLInputElement).value).toBe('2026-02-01')
  })
})

describe('editing terms (specs/021 AC-1.7, specs/022 AC-1.8, AC-5.4)', () => {
  const fixed = termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 })

  it('starts from the stored values; nothing to save until something changes', () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    expect((within(dialog).getByLabelText(/Start date/) as HTMLInputElement).value).toBe('2026-02-01')
    expect((within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement).value).toBe('12.5')
    expect((within(dialog).getByLabelText(FIELDS.maxEffort) as HTMLInputElement).value).toBe('40')
    expect((within(dialog).getByTestId('terms-form-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('PATCHes the dates and the whole set of members with the terms version as If-Match', async () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    fill(dialog, FIELDS.maxEffort, '50')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toEqual({
      method: 'PATCH',
      path: '/projects/p1/terms',
      ifMatch: '"4"',
      body: {
        startDate: '2026-02-01',
        endDate: null,
        terms: { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 50 },
      },
    })
  })

  it('clearing the end date reopens ended terms (endDate: null)', async () => {
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
      { 'PATCH /projects/p1/terms': () => problem(409, 'version_conflict', { currentVersion: 9 }) },
      fixed,
    )
    fill(dialog, FIELDS.maxEffort, '50')
    submit(dialog)
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('the terms of a closed project are still editable (PATCH is allowed there)', async () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    fill(dialog, /End date/, '2026-06-30')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.method).toBe('PATCH')
  })
})

describe('the man-days of terms the estimate backs (AC-3.1)', () => {
  const fixedTerms = (estimatedManDays: number | null) =>
    termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays, maxEffortManDays: 40 })
  const withEstimate = (estimate: { id: string } | null): Partial<Project> => ({
    purchaseOrder: {
      id: 'po1',
      deal: { id: 'd1', title: 'Website relaunch', won: true },
      estimate,
      bexioOrderId: null,
      referent: null,
      opsManager: { id: 'u-ops', name: 'Olga Ops', deleted: false },
      version: 1,
    },
  })

  it('are shown read-only, with their source, when editing', () => {
    const dialog = renderDialog('fixed_price', {}, fixedTerms(12.5), withEstimate({ id: 'est-1' }))
    const field = within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement
    expect(field.readOnly).toBe(true)
    expect(field.value).toBe('12.5 man-days, from the estimate')
  })

  it('say so when the estimate gave none at creation', () => {
    const dialog = renderDialog('fixed_price', {}, fixedTerms(null), withEstimate({ id: 'est-1' }))
    const field = within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement
    expect(field.readOnly).toBe(true)
    expect(field.value).toBe('None: the estimate gave no man-days')
  })

  it('are not sent back on a save: the server refuses them (422 estimated_man_days_from_estimate)', async () => {
    const dialog = renderDialog('fixed_price', {}, fixedTerms(12.5), withEstimate({ id: 'est-1' }))
    fill(dialog, FIELDS.maxEffort, '50')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()!.body).toEqual({
      startDate: '2026-02-01',
      endDate: null,
      terms: { deadline: '2026-12-01', maxEffortManDays: 50 },
    })
  })

  it('stay an editable input on the terms of a hand-made project (no purchase order)', () => {
    const dialog = renderDialog('fixed_price', {}, fixedTerms(12.5))
    expect((within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement).readOnly).toBe(false)
  })

  it('stay an editable input on the terms of a purchase order whose deal had no estimate', () => {
    const dialog = renderDialog('fixed_price', {}, fixedTerms(12.5), withEstimate(null))
    expect((within(dialog).getByLabelText(FIELDS.estimated) as HTMLInputElement).readOnly).toBe(false)
  })
})

describe('an error ends when the field it was about changes (AC-7.1, D53)', () => {
  const REQUIRED = 'This field is required.'
  const invalid = (dialog: HTMLElement, label: RegExp) =>
    within(dialog).getByLabelText(label).getAttribute('aria-invalid')
  const fixed = termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 })

  it('clears the start date’s message and mark on any change, even to a value still wrong; the next submit shows it again', () => {
    const dialog = renderDialog('saas')
    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(invalid(dialog, /Start date/)).toBe('true')

    fill(dialog, /Start date/, '2026-02-01')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    expect(invalid(dialog, /Start date/)).toBeNull()

    // Cleared again: still wrong, and quiet until the next submit.
    fill(dialog, /Start date/, '')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(invalid(dialog, /Start date/)).toBe('true')
  })

  it('clears it when editing too: empty the start date, save, type a date', () => {
    const dialog = renderDialog('fixed_price', {}, fixed)
    fill(dialog, /Start date/, '')
    submit(dialog)
    expect(invalid(dialog, /Start date/)).toBe('true')
    fill(dialog, /Start date/, '2026-03-01')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    expect(invalid(dialog, /Start date/)).toBeNull()
  })

  it('clears an end date that falls before the start when the start date changes', () => {
    const dialog = renderDialog('saas')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, /End date/, '2026-01-01')
    submit(dialog)
    const refusal = 'The end date must not be before the start date.'
    expect(within(dialog).getByText(refusal)).not.toBeNull()
    expect(invalid(dialog, /End date/)).toBe('true')

    fill(dialog, /Start date/, '2025-12-01')
    expect(within(dialog).queryByText(refusal)).toBeNull()
    expect(invalid(dialog, /End date/)).toBeNull()
    expect(sent()).toBeNull()
  })

  it('clears an end date message when the end date changes', () => {
    const dialog = renderDialog('saas')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, /End date/, '2026-01-01')
    submit(dialog)
    fill(dialog, /End date/, '2025-01-01')
    expect(invalid(dialog, /End date/)).toBeNull()
  })

  it('clears each fixed-price member’s message as that member changes and leaves the others', () => {
    const dialog = renderDialog('fixed_price')
    fill(dialog, /Start date/, '2026-02-01')
    fill(dialog, FIELDS.estimated, 'x')
    submit(dialog)
    expect(invalid(dialog, FIELDS.deadline)).toBe('true')
    expect(invalid(dialog, FIELDS.maxEffort)).toBe('true')
    expect(invalid(dialog, FIELDS.estimated)).toBe('true')

    fill(dialog, FIELDS.deadline, '2026-12-01')
    expect(invalid(dialog, FIELDS.deadline)).toBeNull()
    expect(invalid(dialog, FIELDS.maxEffort)).toBe('true')
    expect(invalid(dialog, FIELDS.estimated)).toBe('true')

    fill(dialog, FIELDS.estimated, 'y')
    expect(invalid(dialog, FIELDS.estimated)).toBeNull()
    expect(invalid(dialog, FIELDS.maxEffort)).toBe('true')
  })

  it('clears the SLA and the hour package members one by one', () => {
    const dialog = renderDialog('maintenance')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withHours))
    fill(dialog, FIELDS.slaHigh, '61')
    fill(dialog, FIELDS.slaNormal, '62')
    submit(dialog)
    for (const field of [FIELDS.slaHigh, FIELDS.slaNormal, FIELDS.hours, FIELDS.packageStart]) {
      expect(invalid(dialog, field)).toBe('true')
    }

    fill(dialog, FIELDS.slaHigh, '1')
    expect(invalid(dialog, FIELDS.slaHigh)).toBeNull()
    expect(invalid(dialog, FIELDS.slaNormal)).toBe('true')
    fill(dialog, FIELDS.slaNormal, '3')
    expect(invalid(dialog, FIELDS.slaNormal)).toBeNull()

    fill(dialog, FIELDS.hours, '10')
    expect(invalid(dialog, FIELDS.hours)).toBeNull()
    expect(invalid(dialog, FIELDS.packageStart)).toBe('true')
    fill(dialog, FIELDS.packageStart, '2026-02-01')
    expect(invalid(dialog, FIELDS.packageStart)).toBeNull()
  })

  it('clears the profile of the position it was raised on, not the planned man-days nor another position', () => {
    const dialog = renderDialog('t_and_m')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add position' }))
    submit(dialog)
    const profiles = within(dialog).getAllByLabelText(FIELDS.profile)
    expect(profiles.map((profile) => profile.getAttribute('aria-invalid'))).toEqual(['true', 'true'])

    fireEvent.change(profiles[1]!, { target: { value: 'Tester' } })
    const after = within(dialog).getAllByLabelText(FIELDS.profile)
    expect(after.map((profile) => profile.getAttribute('aria-invalid'))).toEqual(['true', null])
    expect(
      within(dialog)
        .getAllByLabelText(FIELDS.planned)
        .map((planned) => planned.getAttribute('aria-invalid')),
    ).toEqual(['true', 'true'])
  })

  it('drops the positions’ messages when a position is removed (the indexes move)', () => {
    const dialog = renderDialog('t_and_m')
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add position' }))
    submit(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove position 1' }))
    expect(
      within(dialog)
        .getAllByLabelText(FIELDS.profile)
        .map((profile) => profile.getAttribute('aria-invalid')),
    ).toEqual([null])
  })

  it('clears a message the server refused an SLA field with when that field changes', async () => {
    const dialog = renderDialog('maintenance', {
      'POST /projects/p1/terms': () =>
        problem(400, 'validation_failed', { field: 'terms.sla.highDays' }, 'highDays: Too big'),
    })
    fill(dialog, /Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(FIELDS.withSla))
    submit(dialog)
    expect(await within(dialog).findByText('highDays: Too big')).not.toBeNull()
    fill(dialog, FIELDS.slaHigh, '2')
    expect(within(dialog).queryByText('highDays: Too big')).toBeNull()
    expect(invalid(dialog, FIELDS.slaHigh)).toBeNull()
  })
})
