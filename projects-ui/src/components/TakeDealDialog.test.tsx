/**
 * @vitest-environment jsdom
 *
 * TakeDealDialog (AC-1.2, AC-1.3, AC-1.11, AC-3.1, AC-4.1, AC-4.2): a new project from a queued deal — the
 * name prefilled from the deal's title, the four client types (`saas` included), NO project manager (D42),
 * the ops-manager that receives the purchase order (prefilled when there is exactly one), the PO's dates and
 * the type's terms asked in the same step, the man-days of fixed-price terms read-only when the deal has an
 * estimate, the body that reaches `POST /queue/{dealId}/project`, and each refusal in its own words.
 * T31 adds the referent picker and refines the ops-manager picker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, projectDetail } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { ContactChoice, OpsManagerList, QueueItem } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TakeDealDialog from './TakeDealDialog'

const OPS = { id: 'u-ops', name: 'Olga Ops', admin: false }
const ROOT = { id: 'u-root', name: 'Root Admin', admin: true }
const PREFILLED: OpsManagerList = { items: [OPS, ROOT], prefillId: 'u-ops' }

const DEAL: QueueItem = {
  dealId: 'd1',
  title: 'Website relaunch',
  entity: 'welld_ch',
  company: { id: 'c1', name: 'Acme SA' },
  wonAt: '2026-10-20T12:00:00.000Z',
  estimate: { id: 'est-1', name: 'Relaunch estimate' },
}
const WITHOUT_ESTIMATE: QueueItem = { ...DEAL, estimate: null }

// Synthetic contacts only (T18 L2).
const CONTACTS: ContactChoice[] = [
  { id: 'k1', name: 'Jane Roe', jobTitle: 'CTO' },
  { id: 'k2', name: 'Max Mustermann', jobTitle: null },
]

const onCancel = vi.fn()
const onTaken = vi.fn()
const onGone = vi.fn()

const opsSelect = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Ops manager/) as HTMLSelectElement
const referentSelect = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Referent/) as HTMLSelectElement
const readsOf = (path: string) =>
  apiFetch.mock.calls.filter(
    ([input, init]) => new URL(String(input)).pathname === path && !(init as RequestInit | undefined)?.method,
  ).length
const opsReads = () => readsOf('/queue/d1/ops-managers')

const renderDialog = async (
  deal: QueueItem = DEAL,
  routes: Record<string, FakeHandler> = {},
  opsManagers: OpsManagerList = PREFILLED,
  waitForCandidates = true,
) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /queue/d1/ops-managers': () => ({ status: 200, body: opsManagers }),
      'GET /queue/d1/contacts': () => ({ status: 200, body: { items: CONTACTS } }),
      'POST /queue/d1/project': () => ({ status: 201, body: projectDetail({ id: 'pNew', name: deal.title }) }),
      ...routes,
    }),
  )
  render(<TakeDealDialog deal={deal} onCancel={onCancel} onTaken={onTaken} onGone={onGone} />)
  const dialog = screen.getByRole('dialog', { name: 'New project from a deal' })
  // The candidates arrive after the dialog opens: wait for them, so a submit is not a not-yet-loaded one.
  if (waitForCandidates) await waitFor(() => expect(opsSelect(dialog).options.length).toBeGreaterThan(1))
  return dialog
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

const posted = () => {
  const call = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  return call
    ? { url: new URL(String(call[0])), body: JSON.parse(String((call[1] as RequestInit).body)) as unknown }
    : null
}

const setType = (dialog: HTMLElement, type: string) =>
  fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
const setField = (dialog: HTMLElement, label: RegExp, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })

/** A complete fixed-price take: type, dates, deadline and max effort. */
const fillFixedPrice = (dialog: HTMLElement) => {
  setType(dialog, 'fixed_price')
  setField(dialog, /^Start date/, '2026-11-01')
  setField(dialog, /^Deadline/, '2026-12-01')
  setField(dialog, /^Max effort/, '40')
}

describe('the fields (AC-1.2)', () => {
  it('prefills the name from the deal’s title, editable', async () => {
    const dialog = await renderDialog()
    const name = within(dialog).getByLabelText(/^Name/) as HTMLInputElement
    expect(name.value).toBe('Website relaunch')
    fireEvent.change(name, { target: { value: 'Relaunch 2026' } })
    expect(name.value).toBe('Relaunch 2026')
  })

  it('offers the four client types, SaaS included, and never Internal (D40)', async () => {
    const dialog = await renderDialog()
    const options = within(within(dialog).getByLabelText(/^Type/))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['Choose…', 'Time & material', 'Fixed price', 'Maintenance', 'SaaS'])
  })

  it('says whose project this is: the deal’s company and entity, with no company or entity to choose', async () => {
    const dialog = await renderDialog()
    expect(dialog.textContent).toContain('Acme SA')
    expect(dialog.textContent).toContain('wellD CH')
    expect(within(dialog).queryByRole('combobox', { name: /Company/ })).toBeNull()
    expect(within(dialog).queryByLabelText(/entity/i)).toBeNull()
  })

  it('has no project-manager field: the ops manager picks one afterwards (D42)', async () => {
    const dialog = await renderDialog()
    expect(within(dialog).queryByLabelText(/Project manager/)).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: /Project manager/ })).toBeNull()
  })

  it('asks the PO’s dates and the terms of the type chosen, and nothing before a type is chosen (AC-1.3)', async () => {
    const dialog = await renderDialog()
    expect(within(dialog).getByLabelText(/^Start date/)).not.toBeNull()
    expect(within(dialog).getByLabelText(/^End date/)).not.toBeNull()
    expect(within(dialog).queryByLabelText(/^Deadline/)).toBeNull()

    setType(dialog, 'fixed_price')
    expect(within(dialog).getByLabelText(/^Deadline/)).not.toBeNull()
    expect(within(dialog).getByLabelText(/^Max effort/)).not.toBeNull()
    expect(within(dialog).queryByLabelText(/^Profile/)).toBeNull()

    setType(dialog, 'maintenance')
    expect(within(dialog).queryByLabelText(/^Deadline/)).toBeNull()
    expect(within(dialog).getByLabelText('Include an SLA')).not.toBeNull()
    expect(within(dialog).getByLabelText('Include an hour package')).not.toBeNull()

    setType(dialog, 'saas')
    expect(within(dialog).getByLabelText('Include an SLA')).not.toBeNull()

    setType(dialog, 't_and_m')
    expect(within(dialog).getByLabelText(/^Profile/)).not.toBeNull()
    expect(within(dialog).queryByLabelText('Include an SLA')).toBeNull()
  })
})

describe('the ops manager (AC-4.1)', () => {
  it('lists the role’s holders and the admins, the admins marked "All entities", and prefills the only holder', async () => {
    const dialog = await renderDialog()
    expect(
      within(opsSelect(dialog))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose…', 'Olga Ops', 'Root Admin — All entities'])
    expect(opsSelect(dialog).value).toBe('u-ops')
  })

  it('preselects nobody when there is no single holder, and refuses a take without a choice', async () => {
    const dialog = await renderDialog(
      WITHOUT_ESTIMATE,
      {},
      { items: [OPS, { ...OPS, id: 'u-two', name: 'Tom Ops' }], prefillId: null },
    )
    expect(opsSelect(dialog).value).toBe('')
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('Choose who receives this purchase order.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('does not guess among several holders, and an admin alone is never prefilled (D45)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {}, { items: [ROOT], prefillId: null })
    expect(opsSelect(dialog).value).toBe('')
    expect(
      within(opsSelect(dialog))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose…', 'Root Admin — All entities'])
  })

  it('says so when no one at all can receive the purchase order, instead of an empty list', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {}, { items: [], prefillId: null }, false)
    expect(
      await within(dialog).findByText(/No ops manager or administrator is available for this entity/),
    ).not.toBeNull()
  })

  it('an admin can be chosen instead of the prefilled holder, and is the one sent', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    fillFixedPrice(dialog)
    fireEvent.change(opsSelect(dialog), { target: { value: 'u-root' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect((posted()!.body as { opsManagerId: string }).opsManagerId).toBe('u-root')
  })
})

describe('the referent (AC-3.6)', () => {
  it('lists the contacts of the deal’s company, read from the deal’s own route: the client never names a company', async () => {
    const dialog = await renderDialog()
    await waitFor(() =>
      expect(Array.from(referentSelect(dialog).options).map((option) => option.textContent)).toEqual([
        'No referent',
        'Jane Roe — CTO',
        'Max Mustermann',
      ]),
    )
    const read = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/queue/d1/contacts')!
    expect(read.search).toBe('')
    expect(referentSelect(dialog).value).toBe('')
  })

  it('may stay empty: the take carries no referent', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    await waitFor(() => expect(referentSelect(dialog).options.length).toBeGreaterThan(1))
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).not.toHaveProperty('referentContactId')
  })

  it('may stay empty for a company with no contacts', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'GET /queue/d1/contacts': () => ({ status: 200, body: { items: [] } }),
    })
    expect(await within(dialog).findByText(/This company has no contacts in the CRM/)).not.toBeNull()
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).not.toHaveProperty('referentContactId')
  })

  it('sends the chosen contact as referentContactId, and nothing about the contact but its id', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    await waitFor(() => expect(referentSelect(dialog).options.length).toBeGreaterThan(1))
    fillFixedPrice(dialog)
    fireEvent.change(referentSelect(dialog), { target: { value: 'k1' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    const body = posted()!.body as { referentContactId: string }
    expect(body.referentContactId).toBe('k1')
    expect(JSON.stringify(body)).not.toMatch(/Jane|CTO/)
  })

  it('choosing "No referent" again drops it from the take', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    await waitFor(() => expect(referentSelect(dialog).options.length).toBeGreaterThan(1))
    fillFixedPrice(dialog)
    fireEvent.change(referentSelect(dialog), { target: { value: 'k2' } })
    fireEvent.change(referentSelect(dialog), { target: { value: '' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).not.toHaveProperty('referentContactId')
  })

  it('a CRM that cannot list the contacts is said so, and the project can still be created without a referent', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'GET /queue/d1/contacts': () => problem(503, 'crm_unavailable'),
    })
    const message = await within(dialog).findByTestId('take-deal-referent-error')
    expect(message.textContent).toContain('The contacts could not be loaded.')
    expect(message.textContent).toContain('The CRM cannot be reached right now.')
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).not.toHaveProperty('referentContactId')
  })
})

describe('the man-days of fixed-price terms (AC-3.1, AC-3.5)', () => {
  it('are read-only, "from the estimate", for a deal with an estimate', async () => {
    const dialog = await renderDialog(DEAL)
    setType(dialog, 'fixed_price')
    const field = within(dialog).getByLabelText(/^Estimated man-days/) as HTMLInputElement
    expect(field.readOnly).toBe(true)
    expect(field.value).toBe('From the estimate')
  })

  it('are an optional input for a deal without one', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 'fixed_price')
    const field = within(dialog).getByLabelText(/^Estimated man-days/) as HTMLInputElement
    expect(field.readOnly).toBe(false)
    expect(field.value).toBe('')
  })

  it('are not part of the request for a deal with an estimate: the server would refuse them (AC-3.1)', async () => {
    const dialog = await renderDialog(DEAL)
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    const body = posted()!.body as { terms: Record<string, unknown> }
    expect(body.terms).toEqual({
      startDate: '2026-11-01',
      terms: { deadline: '2026-12-01', maxEffortManDays: 40 },
    })
  })
})

describe('taking the deal (AC-1.2, AC-1.3)', () => {
  it('asks a name, a type and the PO’s start date before calling the API', async () => {
    const dialog = await renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  ' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(within(dialog).getAllByText('This field is required.')).toHaveLength(3)
    expect(posted()).toBeNull()
  })

  it('checks the terms of the type before calling the API', async () => {
    const dialog = await renderDialog()
    setType(dialog, 'fixed_price')
    setField(dialog, /^Start date/, '2026-11-01')
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(posted()).toBeNull()
    expect(within(dialog).getAllByText('This field is required.').length).toBeGreaterThanOrEqual(2)
  })

  it('sends the deal’s title as the name, the type, the terms (dates and members side by side) and the ops manager — no project manager', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    fillFixedPrice(dialog)
    setField(dialog, /^Estimated man-days/, '12,5')
    setField(dialog, /^End date/, '2027-02-28')
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    const request = posted()!
    expect(request.url.origin + request.url.pathname).toBe('http://projects-api.test/queue/d1/project')
    expect(request.body).toEqual({
      name: 'Website relaunch',
      type: 'fixed_price',
      terms: {
        startDate: '2026-11-01',
        endDate: '2027-02-28',
        terms: { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 },
      },
      opsManagerId: 'u-ops',
    })
    expect(request.body).not.toHaveProperty('projectManagerId')
    const init = apiFetch.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
    )![1] as RequestInit
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined()
  })

  it('sends the positions of a time-and-material project', async () => {
    const dialog = await renderDialog()
    setType(dialog, 't_and_m')
    setField(dialog, /^Start date/, '2026-11-01')
    setField(dialog, /^Profile/, 'Senior developer')
    setField(dialog, /^Planned man-days/, '20')
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).toEqual({
      name: 'Website relaunch',
      type: 't_and_m',
      terms: {
        startDate: '2026-11-01',
        terms: { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] },
      },
      opsManagerId: 'u-ops',
    })
  })

  it('takes a deal as a SaaS licence project: the licence period, an optional SLA and hour package (D40)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 'saas')
    setField(dialog, /^Start date/, '2026-11-01')
    setField(dialog, /^End date/, '2027-10-31')
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(posted()!.body).toEqual({
      name: 'Website relaunch',
      type: 'saas',
      terms: { startDate: '2026-11-01', endDate: '2027-10-31', terms: { sla: null, hourPackage: null } },
      opsManagerId: 'u-ops',
    })
  })

  it('hands the created project to the page', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await waitFor(() => expect(onTaken).toHaveBeenCalledTimes(1))
    expect((onTaken.mock.calls[0]![0] as { id: string }).id).toBe('pNew')
    expect(onGone).not.toHaveBeenCalled()
  })
})

describe('refusals (AC-1.11, AC-4.2, AC-3.6)', () => {
  const REFUSALS: [string, number, string][] = [
    ['deal_not_found', 404, 'This deal no longer exists in the CRM.'],
    ['deal_not_won', 409, 'This deal is no longer won in the CRM, so it cannot be taken.'],
    ['deal_taken', 409, 'A project has just taken this deal.'],
    ['out_of_scope', 403, 'You may not take deals of this entity.'],
    ['identity_unavailable', 503, 'The user directory cannot be reached right now'],
    ['crm_unavailable', 503, 'The CRM cannot be reached right now. Try again in a moment.'],
    ['estimai_unavailable', 503, 'EstimAI cannot be reached right now'],
    ['estimai_unconfigured', 503, 'EstimAI is not set up for Projects'],
    ['estimated_man_days_from_estimate', 422, 'The estimated man-days come from the deal’s estimate'],
  ]

  it.each(REFUSALS)('%s is said in its own words, with every value kept', async (code, status, text) => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, { 'POST /queue/d1/project': () => problem(status, code) })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect((await within(dialog).findByTestId('take-deal-error')).textContent).toContain(text)
    expect(onTaken).not.toHaveBeenCalled()
    expect((within(dialog).getByLabelText(/^Deadline/) as HTMLInputElement).value).toBe('2026-12-01')
  })

  it('ops_manager_invalid lands on the ops manager, asks for another choice and reads the candidates again (AC-4.2)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(422, 'ops_manager_invalid', {}, 'u-ops lost the role'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(
      await within(dialog).findByText(
        'This person cannot receive the purchase order of this deal. Choose another ops manager.',
      ),
    ).not.toBeNull()
    expect(opsSelect(dialog).getAttribute('aria-invalid')).toBe('true')
    expect(dialog.textContent).not.toContain('lost the role')
    // The candidates are read again, so a person who lost the role is gone from the list.
    await waitFor(() => expect(opsReads()).toBe(2))
    expect(onTaken).not.toHaveBeenCalled()
    expect(onGone).not.toHaveBeenCalled()
  })

  it('referent_invalid lands on the referent in one fixed message, never the server’s detail (T18)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () =>
        problem(422, 'referent_invalid', {}, 'Contact c-42 (Jane Doe) belongs to company Other SA'),
    })
    await waitFor(() => expect(referentSelect(dialog).options.length).toBeGreaterThan(1))
    fillFixedPrice(dialog)
    fireEvent.change(referentSelect(dialog), { target: { value: 'k1' } })
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(
      await within(dialog).findByText(
        'This contact cannot be the referent. Choose another contact, or leave the referent empty.',
      ),
    ).not.toBeNull()
    expect(referentSelect(dialog).getAttribute('aria-invalid')).toBe('true')
    expect(dialog.textContent).not.toMatch(/c-42|Other SA/)
    // The chosen contact stays chosen: changing it is the person's call.
    expect(referentSelect(dialog).value).toBe('k1')
  })

  it('a 422 that names a field of the terms lands on that input, whichever of the take’s paths names it', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () =>
        problem(422, 'validation_failed', { field: 'terms.startDate' }, 'The start date is not a date.'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('The start date is not a date.')).not.toBeNull()
    expect(
      within(dialog)
        .getByLabelText(/^Start date/)
        .getAttribute('aria-invalid'),
    ).toBe('true')
  })

  it('a 422 on the name lands on the name', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(422, 'validation_failed', { field: 'name' }, 'The name is too long.'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('The name is too long.')).not.toBeNull()
    expect(within(dialog).getByLabelText(/^Name/).getAttribute('aria-invalid')).toBe('true')
  })

  it('maintenance_needs_sla_or_hours is said in the terms area, in its own words (terms.terms)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () =>
        problem(422, 'maintenance_needs_sla_or_hours', { field: 'terms.terms' }, 'server words'),
    })
    setType(dialog, 'maintenance')
    setField(dialog, /^Start date/, '2026-11-01')
    fireEvent.click(within(dialog).getByLabelText('Include an SLA'))
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('Add an SLA, an hour package, or both.')).not.toBeNull()
    expect(dialog.textContent).not.toContain('server words')
  })

  it.each(['deal_not_found', 'deal_not_won', 'deal_taken'])(
    '%s tells the page the deal is gone, so the queue reloads without it',
    async (code) => {
      const dialog = await renderDialog(WITHOUT_ESTIMATE, { 'POST /queue/d1/project': () => problem(409, code) })
      fillFixedPrice(dialog)
      fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
      await within(dialog).findByTestId('take-deal-error')
      expect(onGone).toHaveBeenCalledTimes(1)
    },
  )

  it('does not tell the page the deal is gone for a refusal that leaves it takeable', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(503, 'crm_unavailable'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    await within(dialog).findByTestId('take-deal-error')
    expect(onGone).not.toHaveBeenCalled()
  })

  it.each(['terms.terms.deadline'])('puts a 422 that names the take’s field %s on the deadline', async (field) => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(422, 'validation_failed', { field }, 'The deadline is before the start.'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('The deadline is before the start.')).not.toBeNull()
  })

  it('shows the server’s detail for a failure it has no words for', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(500, undefined, {}, 'Boom'),
    })
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect((await within(dialog).findByTestId('take-deal-error')).textContent).toContain('Boom')
  })

  it('says why the ops managers could not be listed (auth down), in its own words', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /queue/d1/ops-managers': () => problem(503, 'identity_unavailable') }))
    render(<TakeDealDialog deal={DEAL} onCancel={onCancel} onTaken={onTaken} onGone={onGone} />)
    const dialog = screen.getByRole('dialog', { name: 'New project from a deal' })
    expect((await within(dialog).findByTestId('take-deal-opsmanager-error')).textContent).toContain(
      'The user directory cannot be reached right now',
    )
  })

  it('says why the ops managers could not be listed (out of scope), and Retry reads them again', async () => {
    let allowed = false
    const dialog = await renderDialog(
      WITHOUT_ESTIMATE,
      {
        'GET /queue/d1/ops-managers': () => (allowed ? { status: 200, body: PREFILLED } : problem(403, 'out_of_scope')),
      },
      PREFILLED,
      false,
    )
    const message = await within(dialog).findByTestId('take-deal-opsmanager-error')
    expect(message.textContent).toContain('You may not take deals of this entity.')
    // Nothing to choose from, so nothing can be taken.
    fillFixedPrice(dialog)
    fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
    expect(await within(dialog).findByText('Choose who receives this purchase order.')).not.toBeNull()
    expect(posted()).toBeNull()
    allowed = true
    fireEvent.click(within(message).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(opsSelect(dialog).value).toBe('u-ops'))
    expect(within(dialog).queryByTestId('take-deal-opsmanager-error')).toBeNull()
  })
})

describe('closing', () => {
  it('Cancel closes without calling the API', async () => {
    const dialog = await renderDialog()
    fireEvent.click(within(dialog).getByTestId('take-deal-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(posted()).toBeNull()
  })
})

describe('an error ends when the field it was about changes (AC-7.1, D53)', () => {
  const REQUIRED = 'This field is required.'
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('take-deal-submit'))
  const invalid = (dialog: HTMLElement, label: RegExp) =>
    within(dialog).getByLabelText(label).getAttribute('aria-invalid')
  const noHolder: OpsManagerList = { items: [OPS, { ...OPS, id: 'u-two', name: 'Tom Ops' }], prefillId: null }

  it('clears the name’s message and mark on any change, even to a value still wrong; the next submit shows it again', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setField(dialog, /^Name/, '')
    submit(dialog)
    expect(within(dialog).getAllByText(REQUIRED).length).toBeGreaterThan(0)
    expect(invalid(dialog, /^Name/)).toBe('true')
    const before = within(dialog).getAllByText(REQUIRED).length

    setField(dialog, /^Name/, '   ')
    expect(within(dialog).queryAllByText(REQUIRED)).toHaveLength(before - 1)
    expect(invalid(dialog, /^Name/)).toBeNull()

    submit(dialog)
    expect(within(dialog).queryAllByText(REQUIRED)).toHaveLength(before)
    expect(invalid(dialog, /^Name/)).toBe('true')
  })

  it('clears the type, the start date and the ops manager messages as each one changes', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {}, noHolder)
    submit(dialog)
    const opsRefusal = 'Choose who receives this purchase order.'
    expect(within(dialog).getAllByText(REQUIRED)).toHaveLength(2) // type, start date
    expect(within(dialog).getByText(opsRefusal)).not.toBeNull()

    setType(dialog, 'fixed_price')
    expect(invalid(dialog, /^Type/)).toBeNull()
    expect(within(dialog).getAllByText(REQUIRED).length).toBeGreaterThan(0)

    setField(dialog, /^Start date/, '2026-11-01')
    expect(invalid(dialog, /^Start date/)).toBeNull()

    fireEvent.change(opsSelect(dialog), { target: { value: 'u-two' } })
    expect(within(dialog).queryByText(opsRefusal)).toBeNull()
    expect(invalid(dialog, /^Ops manager/)).toBeNull()
  })

  it('clears an end date that falls before the start when the start date changes', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    fillFixedPrice(dialog)
    setField(dialog, /^End date/, '2026-10-01')
    submit(dialog)
    const refusal = 'The end date must not be before the start date.'
    expect(within(dialog).getByText(refusal)).not.toBeNull()
    expect(invalid(dialog, /^End date/)).toBe('true')

    setField(dialog, /^Start date/, '2026-09-01')
    expect(within(dialog).queryByText(refusal)).toBeNull()
    expect(invalid(dialog, /^End date/)).toBeNull()
    expect(posted()).toBeNull()
  })

  it('clears each fixed-price member’s own message and leaves the others', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 'fixed_price')
    setField(dialog, /^Start date/, '2026-11-01')
    submit(dialog)
    expect(invalid(dialog, /^Deadline/)).toBe('true')
    expect(invalid(dialog, /^Max effort/)).toBe('true')

    setField(dialog, /^Deadline/, '2026-12-01')
    expect(invalid(dialog, /^Deadline/)).toBeNull()
    expect(invalid(dialog, /^Max effort/)).toBe('true')

    setField(dialog, /^Max effort/, 'x')
    expect(invalid(dialog, /^Max effort/)).toBeNull()
    submit(dialog)
    expect(invalid(dialog, /^Max effort/)).toBe('true')
  })

  it('clears the error of one position’s member, not another’s', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 't_and_m')
    setField(dialog, /^Start date/, '2026-11-01')
    submit(dialog)
    expect(invalid(dialog, /^Profile/)).toBe('true')
    expect(invalid(dialog, /^Planned man-days/)).toBe('true')

    setField(dialog, /^Profile/, 'Developer')
    expect(invalid(dialog, /^Profile/)).toBeNull()
    expect(invalid(dialog, /^Planned man-days/)).toBe('true')
  })

  it('clears an SLA message when the SLA field changes', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 'maintenance')
    setField(dialog, /^Start date/, '2026-11-01')
    fireEvent.click(within(dialog).getByLabelText('Include an SLA'))
    setField(dialog, /High priority/, '61')
    submit(dialog)
    expect(invalid(dialog, /High priority/)).toBe('true')
    setField(dialog, /High priority/, '62')
    expect(invalid(dialog, /High priority/)).toBeNull()
    expect(within(dialog).queryByText('Enter a whole number from 0 to 60.')).toBeNull()
  })

  it('clears a message the server refused a field with when that field changes', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(422, 'validation_failed', { field: 'name' }, 'The name is too long.'),
    })
    fillFixedPrice(dialog)
    submit(dialog)
    expect(await within(dialog).findByText('The name is too long.')).not.toBeNull()
    setField(dialog, /^Name/, 'Relaunch 2026 (b)')
    expect(within(dialog).queryByText('The name is too long.')).toBeNull()
    expect(invalid(dialog, /^Name/)).toBeNull()
  })

  it('clears the referent refusal when another contact is chosen', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE, {
      'POST /queue/d1/project': () => problem(422, 'referent_invalid'),
    })
    await waitFor(() => expect(referentSelect(dialog).options.length).toBeGreaterThan(1))
    fillFixedPrice(dialog)
    fireEvent.change(referentSelect(dialog), { target: { value: 'k1' } })
    submit(dialog)
    expect(await within(dialog).findByText(/This contact cannot be the referent/)).not.toBeNull()
    fireEvent.change(referentSelect(dialog), { target: { value: 'k2' } })
    expect(within(dialog).queryByText(/This contact cannot be the referent/)).toBeNull()
    expect(referentSelect(dialog).getAttribute('aria-invalid')).toBeNull()
  })

  it('drops the previous type’s terms messages when the type changes (the members are reset)', async () => {
    const dialog = await renderDialog(WITHOUT_ESTIMATE)
    setType(dialog, 'fixed_price')
    setField(dialog, /^Start date/, '2026-11-01')
    submit(dialog)
    expect(invalid(dialog, /^Deadline/)).toBe('true')
    setType(dialog, 'maintenance')
    setType(dialog, 'fixed_price')
    expect(invalid(dialog, /^Deadline/)).toBeNull()
  })
})
