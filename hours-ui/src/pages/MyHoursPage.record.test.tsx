/**
 * @vitest-environment jsdom
 *
 * My hours, T27's part: "Record hours" opens the entry dialog, a save closes it, gives focus back, reloads the
 * entries and the totals and says so (specs/029-time-tracking; AC-1.1, AC-1.4, AC-2.2, AC-2.11; design F1, S1,
 * S2). Rendered through the inner router with `fakeApi` behind `apiFetch`, so the request is the one the real
 * `hoursApi` builds. The dialog's own rules, fields and refusals are `EntryDialog.test.tsx`; this is the page
 * around it: what it asks of the lists, what it does after a save and what it leaves alone after a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import { deferred, fakeApi, listsHandler, problem, requests, sequence } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { entriesHandler, totalsWithDays } from '../test-support/fixtures/entries'
import { DEAL_ROWS, ENTRY_LISTS, PROJECT_ROWS, SAVED, refusal } from '../test-support/fixtures/entry'
import { TODAY_INSTANT } from '../test-support/fixtures/myHours'

const e = strings.entry
const f = e.fields

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(ENTRY_LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithDays,
    'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
    'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
    'POST /time-entries': () => ({ status: 201, body: SAVED }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
  await screen.findByTestId('hours-day-list')
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

const recordButton = () => screen.getByRole('button', { name: e.record })
const dialog = () => screen.getByRole('dialog', { name: e.dialog.recordTitle })
const inDialog = () => within(dialog())
const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )
const postCalls = () => requests(api, 'POST /time-entries')

/** Opens the dialog, sets the day when one is named, and chooses 1 h 30. */
const openAndFill = async (day?: string) => {
  await userEvent.click(recordButton())
  if (day !== undefined) {
    fireEvent.change(inDialog().getByLabelText(new RegExp(`^${f.day}`)), { target: { value: day } })
  }
  await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.duration.label }), '90')
}
const pressSave = () => userEvent.click(inDialog().getByRole('button', { name: e.dialog.save }))

/** Fills the dialog for 1 h 30 of other work in "Formazione" and presses Save. */
const recordOtherWork = async (day?: string) => {
  await openAndFill(day)
  await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
  await userEvent.selectOptions(inDialog().getByRole('combobox', { name: f.category.label }), 'Formazione')
  await pressSave()
}

/** The same on "Project Alpha", picked from the search. */
const recordOnProject = async () => {
  await openAndFill()
  await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.project }))
  await userEvent.type(inDialog().getByRole('combobox', { name: f.project.label }), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
  await pressSave()
}

describe('Record hours (F1; AC-1.1)', () => {
  it('is the page’s one primary action, in the header, and opens the dialog on the Day field', async () => {
    useApi()
    await renderPage()

    const button = recordButton()
    expect(button.className).toContain('btn-primary')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.closest('.page-header')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(button)
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(inDialog().getByLabelText(new RegExp(`^${f.day}`)))
    expect((document.activeElement as HTMLInputElement).value).toBe('2026-11-13')
  })

  it('offers the lists the page already read, with the retired ones left out, and reads nothing more', async () => {
    useApi()
    await renderPage()
    await userEvent.click(recordButton())
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))

    const category = inDialog().getByRole('combobox', { name: f.category.label })
    expect(
      within(category)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Formazione', 'Administration', 'Other'])
    expect(requests(api, 'GET /time-lists')).toHaveLength(1)
    expect(requests(api, 'GET /time-lists')[0]!.query).toEqual({ includeRetired: 'true' })
  })

  it('Cancel closes it with no request, and gives focus back to Record hours', async () => {
    useApi()
    await renderPage()
    const before = apiFetch.mock.calls.length
    await userEvent.click(recordButton())
    await userEvent.click(inDialog().getByRole('button', { name: strings.common.cancel }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(recordButton())
    expect(postCalls()).toHaveLength(0)
    expect(apiFetch.mock.calls.length).toBe(before)
  })

  it('stays available when the deal filter cannot be answered (AC-4.11): the view is one error, recording is not', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') ? refusal(503, 'host_unavailable') : entriesHandler(url, init, params),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.has('dealId') ? refusal(503, 'host_unavailable') : totalsWithDays(url, init, params),
    })
    await renderPage()
    await userEvent.type(screen.getByRole('combobox', { name: strings.filters.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
    await screen.findByTestId('hours-deal-filter-unavailable')

    await userEvent.click(recordButton())
    expect(dialog()).not.toBeNull()
  })
})

describe('saving (F1 step 5)', () => {
  it('posts the entry to hours-api, then closes, returns focus to Record hours and says it was saved', async () => {
    useApi()
    await renderPage()
    await recordOtherWork()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0]).toMatchObject({
      method: 'POST',
      path: '/time-entries',
      body: { day: '2026-11-13', minutes: 90, on: { type: 'none', categoryId: 'tc-formazione' } },
    })
    expect(document.activeElement).toBe(recordButton())
    const banner = await screen.findByTestId('hours-entry-saved')
    expect(banner.textContent).toBe(e.saved)
    expect(banner.closest('[role="status"]')).not.toBeNull()
  })

  it('reloads the entries, the day totals and the totals, with the same filters', async () => {
    useApi()
    await renderPage()
    const entriesBefore = entriesCalls().length
    const daysBefore = totalsCalls('day').length
    const groupedBefore = totalsCalls('project').length

    await recordOtherWork()
    await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
    await waitFor(() => expect(totalsCalls('day')).toHaveLength(daysBefore + 1))
    await waitFor(() => expect(totalsCalls('project')).toHaveLength(groupedBefore + 1))

    expect(entriesCalls().at(-1)!.query).toEqual(entriesCalls()[0]!.query)
    expect(totalsCalls('day').at(-1)!.query).toEqual(totalsCalls('day')[0]!.query)
    // The list shows again, with what the server now says.
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
  })

  it('shows the saved entry that the reloaded list holds', async () => {
    let saved = false
    useApi({
      'POST /time-entries': () => {
        saved = true
        return { status: 201, body: SAVED }
      },
      'GET /time-entries': (url, init, params) =>
        saved
          ? {
              status: 200,
              body: {
                items: [
                  {
                    ...SAVED,
                    id: 'e-saved',
                    on: { type: 'none', category: { id: 'tc-formazione', name: 'Formazione', retired: false } },
                  },
                ],
                nextCursor: null,
                unavailable: [],
              },
            }
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await recordOtherWork()
    expect(await screen.findByTestId('hours-entry-e-saved')).not.toBeNull()
  })

  it('says so when the day saved is outside the period shown, so the entry does not look lost', async () => {
    useApi()
    await renderPage()
    await recordOtherWork('2026-10-20')

    const banner = await screen.findByTestId('hours-entry-saved')
    expect(banner.textContent).toBe(e.savedOutsidePeriod('20.10.2026'))
    expect(banner.textContent).not.toBe(e.saved)
  })

  it('a second save replaces the banner with its own', async () => {
    useApi()
    await renderPage()
    await recordOtherWork('2026-10-20')
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.savedOutsidePeriod('20.10.2026'))
    await recordOtherWork()
    await waitFor(() => expect(screen.getByTestId('hours-entry-saved').textContent).toBe(e.saved))
  })

  it('the banner can be dismissed', async () => {
    useApi()
    await renderPage()
    await recordOtherWork()
    await screen.findByTestId('hours-entry-saved')
    await userEvent.click(screen.getByTestId('hours-entry-saved-dismiss'))
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
  })

  it('keeps the dialog open while the request runs, and closes it only when it answered', async () => {
    const answer = deferred<{ status: number; body: unknown }>()
    useApi({ 'POST /time-entries': () => answer.promise })
    await renderPage()
    await recordOtherWork()

    expect(dialog()).not.toBeNull()
    expect(inDialog().getByRole('button', { name: e.dialog.saving })).not.toBeNull()
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
    answer.resolve({ status: 201, body: SAVED })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('a save that is refused changes nothing on the page', () => {
  it('not_on_project: the dialog stays, the error is on the project picker, the list is not reloaded, no banner', async () => {
    useApi({ 'POST /time-entries': () => refusal(403, 'not_on_project') })
    await renderPage()
    const entriesBefore = entriesCalls().length

    await recordOnProject()

    expect(await inDialog().findByText(e.errors.notOnProject)).not.toBeNull()
    expect(dialog()).not.toBeNull()
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
    expect(entriesCalls()).toHaveLength(entriesBefore)
    expect((inDialog().getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe(
      'Project Alpha',
    )
  })

  it('host_unavailable fails closed: the alert says nothing was saved, and Save again records it', async () => {
    useApi({
      'POST /time-entries': sequence(() => refusal(503, 'host_unavailable'), (() => ({
        status: 201,
        body: SAVED,
      })) as FakeHandler),
    })
    await renderPage()
    await recordOnProject()

    const alert = await inDialog().findByRole('alert')
    expect(alert.textContent).toBe(e.errors.hostUnavailable.project)
    expect(alert.textContent).toMatch(/Nothing was saved/)
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()

    await pressSave()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(postCalls()).toHaveLength(2)
    expect(await screen.findByTestId('hours-entry-saved')).not.toBeNull()
  })

  it('a refusal that says the lists are out of date makes the page read them again', async () => {
    useApi({ 'POST /time-entries': () => refusal(422, 'category_retired') })
    await renderPage()
    expect(requests(api, 'GET /time-lists')).toHaveLength(1)
    await recordOtherWork()

    await waitFor(() => expect(requests(api, 'GET /time-lists')).toHaveLength(2))
    expect(await inDialog().findByText(e.errors.noLongerAvailable)).not.toBeNull()
  })
})

describe('the lists in the dialog', () => {
  it('when the page could not read them, the dialog says so and Try again reads them again', async () => {
    let calls = 0
    useApi({
      'GET /time-lists': (url, init, params) =>
        ++calls === 1 ? { status: 503, body: problem(503) } : listsHandler(ENTRY_LISTS)(url, init, params),
    })
    await renderPage()
    await userEvent.click(recordButton())
    await userEvent.click(inDialog().getByRole('radio', { name: f.on.options.none }))
    expect(inDialog().getByText(f.category.loadFailed)).not.toBeNull()

    await userEvent.click(inDialog().getByRole('button', { name: e.listsRetry }))
    await waitFor(() =>
      expect(
        within(inDialog().getByRole('combobox', { name: f.category.label }))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toContain('Formazione'),
    )
    expect(requests(api, 'GET /time-lists')).toHaveLength(2)
  })
})
