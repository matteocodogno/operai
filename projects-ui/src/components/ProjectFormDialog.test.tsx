/**
 * @vitest-environment jsdom
 *
 * ProjectFormDialog (AC-1.1, AC-1.6, AC-4.4, specs/022 AC-5.1, AC-5.3): all five
 * types, the company field for every type but internal, required-field checks
 * before any request, the body that reaches POST /projects, the optional Terms
 * section (collapsed by default, the type's rules once opened), the entities the
 * caller may create for, and the server's refusals landing on the field they name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ScopeContext } from '../hooks/useScope'
import { fakeApi, problem, projectSummary, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Scope } from '../lib/types'
import { strings } from '../strings'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import ProjectFormDialog from './ProjectFormDialog'

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }
const ACME = { id: 'c-acme', name: 'Acme SA', entity: 'welld_ch' }
const created = { ...projectSummary({ id: 'pNew' }), team: [], purchaseOrder: null, terms: null }

const onSaved = vi.fn()
const onCancel = vi.fn()

const renderDialog = (
  routes: Record<string, FakeHandler> = {},
  callerScope: Scope = scope({ manage: ['welld_ch', 'welld_it'] }),
) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [BOB] } }),
      'GET /companies': () => ({ status: 200, body: { items: [ACME] } }),
      'POST /projects': () => ({ status: 201, body: created }),
      ...routes,
    }),
  )
  render(
    <ScopeContext.Provider value={callerScope}>
      <ProjectFormDialog onSaved={onSaved} onCancel={onCancel} />
    </ScopeContext.Provider>,
  )
  return screen.getByRole('dialog', { name: 'New project' })
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
  return call ? (JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>) : null
}

const chooseCompany = async (dialog: HTMLElement) => {
  const input = within(dialog).getByRole('combobox', { name: /Company/ })
  fireEvent.change(input, { target: { value: 'acm' } })
  fireEvent.click(await within(dialog).findByRole('option', { name: /Acme SA/ }))
}

describe('the company field (AC-1.1)', () => {
  it.each(['t_and_m', 'fixed_price', 'maintenance', 'saas'])(
    'is offered, and required, for a %s project (a SaaS has a company, D40)',
    (type) => {
      const dialog = renderDialog()
      fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
      expect(within(dialog).getByRole('combobox', { name: /Company/ })).not.toBeNull()
    },
  )

  it.each(['internal'])('is not offered for a %s project', (type) => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
    expect(within(dialog).queryByRole('combobox', { name: /Company/ })).toBeNull()
  })

  it('is not offered until a type is chosen', () => {
    const dialog = renderDialog()
    expect(within(dialog).queryByRole('combobox', { name: /Company/ })).toBeNull()
  })

  it('looks companies up as the person types, through projects-api', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'fixed_price' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Company/ }), { target: { value: 'acm' } })
    expect(await within(dialog).findByRole('option', { name: /Acme SA/ })).not.toBeNull()
    const lookup = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/companies')!
    expect(lookup.origin).toBe('http://projects-api.test')
    expect(lookup.searchParams.get('q')).toBe('acm')
  })

  it('says the CRM is unavailable when the lookup answers 503 crm_unavailable', async () => {
    const dialog = renderDialog({ 'GET /companies': () => problem(503, 'crm_unavailable') })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'fixed_price' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Company/ }), { target: { value: 'acm' } })
    expect(
      await within(dialog).findByText('The CRM cannot be reached right now. Try again in a moment.'),
    ).not.toBeNull()
  })
})

describe('creating a project (AC-1.1)', () => {
  it('asks for a name, a type and an entity before calling the API', () => {
    const dialog = renderDialog()
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(within(dialog).getAllByText('This field is required.')).toHaveLength(3)
    expect(posted()).toBeNull()
  })

  it('asks a client project for its company before calling the API', () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Intranet' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(within(dialog).getByText('Choose a company from the list.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('sends a client project with its company, the project manager defaulting to the caller', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  Intranet  ' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_it' } })
    await chooseCompany(dialog)
    expect((within(dialog).getByRole('combobox', { name: /Project manager/ }) as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    )
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
    expect(posted()).toEqual({ name: 'Intranet', type: 't_and_m', entity: 'welld_it', companyId: 'c-acme' })
  })

  it('sends a SaaS project with its company: one project per licence (D40)', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Koordy' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'saas' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    await chooseCompany(dialog)
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Koordy', type: 'saas', entity: 'welld_ch', companyId: 'c-acme' })
  })

  it('refuses a SaaS project without a company before any request', () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Koordy' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'saas' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(within(dialog).getByText('Choose a company from the list.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('drops a chosen company when the type changes to one that has none', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Koordy' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'maintenance' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    await chooseCompany(dialog)
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).not.toHaveProperty('companyId')
  })

  it('sends another project manager when one is picked from the module’s people (ADR-0055)', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Ops tooling', type: 'internal', entity: 'welld_ch', projectManagerId: 'u-bob' })
    const directory = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/authz/users/directory')!
    expect(directory.searchParams.get('appId')).toBe('projects')
  })
})

/** The base of a hand-made project of `type`, with a company when it needs one: everything but the terms. */
const fillBase = async (dialog: HTMLElement, type: string, name = 'Koordy') => {
  fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: name } })
  fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
  fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
  if (type !== 'internal') await chooseCompany(dialog)
}
const termsToggle = (dialog: HTMLElement) => within(dialog).queryByRole('button', { name: /^Terms/ })
const openTerms = (dialog: HTMLElement) => fireEvent.click(termsToggle(dialog)!)
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
const setField = (dialog: HTMLElement, label: RegExp, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })

describe('the optional Terms section (AC-5.3)', () => {
  it.each(['t_and_m', 'fixed_price', 'maintenance', 'saas'])(
    'is offered for a %s project, collapsed: no terms field until it is opened',
    (type) => {
      const dialog = renderDialog()
      setField(dialog, /^Type/, type)
      const toggle = termsToggle(dialog)!
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(within(dialog).queryByLabelText(/^Start date/)).toBeNull()
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(within(dialog).getByLabelText(/^Start date/)).not.toBeNull()
    },
  )

  it('is not offered for an internal project, nor before a type is chosen', () => {
    const dialog = renderDialog()
    expect(termsToggle(dialog)).toBeNull()
    setField(dialog, /^Type/, 'internal')
    expect(termsToggle(dialog)).toBeNull()
  })

  it.each([
    ['fixed_price', [/^Deadline/, /^Max effort/]],
    ['maintenance', [/^Include an SLA/, /^Include an hour package/]],
    ['saas', [/^Include an SLA/, /^Include an hour package/]],
    ['t_and_m', [/^Profile/, /^Planned man-days/]],
  ] as const)('once opened, asks the terms of a %s project (the type’s own fields)', (type, labels) => {
    const dialog = renderDialog()
    setField(dialog, /^Type/, type)
    openTerms(dialog)
    expect(within(dialog).getByLabelText(/^Start date/)).not.toBeNull()
    expect(within(dialog).getByLabelText(/^End date/)).not.toBeNull()
    for (const label of labels) expect(within(dialog).getByLabelText(label)).not.toBeNull()
  })

  it('shows the fields of the type chosen now when the type changes after opening', () => {
    const dialog = renderDialog()
    setField(dialog, /^Type/, 'fixed_price')
    openTerms(dialog)
    setField(dialog, /^Type/, 't_and_m')
    expect(within(dialog).queryByLabelText(/^Deadline/)).toBeNull()
    expect(within(dialog).getByLabelText(/^Profile/)).not.toBeNull()
  })

  it('creates with no terms when left closed: no `terms` member at all', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 'fixed_price')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).not.toHaveProperty('terms')
  })

  it('creates with no terms when opened and closed again, whatever was typed in it', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 'fixed_price')
    openTerms(dialog)
    setField(dialog, /^Deadline/, '2026-12-01')
    openTerms(dialog)
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).not.toHaveProperty('terms')
  })

  it('sends no terms for an internal project even if the section was opened for another type', async () => {
    const dialog = renderDialog()
    setField(dialog, /^Type/, 'fixed_price')
    openTerms(dialog)
    setField(dialog, /^Start date/, '2026-02-01')
    await fillBase(dialog, 'internal')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).not.toHaveProperty('terms')
  })
})

describe('the terms of a type, once opened (AC-5.3)', () => {
  const refused = async (type: string, fill: (dialog: HTMLElement) => void = () => undefined) => {
    const dialog = renderDialog()
    await fillBase(dialog, type)
    openTerms(dialog)
    fill(dialog)
    submit(dialog)
    return dialog
  }
  const errorIn = (dialog: HTMLElement, testId: string, text: string) =>
    within(within(dialog).getByTestId(testId)).getByText(text)

  it('asks a start date of every set of terms', async () => {
    const dialog = await refused('saas')
    expect(errorIn(dialog, 'projects-form-terms-startDate', 'This field is required.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('fixed price: the deadline and the max effort together', async () => {
    const dialog = await refused('fixed_price', (d) => setField(d, /^Start date/, '2026-02-01'))
    expect(errorIn(dialog, 'projects-form-terms-deadline', 'This field is required.')).not.toBeNull()
    expect(errorIn(dialog, 'projects-form-terms-max-effort', 'This field is required.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('fixed price: a deadline without a max effort is refused', async () => {
    const dialog = await refused('fixed_price', (d) => {
      setField(d, /^Start date/, '2026-02-01')
      setField(d, /^Deadline/, '2026-12-01')
    })
    expect(
      within(within(dialog).getByTestId('projects-form-terms-deadline')).queryByText('This field is required.'),
    ).toBeNull()
    expect(errorIn(dialog, 'projects-form-terms-max-effort', 'This field is required.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('maintenance: an SLA or an hour package, at least one', async () => {
    const dialog = await refused('maintenance', (d) => setField(d, /^Start date/, '2026-02-01'))
    expect(within(dialog).getByText('Add an SLA, an hour package, or both.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('time and material: each position needs man-days above zero', async () => {
    const dialog = await refused('t_and_m', (d) => {
      setField(d, /^Start date/, '2026-02-01')
      setField(d, /^Profile/, 'Senior developer')
      setField(d, /^Planned man-days/, '0')
    })
    expect(within(dialog).getByText('Enter man-days above 0, with at most one decimal.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('an end date before the start date is refused', async () => {
    const dialog = await refused('saas', (d) => {
      setField(d, /^Start date/, '2026-02-01')
      setField(d, /^End date/, '2026-01-01')
    })
    expect(within(dialog).getByText('The end date must not be before the start date.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('the project’s own fields are checked with the section open too', () => {
    const dialog = renderDialog()
    setField(dialog, /^Type/, 'saas')
    openTerms(dialog)
    submit(dialog)
    expect(within(dialog).getByText('Choose a company from the list.')).not.toBeNull()
    expect(errorIn(dialog, 'projects-form-terms-startDate', 'This field is required.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('fixed price: sends the dates and the members nested under `terms`, with the project', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 'fixed_price', 'Website')
    openTerms(dialog)
    setField(dialog, /^Start date/, '2026-02-01')
    setField(dialog, /^Deadline/, '2026-12-01')
    setField(dialog, /^Max effort/, '40')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
    expect(posted()).toEqual({
      name: 'Website',
      type: 'fixed_price',
      entity: 'welld_ch',
      companyId: 'c-acme',
      terms: {
        startDate: '2026-02-01',
        terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 },
      },
    })
  })

  it('time and material: sends its positions', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 't_and_m', 'Retainer')
    openTerms(dialog)
    setField(dialog, /^Start date/, '2026-02-01')
    setField(dialog, /^End date/, '2026-12-31')
    setField(dialog, /^Profile/, 'Senior developer')
    setField(dialog, /^Planned man-days/, '20')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()?.['terms']).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-12-31',
      terms: { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] },
    })
  })

  it('SaaS: the licence period alone is a valid set of terms (no SLA, no hour package)', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 'saas')
    openTerms(dialog)
    expect(within(dialog).getByText('The licence period: from the start date to the optional end date.')).not.toBeNull()
    setField(dialog, /^Start date/, '2026-02-01')
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()?.['terms']).toEqual({ startDate: '2026-02-01', terms: { sla: null, hourPackage: null } })
  })

  it('maintenance: an SLA alone, with the prefilled take-in-charge times', async () => {
    const dialog = renderDialog()
    await fillBase(dialog, 'maintenance')
    openTerms(dialog)
    setField(dialog, /^Start date/, '2026-02-01')
    fireEvent.click(within(dialog).getByLabelText(/^Include an SLA/))
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()?.['terms']).toEqual({
      startDate: '2026-02-01',
      terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
    })
  })
})

describe('the project manager field', () => {
  it('shows the caller read-only when the directory refuses them, and still creates with the caller as manager', async () => {
    const dialog = renderDialog({ 'GET /authz/users/directory': () => problem(403, 'forbidden') })
    const field = await within(dialog).findByTestId('projects-form-manager-readonly')
    expect((field as HTMLInputElement).value).toBe('Ada Lovelace')
    expect(within(dialog).getByText('Only people who manage projects can choose someone else.')).not.toBeNull()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Ops tooling', type: 'internal', entity: 'welld_ch' })
  })
})

describe('an error ends when the value it was about changes (QE D2, after a failed submit)', () => {
  const COMPANY_ERROR = 'Choose a company from the list.'
  const REQUIRED = 'This field is required.'

  it('clears "Choose a company" once a company is chosen', async () => {
    const dialog = renderDialog()
    setField(dialog, /^Name/, 'Intranet')
    setField(dialog, /^Type/, 't_and_m')
    setField(dialog, /wellD entity/, 'welld_ch')
    submit(dialog)
    expect(within(dialog).getByText(COMPANY_ERROR)).not.toBeNull()
    await chooseCompany(dialog)
    expect(within(dialog).queryByText(COMPANY_ERROR)).toBeNull()
  })

  it('does not bring a company error back from a type that had none', async () => {
    const dialog = renderDialog()
    setField(dialog, /^Name/, 'Intranet')
    setField(dialog, /^Type/, 't_and_m')
    setField(dialog, /wellD entity/, 'welld_ch')
    submit(dialog)
    setField(dialog, /^Type/, 'internal')
    setField(dialog, /^Type/, 'saas')
    expect(within(dialog).queryByText(COMPANY_ERROR)).toBeNull()
  })

  it('clears "required" on the name, the type and the entity as each is filled in', () => {
    const dialog = renderDialog()
    submit(dialog)
    expect(within(dialog).getAllByText(REQUIRED)).toHaveLength(3)
    setField(dialog, /^Name/, 'Intranet')
    expect(within(dialog).getAllByText(REQUIRED)).toHaveLength(2)
    setField(dialog, /^Type/, 'internal')
    expect(within(dialog).getAllByText(REQUIRED)).toHaveLength(1)
    setField(dialog, /wellD entity/, 'welld_ch')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
  })

  it('clears the project manager error once a person is picked', async () => {
    const dialog = renderDialog()
    setField(dialog, /^Name/, 'Ops tooling')
    setField(dialog, /^Type/, 'internal')
    setField(dialog, /wellD entity/, 'welld_ch')
    const manager = within(dialog).getByRole('combobox', { name: /Project manager/ })
    // Typing over the caller's name un-chooses them: the project has no project manager until one is picked.
    fireEvent.change(manager, { target: { value: 'bo' } })
    submit(dialog)
    const refusal = strings.people.picker.pickRequired
    expect(within(dialog).getByText(refusal)).not.toBeNull()
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    expect(within(dialog).queryByText(refusal)).toBeNull()
  })

  it('clears a server refusal on the project manager once another person is picked', async () => {
    const dialog = renderDialog({ 'POST /projects': () => problem(422, 'not_project_user') })
    setField(dialog, /^Name/, 'Ops tooling')
    setField(dialog, /^Type/, 'internal')
    setField(dialog, /wellD entity/, 'welld_ch')
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    submit(dialog)
    const refusal = await within(dialog).findByText(strings.projects.form.errors.not_project_user)
    expect(refusal).not.toBeNull()
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Project manager/ }), { target: { value: 'x' } })
    expect(within(dialog).queryByText(strings.projects.form.errors.not_project_user)).toBeNull()
  })

  it('clears the start date error once a date is entered', () => {
    const dialog = renderDialog()
    setField(dialog, /^Name/, 'Ops tooling')
    setField(dialog, /^Type/, 'fixed_price')
    setField(dialog, /wellD entity/, 'welld_ch')
    openTerms(dialog)
    submit(dialog)
    expect(within(dialog).getAllByText(REQUIRED).length).toBeGreaterThan(0)
    const before = within(dialog).getAllByText(REQUIRED).length
    setField(dialog, /Start date/, '2026-12-01')
    expect(within(dialog).queryAllByText(REQUIRED).length).toBe(before - 1)
  })

  it('clears an end date before the start when the start date changes, and a terms member’s message when it changes (AC-7.1)', () => {
    const dialog = renderDialog()
    setField(dialog, /^Name/, 'Ops tooling')
    setField(dialog, /^Type/, 'fixed_price')
    setField(dialog, /wellD entity/, 'welld_ch')
    openTerms(dialog)
    setField(dialog, /Start date/, '2026-12-01')
    setField(dialog, /End date/, '2026-11-01')
    submit(dialog)
    const invalid = (label: RegExp) => within(dialog).getByLabelText(label).getAttribute('aria-invalid')
    expect(invalid(/End date/)).toBe('true')
    expect(invalid(/^Deadline/)).toBe('true')
    expect(invalid(/^Max effort/)).toBe('true')

    setField(dialog, /Start date/, '2026-10-01')
    expect(invalid(/End date/)).toBeNull()
    setField(dialog, /^Deadline/, '2027-01-01')
    expect(invalid(/^Deadline/)).toBeNull()
    expect(invalid(/^Max effort/)).toBe('true')
  })
})

describe('the entity a caller may create for (AC-4.4)', () => {
  it('offers both entities to a caller who manages both', () => {
    const dialog = renderDialog()
    const options = within(within(dialog).getByLabelText(/wellD entity/))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['Choose…', 'wellD CH', 'wellD IT'])
  })

  it('offers only the managed entity to an entity-scoped caller, and preselects it', async () => {
    const dialog = renderDialog({}, scope({ manage: ['welld_it'] }))
    const select = within(dialog).getByLabelText(/wellD entity/) as HTMLSelectElement
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['wellD IT'])
    expect(select.value).toBe('welld_it')
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toMatchObject({ entity: 'welld_it' })
  })
})

describe('the server’s refusals', () => {
  const submitInternal = async (routes: Record<string, FakeHandler>) => {
    const dialog = renderDialog(routes)
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    return dialog
  }

  it('puts a project manager without access on the project manager field (AC-1.6)', async () => {
    const dialog = await submitInternal({
      'POST /projects': () => problem(422, 'not_project_user', { userIds: ['u-ada'] }),
    })
    expect(
      await within(dialog).findByText('This person has no access to Projects. Choose someone who does.'),
    ).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('puts an out-of-scope entity on the entity field (AC-4.4)', async () => {
    const dialog = await submitInternal({ 'POST /projects': () => problem(403, 'out_of_scope') })
    expect(await within(dialog).findByText('You may not create projects for this entity.')).not.toBeNull()
  })

  it('puts a refused company on the company field', async () => {
    const dialog = renderDialog({ 'POST /projects': () => problem(422, 'company_not_found') })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Intranet' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    await chooseCompany(dialog)
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(await within(dialog).findByText('This company no longer exists in the CRM. Choose another.')).not.toBeNull()
  })

  it('puts a validation error on the field the server names', async () => {
    const dialog = await submitInternal({
      'POST /projects': () => problem(400, 'validation_failed', { field: 'name' }, 'name: Required'),
    })
    expect(await within(dialog).findByText('name: Required')).not.toBeNull()
  })

  it.each([
    ['company_required', 'A client project needs a company.'],
    ['company_not_allowed', 'An internal project has no company.'],
  ])('puts %s on the company field, in its own words (AC-5.1)', async (code, message) => {
    const dialog = renderDialog({ 'POST /projects': () => problem(422, code) })
    await fillBase(dialog, 'saas')
    submit(dialog)
    expect(await within(dialog).findByText(message)).not.toBeNull()
    expect(within(within(dialog).getByTestId('projects-form-company')).getByText(message)).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('says an internal project takes no terms when the server refuses terms_not_allowed (AC-5.3)', async () => {
    const dialog = await submitInternal({ 'POST /projects': () => problem(422, 'terms_not_allowed') })
    expect((await within(dialog).findByTestId('projects-form-error')).textContent).toContain(
      'An internal project takes no terms.',
    )
  })

  describe('a refusal that names a field of the terms, by its path in the create (AC-5.3)', () => {
    const openedAs = async (type: string, answer: ReturnType<typeof problem>, fill: (d: HTMLElement) => void) => {
      const dialog = renderDialog({ 'POST /projects': () => answer })
      await fillBase(dialog, type)
      openTerms(dialog)
      fill(dialog)
      submit(dialog)
      return dialog
    }
    const fixedPrice = (d: HTMLElement) => {
      setField(d, /^Start date/, '2026-02-01')
      setField(d, /^Deadline/, '2026-12-01')
      setField(d, /^Max effort/, '40')
    }

    it('terms.terms.deadline lands on the deadline input, the dialog stays open with every value kept', async () => {
      const dialog = await openedAs(
        'fixed_price',
        problem(422, 'validation_failed', { field: 'terms.terms.deadline' }, 'The deadline must be after the start.'),
        fixedPrice,
      )
      const message = await within(dialog).findByText('The deadline must be after the start.')
      expect(
        within(within(dialog).getByTestId('projects-form-terms-deadline')).getByText(message.textContent!),
      ).not.toBeNull()
      expect((within(dialog).getByLabelText(/^Max effort/) as HTMLInputElement).value).toBe('40')
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('terms.startDate lands on the start date input', async () => {
      const dialog = await openedAs(
        'fixed_price',
        problem(422, 'validation_failed', { field: 'terms.startDate' }, 'Not a valid date.'),
        fixedPrice,
      )
      await within(dialog).findByText('Not a valid date.')
      expect(
        within(within(dialog).getByTestId('projects-form-terms-startDate')).getByText('Not a valid date.'),
      ).not.toBeNull()
    })

    it('a position’s path lands on that position’s input', async () => {
      const dialog = await openedAs(
        't_and_m',
        problem(422, 'validation_failed', { field: 'terms.terms.positions.0.profile' }, 'Too long.'),
        (d) => {
          setField(d, /^Start date/, '2026-02-01')
          setField(d, /^Profile/, 'Senior developer')
          setField(d, /^Planned man-days/, '20')
        },
      )
      const message = await within(dialog).findByText('Too long.')
      expect(within(within(dialog).getByRole('group', { name: 'Position 1' })).getByText('Too long.')).toBe(message)
    })

    it('maintenance_needs_sla_or_hours lands on the terms, in its own words', async () => {
      const dialog = await openedAs('maintenance', problem(422, 'maintenance_needs_sla_or_hours'), (d) => {
        setField(d, /^Start date/, '2026-02-01')
        fireEvent.click(within(d).getByLabelText(/^Include an SLA/))
      })
      await within(dialog).findByText('Add an SLA, an hour package, or both.')
      expect(
        within(within(dialog).getByTestId('projects-form-terms-terms-error')).getByText(
          'Add an SLA, an hour package, or both.',
        ),
      ).not.toBeNull()
    })

    it('a path of the terms is ignored when no terms were sent: the dialog shows the server’s message instead', async () => {
      const dialog = renderDialog({
        'POST /projects': () =>
          problem(422, 'validation_failed', { field: 'terms.terms.deadline' }, 'Something about the terms.'),
      })
      await fillBase(dialog, 'fixed_price')
      submit(dialog)
      expect((await within(dialog).findByTestId('projects-form-error')).textContent).toContain(
        'Something about the terms.',
      )
    })
  })

  it('shows anything else in the dialog, keeping what was typed', async () => {
    const dialog = await submitInternal({ 'POST /projects': () => problem(503, 'authz_unavailable') })
    expect((await within(dialog).findByTestId('projects-form-error')).textContent).toContain(
      'Authorization service unavailable',
    )
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Ops tooling')
  })

  it('Cancel closes without a request', () => {
    const dialog = renderDialog()
    fireEvent.click(within(dialog).getByTestId('projects-form-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(posted()).toBeNull()
  })
})
