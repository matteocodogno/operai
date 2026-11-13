/**
 * @vitest-environment jsdom
 *
 * HoursFilters — the Filters card of My hours (specs/029-time-tracking T24; AC-4.4, AC-3.4, AC-3.8; design S1
 * "Filters"). Controlled and presentational: it renders the state it is given and reports each change as a
 * patch; the page owns the URL, the lists and the requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { strings } from '../strings'
import { dealItem, fakeApi, page, problem, projectItem } from '../test-support/fakeApi'
import { LISTS } from '../test-support/fixtures/myHours'
import HoursFilters from './HoursFilters'
import type { HoursFiltersProps } from './HoursFilters'
import { DEFAULT_FILTERS } from './HoursFiltersState'

const t = strings.filters

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi())
})
afterEach(() => cleanup())

const renderFilters = (overrides: Partial<HoursFiltersProps> = {}) => {
  const handlers = {
    onChange: vi.fn(),
    onProjectChange: vi.fn(),
    onDealChange: vi.fn(),
    onClear: vi.fn(),
    onRetryLists: vi.fn(),
  }
  const props: HoursFiltersProps = {
    state: DEFAULT_FILTERS,
    rangeErrors: {},
    project: null,
    deal: null,
    lists: { status: 'loaded', lists: LISTS },
    filtered: false,
    pickerKey: 0,
    ...handlers,
    ...overrides,
  }
  const view = render(<HoursFilters {...props} />)
  return {
    ...handlers,
    rerender: (next: Partial<HoursFiltersProps>) => view.rerender(<HoursFilters {...props} {...next} />),
  }
}

/** What the picker's list says once its search has answered, and what it announces politely at the same time. */
const pickerSays = async (picker: 'project' | 'deal', text: string) => {
  const listbox = () => screen.getByTestId(`hours-filter-${picker}-input-listbox`)
  await waitFor(() => expect(within(listbox()).queryByText(text)).not.toBeNull())
  expect(screen.getByTestId(`hours-filter-${picker}-input-live`).textContent).toBe(text)
  return listbox()
}

const optionTexts = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('the card', () => {
  it('is a labelled search form in a card titled Filters (h3)', () => {
    renderFilters()
    expect(screen.getByRole('search', { name: t.landmarkLabel })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(t.title)
  })
})

describe('Period (AC-4.4)', () => {
  it('offers the six periods in the design’s order, This month first chosen by default', () => {
    renderFilters()
    const select = screen.getByRole('combobox', { name: t.period.label })
    expect(optionTexts(select)).toEqual([
      'This week',
      'Last week',
      'This month',
      'Last month',
      'This year',
      'Custom range',
    ])
    expect((select as HTMLSelectElement).value).toBe('thisMonth')
  })

  it('reports the period chosen', async () => {
    const { onChange } = renderFilters()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: t.period.label }), 'lastWeek')
    expect(onChange).toHaveBeenCalledWith({ period: 'lastWeek' })
  })

  it('has no From and To until the period is Custom', () => {
    renderFilters()
    expect(screen.queryByLabelText(t.from)).toBeNull()
    expect(screen.queryByLabelText(t.to)).toBeNull()
  })

  it('Custom shows From and To as date fields holding the range, and reports each change', () => {
    const { onChange } = renderFilters({
      state: { ...DEFAULT_FILTERS, period: 'custom', from: '2026-10-05', to: '2026-10-09' },
    })
    const from = screen.getByLabelText(t.from) as HTMLInputElement
    const to = screen.getByLabelText(t.to) as HTMLInputElement
    expect([from.type, from.value, to.type, to.value]).toEqual(['date', '2026-10-05', 'date', '2026-10-09'])

    fireEvent.change(from, { target: { value: '2026-10-01' } })
    fireEvent.change(to, { target: { value: '2026-10-31' } })
    expect(onChange).toHaveBeenNthCalledWith(1, { from: '2026-10-01' })
    expect(onChange).toHaveBeenNthCalledWith(2, { to: '2026-10-31' })
  })
})

describe('the Custom range’s field errors (nothing is sent while one shows)', () => {
  const custom = { ...DEFAULT_FILTERS, period: 'custom' as const, from: '2026-10-09', to: '2026-10-05' }

  it('To before From is an error on To, at once, marked invalid and announced', () => {
    renderFilters({ state: custom, rangeErrors: { to: 'before-from' } })
    const to = screen.getByLabelText(t.to)
    expect(screen.getByText(t.rangeErrors.toBeforeFrom).getAttribute('role')).toBe('alert')
    expect(to.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText(t.from).getAttribute('aria-invalid')).toBeNull()
    expect(to.getAttribute('aria-describedby')).toBe(screen.getByText(t.rangeErrors.toBeforeFrom).id)
  })

  it('over 366 days is an error on To', () => {
    renderFilters({ state: custom, rangeErrors: { to: 'too-long' } })
    expect(screen.getByText(t.rangeErrors.tooLong)).not.toBeNull()
  })

  it('an empty date is "required" only once the person has left the field (no error while typing a date)', () => {
    renderFilters({ state: { ...custom, from: '' }, rangeErrors: { from: 'required' } })
    expect(screen.queryByText(t.rangeErrors.fromRequired)).toBeNull()

    fireEvent.blur(screen.getByLabelText(t.from))

    expect(screen.getByText(t.rangeErrors.fromRequired)).not.toBeNull()
    expect(screen.queryByText(t.rangeErrors.toRequired)).toBeNull()
  })
})

describe('Category and Work type: one read, retired ones marked, names as typed (AC-3.4, AC-3.8)', () => {
  it('Category lists All categories, then every category in the server’s order, a retired one suffixed', () => {
    renderFilters()
    expect(optionTexts(screen.getByRole('combobox', { name: t.category.label }))).toEqual([
      'All categories',
      'Formazione',
      'Administration',
      'Seminars (retired)',
    ])
  })

  it('shows a name exactly as the administrator typed it ("Formazione" is not translated)', () => {
    renderFilters()
    expect(screen.getByRole('option', { name: 'Formazione' })).not.toBeNull()
  })

  it('Work type is ONE select with two groups, the projects list and the deals list, both with an "Analysis"', () => {
    renderFilters()
    const select = screen.getByRole('combobox', { name: t.workType.label })
    const groups = within(select).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('label'))).toEqual([t.workType.projectGroup, t.workType.dealGroup])
    expect(groups.map((group) => optionTexts(group))).toEqual([
      ['Development', 'Analysis', 'Legacy support (retired)'],
      ['Analysis', 'Demo'],
    ])
    const analysis = within(select).getAllByRole('option', { name: 'Analysis' }) as HTMLOptionElement[]
    expect(analysis.map((option) => option.value)).toEqual(['wt-p-analysis', 'wt-d-analysis'])
    expect(optionTexts(select)[0]).toBe('All work types')
  })

  it('a list with nothing in it has no group', () => {
    renderFilters({
      lists: { status: 'loaded', lists: { ...LISTS, workTypes: { project: LISTS.workTypes.project, deal: [] } } },
    })
    const groups = within(screen.getByRole('combobox', { name: t.workType.label })).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('label'))).toEqual([t.workType.projectGroup])
  })

  it('reports the choice by id, and "all" as an empty id', async () => {
    const { onChange } = renderFilters({ state: { ...DEFAULT_FILTERS, categoryId: 'tc-admin' } })
    const category = screen.getByRole('combobox', { name: t.category.label }) as HTMLSelectElement
    expect(category.value).toBe('tc-admin')

    await userEvent.selectOptions(category, 'tc-formazione')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: t.workType.label }), 'wt-d-demo')
    await userEvent.selectOptions(category, '')

    expect(onChange.mock.calls).toEqual([
      [{ categoryId: 'tc-formazione' }],
      [{ workTypeId: 'wt-d-demo' }],
      [{ categoryId: '' }],
    ])
  })

  it('while the lists load, both selects say so and cannot be used (aria-disabled, reachable)', async () => {
    const { onChange } = renderFilters({ lists: { status: 'loading' } })
    for (const label of [t.category.label, t.workType.label]) {
      const select = screen.getByRole('combobox', { name: label })
      expect(select.getAttribute('aria-disabled')).toBe('true')
      expect(optionTexts(select)).toEqual([t.listsLoading])
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('when the lists fail, a warning with Retry says so inside the card, the selects stay disabled and the rest works', async () => {
    const { onRetryLists } = renderFilters({ lists: { status: 'error' } })
    const alert = screen.getByTestId('hours-filters-lists-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain(t.listsError.title)
    expect(screen.getByRole('combobox', { name: t.category.label }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('combobox', { name: t.workType.label }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('combobox', { name: t.period.label }).getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByRole('combobox', { name: t.project.label }).getAttribute('aria-disabled')).toBeNull()

    await userEvent.click(within(alert).getByRole('button', { name: strings.common.retry }))
    expect(onRetryLists).toHaveBeenCalledTimes(1)
  })
})

describe('Clear filters', () => {
  it('is absent while nothing differs from the defaults', () => {
    renderFilters({ filtered: false })
    expect(screen.queryByRole('button', { name: t.clear })).toBeNull()
  })

  it('is offered, in the card’s header, once something differs, and reports the click', async () => {
    const { onClear } = renderFilters({ filtered: true })
    await userEvent.click(screen.getByRole('button', { name: t.clear }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('Project and Deal: searched on the server, as the person (AC-4.4)', () => {
  it('Project searches projects-api for what is typed, and picking reports the project', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /projects': () => ({
          status: 200,
          body: page([
            projectItem({ id: 'p1', name: 'Project Alpha', company: { id: 'c1', name: 'Acme' } }),
            projectItem({ id: 'p2', name: 'Project Beta' }),
          ]),
        }),
      }),
    )
    const { onProjectChange } = renderFilters()

    await userEvent.type(screen.getByRole('combobox', { name: t.project.label }), 'proj')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))

    expect(onProjectChange).toHaveBeenCalledWith({ id: 'p1', name: 'Project Alpha', companyName: 'Acme' })
  })

  it('shows the project that is picked (held in memory by the page) in the field', () => {
    renderFilters({ project: { id: 'p1', name: 'Project Alpha', companyName: null } })
    expect((screen.getByRole('combobox', { name: t.project.label }) as HTMLInputElement).value).toBe('Project Alpha')
  })

  it('Deal searches crm-api and picking reports the deal', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /deals': () => ({
          status: 200,
          body: page([dealItem({ id: 'd1', title: 'Acme renewal', company: { id: 'c1', name: 'Acme' } })]),
        }),
      }),
    )
    const { onDealChange } = renderFilters()

    await userEvent.type(screen.getByRole('combobox', { name: t.deal.label }), 'acme')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))

    expect(onDealChange).toHaveBeenCalledWith({ id: 'd1', title: 'Acme renewal', companyName: 'Acme' })
  })

  it('a 403 says the person cannot search projects (and the other filters still work)', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /projects': () => ({ status: 403, body: problem(403) }) }))
    renderFilters()
    await userEvent.type(screen.getByRole('combobox', { name: t.project.label }), 'a')
    await pickerSays('project', t.project.messages.forbidden)
    expect(screen.getByRole('combobox', { name: t.period.label }).getAttribute('aria-disabled')).toBeNull()
  })

  it.each([503, 500])('a %i is "unavailable", never "no match"', async (status) => {
    apiFetch.mockImplementation(fakeApi({ 'GET /deals': () => ({ status, body: problem(status) }) }))
    renderFilters()
    await userEvent.type(screen.getByRole('combobox', { name: t.deal.label }), 'a')
    const listbox = await pickerSays('deal', t.deal.messages.unavailable)
    expect(within(listbox).queryByText(t.deal.messages.noMatch)).toBeNull()
  })

  it('a network failure is "unavailable" too', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    renderFilters()
    await userEvent.type(screen.getByRole('combobox', { name: t.project.label }), 'a')
    await pickerSays('project', t.project.messages.unavailable)
  })

  it('no match says so', async () => {
    renderFilters()
    await userEvent.type(screen.getByRole('combobox', { name: t.project.label }), 'zzz')
    await pickerSays('project', t.project.messages.noMatch)
  })

  it('a new pickerKey (Clear filters) empties half-typed text that was never picked', async () => {
    const { rerender } = renderFilters()
    const input = screen.getByRole('combobox', { name: t.project.label }) as HTMLInputElement
    await userEvent.type(input, 'half')
    expect(input.value).toBe('half')

    rerender({ pickerKey: 1 })

    expect((screen.getByRole('combobox', { name: t.project.label }) as HTMLInputElement).value).toBe('')
  })
})
