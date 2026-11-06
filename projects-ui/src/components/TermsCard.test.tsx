/**
 * @vitest-environment jsdom
 *
 * TermsCard (specs/021 AC-2.3 – AC-2.9, specs/022 AC-5.2 – AC-5.4, S5): the terms of a hand-made project — its
 * dates and its type's terms, no amount anywhere, "Add terms" / "Edit" / "Set end date" / "Remove terms" for
 * a holder of manage projects only, nothing of a purchase order, and none shown when the project has none.
 * Removing them is confirmed in a dialog of the page, never `window.confirm()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, projectDetail, purchaseOrderOf, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Project, ProjectState, ProjectType, Terms, TermsType, TermsView } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TermsCard from './TermsCard'

const TERMS: Record<string, [TermsType, TermsView, string[]]> = {
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

/** A hand-made project: no purchase order, and its terms when given. */
const handMade = (type: ProjectType, terms: Terms | null, over: Partial<Project> = {}): Project =>
  projectDetail({
    type,
    company: type === 'internal' ? null : { id: 'c1', name: 'Acme SA' },
    purchaseOrder: null,
    terms,
    startDate: terms?.startDate ?? null,
    endDate: terms?.endDate ?? null,
    ...over,
  })

const renderCard = (project: Project, canManage = true, routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(fakeApi(routes))
  render(<TermsCard project={project} canManage={canManage} onChanged={onChanged} onStale={onStale} />)
  return screen.getByTestId('project-terms')
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

describe('the terms of a hand-made project (AC-5.4, AC-2.3 – AC-2.8)', () => {
  it.each(Object.entries(TERMS))('%s: shows the dates and its own terms', (_name, [type, members, texts]) => {
    const card = renderCard(handMade(type, termsOf(type, members)))
    expect(within(card).getByRole('heading', { level: 3, name: 'Terms' })).not.toBeNull()
    expect(card.textContent).toContain('01.02.2026')
    expect(card.textContent).toContain('Open-ended')
    for (const text of texts) expect(card.textContent).toContain(text)
  })

  it('shows an end date when the terms have one', () => {
    const card = renderCard(
      handMade('saas', termsOf('saas', { sla: null, hourPackage: null }, { endDate: '2026-12-31' })),
    )
    expect(card.textContent).toContain('31.12.2026')
    expect(card.textContent).not.toContain('Open-ended')
  })

  it.each(Object.entries(TERMS))('%s: renders no amount, price or rate (AC-2.9)', (_name, [type, members]) => {
    const card = renderCard(handMade(type, termsOf(type, members)))
    expect(card.textContent).not.toMatch(/\b(price|rate|amount|fee|budget|cost)\b|CHF|EUR|€/i)
  })

  it('shows none, and an "Add terms" control for a manager, when the project has none (AC-5.4)', () => {
    const card = renderCard(handMade('fixed_price', null))
    expect(card.textContent).toContain('No terms yet.')
    expect(within(card).getByRole('button', { name: 'Add terms' })).not.toBeNull()
  })

  it('is no card of a purchase order: no deal, no estimate, no Bexio field, no referent, no ops manager (AC-5.2)', () => {
    const card = renderCard(handMade('fixed_price', termsOf('fixed_price', TERMS.fixed_price![1])))
    expect(card.textContent).not.toMatch(/purchase order|deal|estimate\b|bexio|referent|ops manager/i)
    expect(within(card).queryByRole('link')).toBeNull()
  })
})

describe('who may add, edit or end terms (AC-4.4)', () => {
  it('a reader gets no "Add terms", no Edit and no end-date control', () => {
    const none = renderCard(handMade('fixed_price', null), false)
    expect(within(none).queryByRole('button')).toBeNull()
    cleanup()
    const some = renderCard(handMade('saas', termsOf('saas', { sla: null, hourPackage: null })), false)
    expect(within(some).queryByRole('button')).toBeNull()
  })

  it.each<ProjectState>(['planned', 'active', 'on_hold'])('"Add terms" is offered on a %s project', (state) => {
    renderCard(handMade('maintenance', null, { state }))
    expect(screen.queryByRole('button', { name: 'Add terms' })).not.toBeNull()
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'a %s project takes no new terms: no button, and a note says why; existing terms can still be edited',
    (state) => {
      const none = renderCard(handMade('maintenance', null, { state }))
      expect(within(none).queryByRole('button', { name: 'Add terms' })).toBeNull()
      expect(none.textContent).toContain('takes no new terms')
      cleanup()
      const some = renderCard(handMade('saas', termsOf('saas', { sla: null, hourPackage: null }), { state }))
      expect(within(some).getByRole('button', { name: 'Edit' })).not.toBeNull()
    },
  )

  it('an internal project has no terms and no button', () => {
    const card = renderCard(handMade('internal', null))
    expect(card.textContent).toContain('Internal projects have no terms.')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('an ended set of terms is edited (to change or clear the end date), not ended again', () => {
    const card = renderCard(
      handMade('saas', termsOf('saas', { sla: null, hourPackage: null }, { endDate: '2026-12-31' })),
    )
    expect(within(card).getByRole('button', { name: 'Edit' })).not.toBeNull()
    expect(within(card).queryByRole('button', { name: 'Set end date' })).toBeNull()
  })
})

describe('adding terms to a hand-made project (AC-5.4, S5)', () => {
  it('POSTs the dates and the type’s members, and tells the page', async () => {
    const card = renderCard(handMade('fixed_price', null), true, {
      'POST /projects/p1/terms': () => ({
        status: 201,
        body: termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 }),
      }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Add terms' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add terms' })
    fireEvent.change(within(dialog).getByLabelText(/^Start date/), { target: { value: '2026-02-01' } })
    fireEvent.change(within(dialog).getByLabelText(/^Deadline/), { target: { value: '2026-12-01' } })
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '40' } })
    fireEvent.click(within(dialog).getByTestId('terms-form-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/projects/p1/terms',
        ifMatch: undefined,
        body: {
          startDate: '2026-02-01',
          terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 },
        },
      },
    ])
    expect(onChanged).toHaveBeenCalledWith('Terms added.')
  })
})

describe('editing terms (specs/021 AC-1.7)', () => {
  it('opens the form on the stored terms, PATCHes with the terms version, and tells the page', async () => {
    const stored = termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 })
    const card = renderCard(handMade('fixed_price', stored), true, {
      'PATCH /projects/p1/terms': () => ({
        status: 200,
        body: { ...stored, terms: { ...stored.terms, maxEffortManDays: 55 }, version: 5 },
      }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit terms' })
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '55' } })
    fireEvent.click(within(dialog).getByTestId('terms-form-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        path: '/projects/p1/terms',
        ifMatch: '"4"',
        body: {
          startDate: '2026-02-01',
          endDate: null,
          terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 55 },
        },
      },
    ])
    expect(onChanged).toHaveBeenCalledWith('Terms saved.')
  })
})

describe('setting the end date (specs/021 AC-2.10)', () => {
  const stored = termsOf('saas', { sla: null, hourPackage: null })

  it('asks for the date, PATCHes only the end date with the version, and tells the page', async () => {
    const card = renderCard(handMade('saas', stored), true, {
      'PATCH /projects/p1/terms': () => ({ status: 200, body: { ...stored, endDate: '2026-06-30', version: 5 } }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Set end date' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set the end date' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-06-30' } })
    fireEvent.click(within(dialog).getByTestId('terms-end-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([
      { method: 'PATCH', path: '/projects/p1/terms', ifMatch: '"4"', body: { endDate: '2026-06-30' } },
    ])
    expect(onChanged).toHaveBeenCalledWith('End date saved.')
  })

  it('an end date before the start date is refused before any request', async () => {
    const card = renderCard(handMade('saas', stored))
    fireEvent.click(within(card).getByRole('button', { name: 'Set end date' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set the end date' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-01-01' } })
    fireEvent.click(within(dialog).getByTestId('terms-end-submit'))
    expect(await within(dialog).findByText('The end date must not be before the start date.')).not.toBeNull()
    expect(writes()).toEqual([])
  })

  it('a stale end (409 version_conflict) closes the dialog and is the page’s to handle', async () => {
    const card = renderCard(handMade('saas', stored), true, {
      'PATCH /projects/p1/terms': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Set end date' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set the end date' })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-06-30' } })
    fireEvent.click(within(dialog).getByTestId('terms-end-submit'))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('removing the terms of a hand-made project (S5)', () => {
  const stored = termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 })
  const remove = (routes: Record<string, FakeHandler> = {}, project = handMade('fixed_price', stored)) => {
    const card = renderCard(project, true, routes)
    fireEvent.click(within(card).getByRole('button', { name: 'Remove terms' }))
    return card
  }

  it('is offered to a holder of manage projects on a hand-made project that has terms', () => {
    const card = renderCard(handMade('fixed_price', stored))
    expect(within(card).getByRole('button', { name: 'Remove terms' })).not.toBeNull()
  })

  it.each<[string, Project, boolean]>([
    ['a reader', handMade('fixed_price', stored), false],
    ['a project with no terms', handMade('fixed_price', null), true],
    ['an internal project', handMade('internal', null), true],
    [
      'a project with a purchase order, whose terms are never removed (AC-5.2)',
      handMade('fixed_price', stored, { purchaseOrder: purchaseOrderOf() }),
      true,
    ],
  ])('is not offered to %s', (_name, project, canManage) => {
    const card = renderCard(project, canManage)
    expect(within(card).queryByRole('button', { name: 'Remove terms' })).toBeNull()
  })

  it('is still offered on a closed project: existing terms stay editable', () => {
    const card = renderCard(handMade('fixed_price', stored, { state: 'closed' }))
    expect(within(card).getByRole('button', { name: 'Remove terms' })).not.toBeNull()
  })

  it('asks for confirmation in the page, with no request yet and no window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    remove()
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the terms?' })
    expect(dialog.textContent).toContain('The project stays')
    expect(writes()).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('Cancel keeps the terms: the dialog closes and nothing is sent', async () => {
    remove()
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByTestId('terms-remove-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes()).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('confirming DELETEs the terms with their version, closes, and tells the page', async () => {
    remove({ 'DELETE /projects/p1/terms': () => ({ status: 204 }) })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByTestId('terms-remove-confirm'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(writes()).toEqual([{ method: 'DELETE', path: '/projects/p1/terms', ifMatch: '"4"', body: null }])
    expect(onChanged).toHaveBeenCalledWith('Terms removed.')
  })

  it('a stale remove (409 version_conflict) closes the dialog and is the page’s to handle', async () => {
    remove({ 'DELETE /projects/p1/terms': () => problem(409, 'version_conflict', { currentVersion: 9 }) })
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('terms-remove-confirm'))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'terms_required', 'The terms of a project with a purchase order cannot be removed.'],
    [404, 'terms_not_found', 'This project has no terms yet. Reload the page.'],
    [409, 'project_not_open', 'A closed or cancelled project takes no new terms. Reopen it first.'],
    [403, 'out_of_scope', 'You may not change the terms of this entity.'],
  ])('%s %s keeps the dialog open with its own message and changes nothing', async (status, code, message) => {
    remove({ 'DELETE /projects/p1/terms': () => problem(status, code) })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByTestId('terms-remove-confirm'))
    expect((await within(dialog).findByTestId('terms-remove-error')).textContent).toBe(message)
    expect(onChanged).not.toHaveBeenCalled()
    expect(onStale).not.toHaveBeenCalled()
  })

  it('any other failure shows the server’s message in the dialog, which stays open', async () => {
    remove({ 'DELETE /projects/p1/terms': () => problem(500, undefined, {}, 'boom') })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByTestId('terms-remove-confirm'))
    expect((await within(dialog).findByTestId('terms-remove-error')).textContent).toBe('boom')
  })
})
