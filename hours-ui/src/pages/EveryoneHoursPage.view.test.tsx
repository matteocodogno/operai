/**
 * @vitest-environment jsdom
 *
 * Everyone's hours, the view of a holder (specs/029-time-tracking T29; AC-4.3, AC-4.4, AC-4.5, AC-4.7, AC-4.8,
 * AC-4.10, AC-4.11, AC-1.6, D48; design F6, S4): the Person filter and its options, the Totals by person, the
 * read-only table, the banners about names and the deal filter's unavailable state. Who may ask, the denial
 * and the outage are in `EveryoneHoursPage.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () =>
  (await import('../test-support/fakeSession')).shellSessionMock(apiFetch, {
    permissions: (await import('../test-support/fakeSession')).READ_ALL_HOLDER,
  }),
)

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  dealItem,
  deferred,
  entriesPage,
  fakeApi,
  listsHandler,
  page,
  problem,
  requests,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import {
  ADA,
  ADA_PROJECT,
  CURSOR,
  GRACE,
  PAGE_ONE,
  PAGE_TWO,
  PERSON_TOTALS,
  entriesHandler,
  totalsWithPeople,
} from '../test-support/fixtures/everyone'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'
import type { Person, TotalsAnswer } from '../lib/hoursApi.types'
import { totalsAnswer } from '../test-support/fakeApi'

const t = strings.everyone
const e = strings.entries
const f = strings.filters
const tt = strings.totals

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithPeople,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours/all') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-everyone-page')
  await screen.findByTestId('hours-filters')
  return history
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )

const personSelect = () => screen.getByRole('combobox', { name: f.person.label }) as HTMLSelectElement
const groupSelect = () => screen.getByRole('combobox', { name: tt.groupBy.label }) as HTMLSelectElement
const dealInput = () => screen.getByRole('combobox', { name: f.deal.label })
const optionTexts = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

const refused = (): FakeAnswer => ({ status: 503, body: problem(503, 'host_unavailable') })
/** A handler that refuses (503 `host_unavailable`) any ask that carries a `dealId`, else answers with `otherwise`. */
const refusingUnderDeal =
  (otherwise: FakeHandler): FakeHandler =>
  (url, init, params) =>
    url.searchParams.has('dealId') ? refused() : otherwise(url, init, params)

/** `GET /time-entries/totals` answered per `groupBy`, the person grouping included (others as `totalsWithPeople`). */
const totalsBy =
  (byGroup: Record<string, FakeHandler>): FakeHandler =>
  (url, init, params) =>
    (byGroup[url.searchParams.get('groupBy') ?? ''] ?? totalsWithPeople)(url, init, params)

/** Picks the deal "Acme renewal" in the Deal filter, as a person would. */
const pickDeal = async () => {
  await userEvent.type(dealInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
}

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Totals by person, and the Person options (AC-4.4, AC-4.5, design gap 2)', () => {
  it('Totals default to Person: the grouping is chosen, the caption names it, the people are in the server’s order', async () => {
    useApi()
    await renderPage()
    const card = await screen.findByTestId('hours-totals-table')
    expect(groupSelect().value).toBe('person')
    expect(
      within(groupSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Person', 'Project', 'Deal', 'Category', 'Month'])
    expect(within(screen.getByTestId('hours-totals')).getByRole('table', { name: tt.caption.person })).toBe(card)
    const rows = within(card)
      .getAllByRole('row')
      .slice(1)
      .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['Ada Lovelace', '12 h'],
      ['Grace Hopper', '10 h 30'],
      ['Unknown user (deactivated)', '4 h'],
      ['Unknown user', '1 h'],
    ])
    expect(within(screen.getByTestId('hours-totals-total')).getByText('27 h 30')).not.toBeNull()
  })

  it('the Person options come from the person totals under the other filters: Everyone first, then everyone who has hours', async () => {
    useApi()
    await renderPage()
    await waitFor(() => expect(optionTexts(personSelect())).toHaveLength(5))
    expect(optionTexts(personSelect())).toEqual([
      'Everyone',
      'Ada Lovelace',
      'Grace Hopper',
      'Unknown user (deactivated)',
      'Unknown user',
    ])
    expect(personSelect().value).toBe('')
  })

  it('asks the people with whose=all and the other filters but never a userId, even once a person is chosen', async () => {
    useApi()
    await renderPage('/hours/all?person=u-grace&category=tc-formazione')
    await waitFor(() => expect(optionTexts(personSelect()).length).toBeGreaterThan(2))
    const people = totalsCalls('person').filter((request) => !('userId' in request.query))
    expect(people.length).toBeGreaterThan(0)
    expect(people[0]!.query).toEqual({
      groupBy: 'person',
      whose: 'all',
      from: '2026-11-01',
      to: '2026-11-30',
      categoryId: 'tc-formazione',
    })
    // The entries and the totals of the view DO carry the person.
    expect(entriesCalls()[0]!.query['userId']).toBe('u-grace')
    expect(totalsCalls('person').some((request) => request.query['userId'] === 'u-grace')).toBe(true)
  })

  it('the options follow the other filters: a category chosen asks the people again, narrowed by it', async () => {
    useApi()
    await renderPage()
    await waitFor(() => expect(optionTexts(personSelect()).length).toBeGreaterThan(2))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'Formazione')
    await waitFor(() =>
      expect(
        totalsCalls('person').filter((request) => request.query['categoryId'] === 'tc-formazione'),
      ).not.toHaveLength(0),
    )
    for (const request of totalsCalls('person').filter((r) => r.query['categoryId'] === 'tc-formazione')) {
      expect(request.query).not.toHaveProperty('userId')
    }
  })

  it('choosing a person narrows the entries and the totals to them, and does not ask for the people again', async () => {
    useApi()
    const history = await renderPage()
    await waitFor(() => expect(optionTexts(personSelect()).length).toBeGreaterThan(2))
    const peopleBefore = totalsCalls('person').filter((request) => !('userId' in request.query)).length

    await userEvent.selectOptions(personSelect(), 'Grace Hopper')

    await waitFor(() => expect(entriesCalls().at(-1)!.query['userId']).toBe('u-grace'))
    expect(totalsCalls('person').at(-1)!.query['userId']).toBe('u-grace')
    expect(totalsCalls('person').filter((request) => !('userId' in request.query))).toHaveLength(peopleBefore)
    expect(history.location.search).toContain('person=u-grace')
    expect(personSelect().value).toBe('u-grace')
    // The options did not shrink to the one chosen.
    expect(optionTexts(personSelect())).toHaveLength(5)
  })

  it('choosing Everyone again drops the person from the asks and from the address', async () => {
    useApi()
    const history = await renderPage('/hours/all?person=u-grace')
    await waitFor(() => expect(optionTexts(personSelect()).length).toBeGreaterThan(2))

    await userEvent.selectOptions(personSelect(), 'Everyone')

    await waitFor(() => expect(entriesCalls().at(-1)!.query).not.toHaveProperty('userId'))
    expect(history.location.search).not.toContain('person')
    expect(personSelect().value).toBe('')
  })

  it('a person who drops out of a narrowed list stays chosen, under the name the page had for them', async () => {
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: (url) =>
          url.searchParams.get('categoryId') === 'tc-formazione'
            ? { status: 200, body: totalsAnswer([PERSON_TOTALS.groups[1]!]) }
            : { status: 200, body: PERSON_TOTALS },
      }),
    })
    await renderPage()
    await waitFor(() => expect(optionTexts(personSelect()).length).toBe(5))
    await userEvent.selectOptions(personSelect(), 'Ada Lovelace')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'Formazione')

    await waitFor(() => expect(optionTexts(personSelect())).toEqual(['Everyone', 'Ada Lovelace', 'Grace Hopper']))
    expect(personSelect().value).toBe('u-ada')
  })

  it('a person in the address is applied from the first ask; one the people never name is "Unknown user"', async () => {
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: () => ({ status: 200, body: totalsAnswer([PERSON_TOTALS.groups[1]!]) }),
      }),
    })
    await renderPage('/hours/all?person=u-new')
    expect(entriesCalls()[0]!.query['userId']).toBe('u-new')
    await waitFor(() => expect(optionTexts(personSelect())).toContain('Grace Hopper'))
    expect(optionTexts(personSelect())).toEqual(['Everyone', 'Unknown user', 'Grace Hopper'])
    expect(personSelect().value).toBe('u-new')
  })

  it('a person that is not a user id (a comma, 65 characters) is nobody: it never reaches the API', async () => {
    useApi()
    await renderPage('/hours/all?person=a%2Cb')
    await screen.findByTestId('hours-entries-table')
    expect(entriesCalls()[0]!.query).not.toHaveProperty('userId')
    expect(personSelect().value).toBe('')
  })

  it('while the people are on their way the select says so and the rest does not wait for it', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: () => slow.promise,
        project: totalsWithPeople,
      }),
    })
    await renderPage('/hours/all?group=project')
    await screen.findByTestId('hours-entries-table')
    expect(screen.getByText(f.person.loading)).not.toBeNull()
    expect(personSelect().getAttribute('aria-disabled')).toBe('true')
    slow.resolve({ status: 200, body: PERSON_TOTALS })
    await waitFor(() => expect(screen.queryByText(f.person.loading)).toBeNull())
    expect(optionTexts(personSelect())).toHaveLength(5)
  })

  it('their failure leaves the rest of the view working: the select says so, the table and the totals are there', async () => {
    useApi({ 'GET /time-entries/totals': totalsBy({ person: () => ({ status: 500, body: problem(500) }) }) })
    await renderPage('/hours/all?group=project')
    await screen.findByTestId('hours-entries-table')
    await screen.findByTestId('hours-totals-table')
    expect(screen.getByText(f.person.error)).not.toBeNull()
    expect(personSelect().getAttribute('aria-disabled')).toBe('true')
    expect(optionTexts(personSelect())).toEqual(['Everyone'])
    expect(screen.queryByRole('alert')).toBeNull() // the select's hint is not an alert: the rest of the view works
  })

  it('Group by Person is the default; choosing another asks only for the totals, and Person again leaves the address', async () => {
    useApi()
    const history = await renderPage()
    await screen.findByTestId('hours-entries-table')
    const entriesBefore = entriesCalls().length
    const peopleBefore = totalsCalls('person').filter((request) => !('userId' in request.query)).length

    await userEvent.selectOptions(groupSelect(), 'project')

    await waitFor(() => expect(totalsCalls('project')).toHaveLength(1))
    expect(entriesCalls()).toHaveLength(entriesBefore)
    expect(totalsCalls('person').filter((request) => !('userId' in request.query))).toHaveLength(peopleBefore)
    expect(history.location.search).toContain('group=project')

    await userEvent.selectOptions(groupSelect(), 'person')
    await waitFor(() => expect(history.location.search).not.toContain('group'))
  })
})

describe('the entries: a flat, read-only table in the server’s order (AC-1.6, AC-4.3)', () => {
  it('is the Entries card with the table Day, Person, On, Details, Time, one row per entry, in the server’s order', async () => {
    useApi()
    await renderPage()
    const table = await screen.findByRole('table', { name: t.entries.caption })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'Person', 'On', 'Details', 'Time'])
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      f.title,
      tt.title,
      e.title,
    ])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'hours-entry-e-ada-alpha',
      'hours-entry-e-grace-hidden',
    ])
  })

  it('has nothing to write with: no Edit, no Delete, no Record hours, no button in the table', async () => {
    useApi()
    await renderPage()
    const table = await screen.findByRole('table', { name: t.entries.caption })
    expect(within(table).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /record hours/i })).toBeNull()
    expect(screen.queryByText(e.edit)).toBeNull()
    expect(entriesCalls().every((request) => request.method === 'GET')).toBe(true)
  })

  it('has no day headings or day totals (those are My hours’): no groupBy=day is asked', async () => {
    useApi()
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    expect(totalsCalls('day')).toHaveLength(0)
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
  })

  it('Load more adds the next page after the first, announced politely, and the order stays the server’s', async () => {
    useApi()
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    await waitFor(() => expect(screen.getByTestId('hours-entry-e-ada-deal')).not.toBeNull())
    const rows = within(screen.getByRole('table', { name: t.entries.caption }))
      .getAllByRole('row')
      .slice(1)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'hours-entry-e-ada-alpha',
      'hours-entry-e-grace-hidden',
      'hours-entry-e-gone-kickoff',
      'hours-entry-e-who-training',
      'hours-entry-e-ada-deal',
    ])
    expect(entriesCalls().at(-1)!.query['cursor']).toBe(CURSOR)
    expect(screen.getByText(e.loadedMore(3, 5))).not.toBeNull()
    expect(screen.queryByRole('button', { name: e.loadMore })).toBeNull()
  })

  it('a failed Load more keeps the pages already shown, with the error and Retry below them (D48)', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('cursor') ? { status: 500, body: problem(500) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    expect(await screen.findByText(e.loadMoreError)).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-ada-alpha')).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-grace-hidden')).not.toBeNull()
  })

  it('hours of no one: "No hours have been recorded in this period", not "no entries match", and no Clear filters', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([]) }) })
    await renderPage()
    const empty = await screen.findByTestId('hours-entries-empty')
    expect(within(empty).getByText(t.entries.empty.title)).not.toBeNull()
    expect(t.entries.empty.title).toBe('No hours have been recorded in this period')
    expect(screen.queryByTestId('hours-entries-clear')).toBeNull()
  })

  it('with a filter on and nothing matching: "No entries match these filters" with Clear filters, which clears the person too', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('userId') ? { status: 200, body: entriesPage([]) } : entriesHandler(url, init, params),
    })
    const history = await renderPage('/hours/all?person=u-ada')
    const empty = await screen.findByTestId('hours-entries-empty')
    expect(within(empty).getByText(e.emptyFiltered.title)).not.toBeNull()

    await userEvent.click(screen.getByTestId('hours-entries-clear'))

    await screen.findByRole('table', { name: t.entries.caption })
    expect(history.location.search).not.toContain('person')
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('userId')
  })

  it('a failed read of the entries is the region’s own warning with Retry, in the page’s words', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 500, body: problem(500) }) })
    await renderPage()
    const card = await screen.findByTestId('hours-entries')
    expect(await within(card).findByText(t.entries.error.title)).not.toBeNull()
    expect(screen.getByTestId('hours-totals')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })

  it('a Custom range that cannot be sent asks nothing, and the card says so; the people are not left "loading"', async () => {
    useApi()
    await renderPage('/hours/all?period=custom&from=2026-11-10&to=2026-11-01')
    expect(screen.getByTestId('hours-entries-invalid').textContent).toBe(t.entries.invalidPeriod)
    expect(screen.getByTestId('hours-totals-invalid')).not.toBeNull()
    expect(entriesCalls()).toHaveLength(0)
    expect(totalsCalls()).toHaveLength(0)
    expect(screen.queryByText(f.person.loading)).toBeNull()
  })

  it('a Custom From before 01.01.2000 is a field error on From, and nothing is asked (plan "A day")', async () => {
    useApi()
    await renderPage('/hours/all?period=custom&from=1999-12-31&to=2026-11-13')
    expect(entriesCalls()).toHaveLength(0)
    expect(totalsCalls()).toHaveLength(0)
    const from = screen.getByLabelText(f.from)
    expect(from.getAttribute('aria-invalid')).toBeNull()
    from.focus()
    await userEvent.tab()
    expect(await screen.findByText(f.rangeErrors.tooEarly('01.01.2000'))).not.toBeNull()
    expect(screen.getByLabelText(f.from).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText(f.to).getAttribute('aria-invalid')).toBeNull()
    expect(entriesCalls()).toHaveLength(0)
  })

  it('a Custom To before 01.01.2000 is a field error on To, never "end before start"', async () => {
    useApi()
    await renderPage('/hours/all?period=custom&from=2026-11-01&to=1999-12-31')
    const to = screen.getByLabelText(f.to)
    to.focus()
    await userEvent.tab()
    expect(await screen.findByText(f.rangeErrors.tooEarly('01.01.2000'))).not.toBeNull()
    expect(screen.queryByText(f.rangeErrors.toBeforeFrom)).toBeNull()
    expect(screen.getByLabelText(f.to).getAttribute('aria-invalid')).toBe('true')
    expect(entriesCalls()).toHaveLength(0)
  })
})

describe('a person renamed between two loads shows under the new name everywhere (AC-4.8)', () => {
  let adaName = 'Ada Lovelace'
  const named = (person: Person): Person => (person.id === ADA.id ? { ...person, name: adaName } : person)
  const entriesNamed: FakeHandler = (url, init, params) => {
    const answer = entriesHandler(url, init, params) as FakeAnswer & { body: typeof PAGE_ONE }
    return {
      ...answer,
      body: { ...answer.body, items: answer.body.items.map((entry) => ({ ...entry, person: named(entry.person) })) },
    }
  }
  const totalsNamed: FakeHandler = (url, init, params) => {
    if (url.searchParams.get('groupBy') !== 'person') return totalsWithPeople(url, init, params)
    const body: TotalsAnswer = {
      ...PERSON_TOTALS,
      groups: PERSON_TOTALS.groups.map((group) =>
        group.kind === 'keyed' && group.key === ADA.id ? { ...group, label: adaName } : group,
      ),
    }
    return { status: 200, body }
  }

  beforeEach(() => {
    adaName = 'Ada Lovelace'
  })

  it('the Person column, the Person filter options and the person totals all take the new name on the next load', async () => {
    useApi({ 'GET /time-entries': entriesNamed, 'GET /time-entries/totals': totalsNamed })
    await renderPage()
    const table = await screen.findByRole('table', { name: t.entries.caption })
    await screen.findByTestId('hours-totals-table')
    await waitFor(() => expect(optionTexts(personSelect())).toContain('Ada Lovelace'))
    expect(within(table).getByText('Ada Lovelace')).not.toBeNull()
    expect(within(screen.getByTestId('hours-totals-table')).getByText('Ada Lovelace')).not.toBeNull()

    adaName = 'Ada King'
    // A change of filter is the next load of all three reads.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'Formazione')

    await waitFor(() => expect(optionTexts(personSelect())).toContain('Ada King'))
    expect(optionTexts(personSelect())).not.toContain('Ada Lovelace')
    expect(within(screen.getByRole('table', { name: t.entries.caption })).getByText('Ada King')).not.toBeNull()
    expect(within(screen.getByTestId('hours-totals-table')).getByText('Ada King')).not.toBeNull()
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })

  it('a person chosen keeps being chosen under their new name', async () => {
    useApi({ 'GET /time-entries': entriesNamed, 'GET /time-entries/totals': totalsNamed })
    await renderPage('/hours/all?person=u-ada')
    await waitFor(() => expect(optionTexts(personSelect())).toContain('Ada Lovelace'))
    adaName = 'Ada King'

    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'Formazione')

    await waitFor(() => expect(optionTexts(personSelect())).toContain('Ada King'))
    expect(personSelect().value).toBe('u-ada')
    expect(optionTexts(personSelect()).filter((text) => text === 'Ada King')).toHaveLength(1)
  })
})

describe('what could not be named and what may not be read (AC-4.7, AC-4.10)', () => {
  it('a name the holder may not read is a standing note in the page’s own words, never announced', async () => {
    useApi()
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    const note = screen.getByRole('note', { name: t.entries.hidden.label })
    expect(note.textContent).toContain(t.entries.hidden.body)
    expect(note.getAttribute('aria-live')).toBeNull()
    expect(screen.getByTestId('hours-banner-hidden')).toBe(note)
    // The row says it too: type and words, no name, no link.
    const row = screen.getByTestId('hours-entry-e-grace-hidden')
    expect(within(row).getByText(strings.names.hidden)).not.toBeNull()
    expect(within(row).queryByRole('link')).toBeNull()
  })

  it('without anything hidden there is no note', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([ADA_PROJECT]) }) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    expect(screen.queryByTestId('hours-banner-hidden')).toBeNull()
  })

  it('a hidden group of the totals counts too', async () => {
    useApi({
      'GET /time-entries': () => ({ status: 200, body: entriesPage([ADA_PROJECT]) }),
      'GET /time-entries/totals': totalsBy({
        project: () => ({ status: 200, body: totalsAnswer([{ kind: 'hidden', minutes: 60 }]) }),
      }),
    })
    await renderPage('/hours/all?group=project')
    await screen.findByTestId('hours-totals-table')
    expect(screen.getByTestId('hours-banner-hidden')).not.toBeNull()
  })

  it('a source that did not answer is ONE polite banner naming it: the people’s read counts, and the hours are complete', async () => {
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: () => ({
          status: 200,
          body: totalsAnswer(
            [{ kind: 'keyed', key: GRACE.id, label: null, minutes: 60, status: 'unknown' }],
            ['identities'],
          ),
        }),
      }),
    })
    await renderPage('/hours/all?group=project')
    const banner = await screen.findByTestId('hours-banner-unavailable')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain(strings.names.sources.identities)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names unavailable on the entries: a name that did not come is "Name unavailable" in the row, with the source named', async () => {
    useApi({
      'GET /time-entries': () => ({ status: 200, body: { ...PAGE_TWO, unavailable: ['crm', 'activities'] } }),
    })
    await renderPage()
    const banner = await screen.findByTestId('hours-banner-unavailable')
    expect(banner.textContent).toContain(strings.names.sources.crm)
    expect(banner.textContent).toContain(strings.names.sources.activities)
    expect(within(screen.getByTestId('hours-entry-e-ada-deal')).getByText(strings.names.unavailable)).not.toBeNull()
  })

  it('grouping by deal with meeting-deals unavailable adds the polite warning about the separate row', async () => {
    useApi({
      'GET /time-entries/totals': totalsBy({
        deal: () => ({
          status: 200,
          body: totalsAnswer([{ kind: 'deal-unknown', minutes: 150 }], ['meeting-deals']),
        }),
      }),
    })
    await renderPage('/hours/all?group=deal')
    const warning = await screen.findByTestId('hours-banner-deal-grouping')
    expect(warning.textContent).toContain(e.banners.dealGrouping)
    expect(warning.getAttribute('role')).toBe('status')
  })
})

describe('the deal filter while Meetings cannot say which meetings belong to the deal (AC-4.11, D45)', () => {
  const blocker = () => screen.getByTestId('hours-deal-filter-unavailable')

  /** What must be gone while the banner is up: Totals, Entries, every figure and every row. */
  const expectNothingElseShown = () => {
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
    expect(screen.queryByTestId('hours-entries-table')).toBeNull()
    expect(screen.queryByTestId('hours-totals-table')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByText(t.entries.empty.title)).toBeNull()
    expect(screen.queryByText(e.emptyFiltered.title)).toBeNull()
    expect(screen.queryByTestId('hours-banners')).toBeNull()
  }

  it.each<[string, Parameters<typeof fakeApi>[0]]>([
    ['the first page of entries', { 'GET /time-entries': refusingUnderDeal(entriesHandler) }],
    ['the totals', { 'GET /time-entries/totals': totalsBy({ person: refusingUnderDeal(totalsWithPeople) }) }],
  ])(
    'a 503 host_unavailable on %s replaces Totals and Entries with ONE alert, never the empty state or "0 min"',
    async (_name, overrides) => {
      useApi(overrides)
      await renderPage()
      await screen.findByRole('table', { name: t.entries.caption })

      await pickDeal()

      await waitFor(() => expect(screen.queryByTestId('hours-deal-filter-unavailable')).not.toBeNull())
      expect(blocker().getAttribute('role')).toBe('alert')
      expect(within(blocker()).getByText(e.dealFilterUnavailable.title)).not.toBeNull()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expectNothingElseShown()
      expect(screen.getByTestId('hours-filters')).not.toBeNull()
      expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.heading)
    },
  )

  it('the Person call carries the deal filter too, so it fails with the rest: it alone refusing is the same state', async () => {
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: (url) => (url.searchParams.has('dealId') ? refused() : { status: 200, body: PERSON_TOTALS }),
        project: totalsWithPeople,
      }),
    })
    await renderPage('/hours/all?group=project')
    await screen.findByRole('table', { name: t.entries.caption })

    await pickDeal()

    await screen.findByTestId('hours-deal-filter-unavailable')
    expectNothingElseShown()
    const people = totalsCalls('person').filter((request) => request.query['dealId'] === 'd1')
    expect(people.length).toBeGreaterThan(0)
    expect(people[0]!.query).not.toHaveProperty('userId')
  })

  it('does not move focus when it appears: the person is in the Filters card', async () => {
    useApi({ 'GET /time-entries': refusingUnderDeal(entriesHandler) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    expect(blocker().contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(blocker())
  })

  it('leaves nothing from before the filter was set: no rows, no totals, even while the new answers are on their way', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })

    await pickDeal()

    await waitFor(() => expect(entriesCalls()).toHaveLength(2))
    expect(screen.queryByTestId('hours-entries-table')).toBeNull()
    expect(screen.queryByTestId('hours-entry-e-ada-alpha')).toBeNull()
    slow.resolve(refused())
    await screen.findByTestId('hours-deal-filter-unavailable')
    expectNothingElseShown()
  })

  it('Retry asks all three reads again; once they work focus goes to the Totals heading and the total is read politely', async () => {
    let healthy = false
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('dealId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({ 'GET /time-entries': gate(entriesHandler), 'GET /time-entries/totals': gate(totalsWithPeople) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')
    const entriesBefore = entriesCalls().length
    const totalsBefore = totalsCalls().length
    healthy = true

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: tt.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(entriesCalls().length).toBe(entriesBefore + 1)
    // The chosen totals AND the people, each once.
    expect(totalsCalls().length).toBe(totalsBefore + 2)
    expect(screen.getByTestId('hours-totals-live').textContent).toBe(tt.announce('27 hours, 30 minutes'))
    expect(await screen.findByRole('table', { name: t.entries.caption })).not.toBeNull()
  })

  it('a Retry that fails again brings the banner back and puts focus on it, since the Retry button that had it is gone', async () => {
    useApi({ 'GET /time-entries': refusingUnderDeal(entriesHandler) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(document.activeElement).toBe(blocker()))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expectNothingElseShown()
  })

  it('"Clear the deal filter" drops the filter, reloads normally and puts focus in the Deal field', async () => {
    useApi({
      'GET /time-entries': refusingUnderDeal(entriesHandler),
      'GET /time-entries/totals': refusingUnderDeal(totalsWithPeople),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    // By keyboard: a mouse press on a library button leaves focus in the text field the person was in.
    within(blocker()).getByRole('button', { name: e.dealFilterUnavailable.clear }).focus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByRole('table', { name: t.entries.caption })).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('dealId')
    expect(totalsCalls('person').at(-1)!.query).not.toHaveProperty('dealId')
    expect((dealInput() as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(dealInput())
  })

  it('without a deal filter the same refusal is an ordinary failure of the region, not this state', async () => {
    useApi({ 'GET /time-entries': () => refused() })
    await renderPage()

    const card = await screen.findByTestId('hours-entries')
    expect(await within(card).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-totals')).not.toBeNull()
  })

  it('a failed Load more after a first page that DID arrive keeps those pages, with the error and Retry below them (D48)', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') && url.searchParams.has('cursor')
          ? refused()
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickDeal()
    await screen.findByRole('table', { name: t.entries.caption })
    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    expect(await screen.findByText(e.loadMoreError)).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-entry-e-ada-alpha')).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-grace-hidden')).not.toBeNull()
  })
})

describe('the people are read once for the filters, and a stale answer never shows under new ones', () => {
  it('an answer to filters that are no longer the page’s is discarded however late it comes', async () => {
    const first = deferred<FakeAnswer>()
    let calls = 0
    useApi({
      'GET /time-entries/totals': totalsBy({
        person: (url) => {
          calls += 1
          return url.searchParams.has('categoryId')
            ? { status: 200, body: totalsAnswer([PERSON_TOTALS.groups[1]!]) }
            : first.promise
        },
        project: totalsWithPeople,
      }),
    })
    await renderPage('/hours/all?group=project')
    await screen.findByTestId('hours-entries-table')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: f.category.label }), 'Formazione')
    await waitFor(() => expect(optionTexts(personSelect())).toEqual(['Everyone', 'Grace Hopper']))

    first.resolve({ status: 200, body: PERSON_TOTALS })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(optionTexts(personSelect())).toEqual(['Everyone', 'Grace Hopper'])
    expect(calls).toBe(2)
  })
})
