/**
 * @vitest-environment jsdom
 *
 * My hours, T28's part: Edit and Delete on a row (specs/029-time-tracking; AC-1.5, AC-2.4, AC-2.12, AC-3.4, AC-4.10;
 * design F2, F3, S1, S2, S3). Rendered through the inner router with `fakeApi` behind `apiFetch`, so the request is
 * the one the real `hoursApi` builds. The dialog's own rules, fields and refusals are `EntryDialog.edit.test.tsx`;
 * this is the page around it: what a save or a delete asks of the server, what the page reads again, where focus
 * goes, and what it says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import { deferred, entriesPage, fakeApi, listsHandler, requests, sequence } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { ALPHA, HIDDEN_PROJECT, KICKOFF, TRAINING, totalsWithDays } from '../test-support/fixtures/entries'
import { DEAL_ROWS, EDIT_RETIRED_CATEGORY, ENTRY_LISTS, PROJECT_ROWS, refusal } from '../test-support/fixtures/entry'
import { TODAY_INSTANT } from '../test-support/fixtures/myHours'
import { activitiesAnswer, projectTasks } from '../test-support/fixtures/activity'

const e = strings.entry
const f = e.fields

let api: ReturnType<typeof fakeApi>

/** The entries the server holds now: a delete removes one, so the list read again no longer has it. */
let held = [ALPHA, HIDDEN_PROJECT, KICKOFF, TRAINING]

const entriesNow: FakeHandler = () => ({ status: 200, body: entriesPage(held) })

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(ENTRY_LISTS),
    'GET /time-entries': entriesNow,
    'GET /time-entries/totals': totalsWithDays,
    'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
    'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
    'GET /activities': () => activitiesAnswer(projectTasks),
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
  held = [ALPHA, HIDDEN_PROJECT, KICKOFF, TRAINING]
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const recordButton = () => screen.getByRole('button', { name: e.record })
const heading = () => screen.getByRole('heading', { level: 2, name: strings.myHours.heading })
const editButton = (id: string) => screen.getByTestId(`hours-entry-${id}-edit`)
const deleteButton = (id: string) => screen.getByTestId(`hours-entry-${id}-delete`)
const editDialog = () => screen.getByRole('dialog', { name: e.dialog.editTitle })
const inEdit = () => within(editDialog())
const deleteDialog = () => screen.getByRole('alertdialog', { name: e.delete.title })
const inDelete = () => within(deleteDialog())
const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )
const patchCalls = () => requests(api, 'PATCH /time-entries/:id')
const deleteCalls = () => requests(api, 'DELETE /time-entries/:id')

const pressSave = () => userEvent.click(inEdit().getByRole('button', { name: e.dialog.save }))
const confirmDelete = () => userEvent.click(inDelete().getByRole('button', { name: e.delete.confirm }))
const chooseDuration = (value: string) =>
  userEvent.selectOptions(inEdit().getByRole('combobox', { name: f.duration.label }), value)

describe('Edit on a row (F2; AC-1.5)', () => {
  it('opens "Edit entry" filled from the row, reading nothing more of the entry itself', async () => {
    useApi()
    await renderPage()
    const before = apiFetch.mock.calls.length
    await userEvent.click(editButton('e-alpha'))

    expect(editDialog()).not.toBeNull()
    expect((inEdit().getByRole('combobox', { name: f.duration.label }) as HTMLSelectElement).value).toBe('240')
    expect((inEdit().getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('Project Alpha')
    expect((inEdit().getByRole('combobox', { name: f.workType.label }) as HTMLSelectElement).value).toBe('wt-p-dev')
    expect(document.activeElement).toBe(inEdit().getByLabelText(new RegExp(`^${f.day}`)))
    // Only the activity read of the picked project: no `GET /time-entries/{id}`, and the lists are the page's.
    const reads = apiFetch.mock.calls.slice(before).map(([url]) => new URL(String(url)).pathname)
    expect(reads.every((path) => path === '/activities')).toBe(true)
    expect(requests(api, 'GET /time-lists')).toHaveLength(1)
  })

  it('Edit is on the rows of the list, one per entry, each naming its entry', async () => {
    useApi()
    await renderPage()
    expect(editButton('e-alpha').getAttribute('aria-label')).toBe('Edit 4 h on Project Alpha, 12.11.2026')
    expect(editButton('e-hidden').getAttribute('aria-label')).toBe(
      'Edit 2 h on a project not visible to you, 12.11.2026',
    )
    expect(screen.getAllByRole('button', { name: /^Edit /u })).toHaveLength(4)
  })

  it('a save PATCHes only what changed, then closes, returns focus to Record hours, reads again and says it was saved', async () => {
    useApi()
    await renderPage()
    const entriesBefore = entriesCalls().length
    const daysBefore = totalsCalls('day').length
    const groupedBefore = totalsCalls('project').length

    await userEvent.click(editButton('e-alpha'))
    await chooseDuration('60')
    await pressSave()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(patchCalls()).toHaveLength(1)
    expect(patchCalls()[0]).toMatchObject({ method: 'PATCH', path: '/time-entries/e-alpha', body: { minutes: 60 } })
    expect(patchCalls()[0]!.body).toEqual({ minutes: 60 })
    expect(patchCalls()[0]!.query).toEqual({})

    await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
    await waitFor(() => expect(totalsCalls('day')).toHaveLength(daysBefore + 1))
    await waitFor(() => expect(totalsCalls('project')).toHaveLength(groupedBefore + 1))
    expect(entriesCalls().at(-1)!.query).toEqual(entriesCalls()[0]!.query)

    const banner = await screen.findByTestId('hours-entry-saved')
    expect(banner.textContent).toBe(e.saved)
    expect(banner.closest('[role="status"]')).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(recordButton()))
  })

  it('sends no If-Match: an entry has one writer, its person (ADR-0088)', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    await chooseDuration('60')
    await pressSave()
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    const init = apiFetch.mock.calls.find(([, call]) => (call as RequestInit | undefined)?.method === 'PATCH')![1] as
      RequestInit | undefined
    expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain('if-match')
  })

  it('shows the saved entry that the reloaded list holds', async () => {
    useApi({
      'PATCH /time-entries/:id': () => {
        held = [{ ...ALPHA, minutes: 60 }, HIDDEN_PROJECT, KICKOFF, TRAINING]
        return { status: 200, body: held[0] }
      },
    })
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    await chooseDuration('60')
    await pressSave()
    await waitFor(() =>
      expect(
        within(screen.getByTestId('hours-entry-e-alpha')).getByText('1 h', { selector: '[aria-hidden]' }),
      ).not.toBeNull(),
    )
  })

  it('moving the entry to a day outside the period says so, so it does not look lost', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    fireEvent.change(inEdit().getByLabelText(new RegExp(`^${f.day}`)), { target: { value: '2026-10-20' } })
    await pressSave()

    const banner = await screen.findByTestId('hours-entry-saved')
    expect(banner.textContent).toBe(e.savedOutsidePeriod('20.10.2026'))
    expect(patchCalls()[0]!.body).toEqual({ day: '2026-10-20' })
  })

  it('an edit of the day inside the period does not say that', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    fireEvent.change(inEdit().getByLabelText(new RegExp(`^${f.day}`)), { target: { value: '2026-11-10' } })
    await pressSave()
    expect((await screen.findByTestId('hours-entry-saved')).textContent).toBe(e.saved)
  })

  it('Cancel closes it with no request, and gives focus back to the Edit button that opened it', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    const before = apiFetch.mock.calls.length
    await userEvent.click(inEdit().getByRole('button', { name: strings.common.cancel }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(editButton('e-alpha'))
    expect(patchCalls()).toHaveLength(0)
    expect(apiFetch.mock.calls.length).toBe(before)
  })

  it('Save with nothing changed closes it and asks nothing of the server', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    const entriesBefore = entriesCalls().length
    await pressSave()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(patchCalls()).toHaveLength(0)
    expect(entriesCalls()).toHaveLength(entriesBefore)
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
    expect(document.activeElement).toBe(editButton('e-alpha'))
  })

  it('an entry whose project the person can no longer read opens the "not visible" variant, and a day change saves', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-hidden'))

    expect((inEdit().getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe(
      strings.names.hidden,
    )
    expect(inEdit().getByRole('combobox', { name: strings.activity.label }).getAttribute('aria-disabled')).toBe('true')
    expect(requests(api, 'GET /activities')).toHaveLength(0)

    await chooseDuration('90')
    await pressSave()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(patchCalls()[0]).toMatchObject({ path: '/time-entries/e-hidden', body: { minutes: 90 } })
    expect(patchCalls()[0]!.body).toEqual({ minutes: 90 })
  })

  it('moving the entry to another project PATCHes `on` and the activity it clears, as the person', async () => {
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    const project = inEdit().getByRole('combobox', { name: f.project.label })
    await userEvent.clear(project)
    await userEvent.type(project, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await pressSave()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(patchCalls()[0]!.body).toEqual({ on: { type: 'project', id: 'p2' }, activityId: null })
  })

  it('an entry on a retired category: a note-only edit PATCHes `{ note }`', async () => {
    held = [EDIT_RETIRED_CATEGORY]
    useApi()
    await renderPage()
    await userEvent.click(editButton('e-retired-category'))
    await userEvent.type(inEdit().getByRole('textbox', { name: new RegExp(`^${f.note.label}`) }), 'Conference day')
    await pressSave()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(patchCalls()[0]!.body).toEqual({ note: 'Conference day' })
  })
})

describe('a refused edit changes nothing on the page', () => {
  it('not_on_project after a move: the dialog stays, the error is on the picker, nothing is reloaded, no banner', async () => {
    useApi({ 'PATCH /time-entries/:id': () => refusal(403, 'not_on_project') })
    await renderPage()
    const entriesBefore = entriesCalls().length
    await userEvent.click(editButton('e-alpha'))
    const project = inEdit().getByRole('combobox', { name: f.project.label })
    await userEvent.clear(project)
    await userEvent.type(project, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await pressSave()

    expect(await inEdit().findByText(e.errors.notOnProject)).not.toBeNull()
    expect(editDialog()).not.toBeNull()
    expect(screen.queryByTestId('hours-entry-saved')).toBeNull()
    expect(entriesCalls()).toHaveLength(entriesBefore)
    // The stored target stays: the list still shows the entry on its project.
    expect(within(screen.getByTestId('hours-entry-e-alpha')).getByText('Project Alpha')).not.toBeNull()
  })

  it('host_unavailable fails closed, and Save again records it', async () => {
    useApi({
      'PATCH /time-entries/:id': sequence(() => refusal(503, 'host_unavailable'), (() => ({
        status: 200,
        body: ALPHA,
      })) as FakeHandler),
    })
    await renderPage()
    await userEvent.click(editButton('e-alpha'))
    const project = inEdit().getByRole('combobox', { name: f.project.label })
    await userEvent.clear(project)
    await userEvent.type(project, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await pressSave()

    const alert = await inEdit().findByRole('alert')
    expect(alert.textContent).toBe(e.errors.hostUnavailable.project)
    await pressSave()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(patchCalls()).toHaveLength(2)
  })

  /** Moves the entry to Project Beta and saves. */
  const moveToBeta = async () => {
    const project = inEdit().getByRole('combobox', { name: f.project.label })
    await userEvent.clear(project)
    await userEvent.type(project, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await pressSave()
  }

  // hours-api answers the ENTRY gone (not the caller's, or deleted in another tab) as a 404 with NO `code`; a
  // `not_found` on a save that kept the target can only be about the entry too, as nothing else was asked.
  it.each([
    ['with no code (what hours-api answers for the entry)', () => refusal(404)],
    ['with `not_found`', () => refusal(404, 'not_found')],
  ])(
    'a 404 %s on a save that kept the target says the entry can no longer be found, and the list reloads when the dialog closes',
    async (_name, answer) => {
      useApi({ 'PATCH /time-entries/:id': answer })
      await renderPage()
      const entriesBefore = entriesCalls().length
      await userEvent.click(editButton('e-alpha'))
      await chooseDuration('60')
      await pressSave()

      const alert = await inEdit().findByRole('alert')
      expect(alert.textContent).toBe(e.errors.entryGone)
      expect(editDialog()).not.toBeNull()
      expect(entriesCalls()).toHaveLength(entriesBefore)
      expect(screen.queryByTestId('hours-entry-saved')).toBeNull()

      await userEvent.click(inEdit().getByRole('button', { name: strings.common.cancel }))
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
      await waitFor(() => expect(totalsCalls('day').length).toBeGreaterThan(1))
      // The Edit button the dialog came from is gone with the reload: focus goes to the page heading.
      await waitFor(() => expect(document.activeElement).toBe(heading()))
    },
  )

  it('a 404 with NO code after a MOVE is still the entry gone: the alert, and the list reloads when the dialog closes', async () => {
    useApi({ 'PATCH /time-entries/:id': () => refusal(404) })
    await renderPage()
    const entriesBefore = entriesCalls().length
    await userEvent.click(editButton('e-alpha'))
    await moveToBeta()

    expect((await inEdit().findByRole('alert')).textContent).toBe(e.errors.entryGone)
    expect(screen.queryByText(e.errors.targetGone.project)).toBeNull()
    expect(entriesCalls()).toHaveLength(entriesBefore)

    await userEvent.click(inEdit().getByRole('button', { name: strings.common.cancel }))
    await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('`not_found` after a move is the new target’s: on the picker, and the list is not marked stale', async () => {
    useApi({ 'PATCH /time-entries/:id': () => refusal(404, 'not_found') })
    await renderPage()
    const entriesBefore = entriesCalls().length
    await userEvent.click(editButton('e-alpha'))
    const project = inEdit().getByRole('combobox', { name: f.project.label })
    await userEvent.clear(project)
    await userEvent.type(project, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await pressSave()
    expect(await inEdit().findByText(e.errors.targetGone.project)).not.toBeNull()

    await userEvent.click(inEdit().getByRole('button', { name: strings.common.cancel }))
    expect(entriesCalls()).toHaveLength(entriesBefore)
  })
})

describe('Delete on a row (F3, S3; AC-1.5)', () => {
  it('opens a danger confirmation with focus on Cancel, naming the duration, the name and the date, and sends nothing', async () => {
    useApi()
    await renderPage()
    const before = apiFetch.mock.calls.length
    await userEvent.click(deleteButton('e-alpha'))

    expect(deleteDialog()).not.toBeNull()
    expect(document.activeElement).toBe(inDelete().getByRole('button', { name: strings.common.cancel }))
    expect(inDelete().getByText("4 h on Project Alpha, 12.11.2026. This can't be undone.")).not.toBeNull()
    expect(inDelete().getByRole('button', { name: e.delete.confirm }).className).toContain('btn-danger')
    expect(apiFetch.mock.calls.length).toBe(before)
    expect(deleteCalls()).toHaveLength(0)
  })

  it('names a target the person cannot read as "a project that is not visible to you", never by name', async () => {
    useApi()
    await renderPage()
    await userEvent.click(deleteButton('e-hidden'))
    expect(
      inDelete().getByText("2 h on a project that is not visible to you, 12.11.2026. This can't be undone."),
    ).not.toBeNull()
    expect(deleteDialog().textContent).not.toContain('Secret project')
  })

  it('names a meeting and other work as their rows do', async () => {
    useApi()
    await renderPage()
    await userEvent.click(deleteButton('e-kickoff'))
    expect(inDelete().getByText("2 h 30 on Kick-off call, 12.11.2026. This can't be undone.")).not.toBeNull()
    await userEvent.click(inDelete().getByRole('button', { name: strings.common.cancel }))
    await userEvent.click(deleteButton('e-training'))
    expect(inDelete().getByText("4 h on other work (Formazione), 10.11.2026. This can't be undone.")).not.toBeNull()
  })

  it('Cancel sends nothing and gives focus back to the Delete button', async () => {
    useApi()
    await renderPage()
    await userEvent.click(deleteButton('e-alpha'))
    await userEvent.click(inDelete().getByRole('button', { name: strings.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    expect(document.activeElement).toBe(deleteButton('e-alpha'))
  })

  it('Escape cancels it', async () => {
    useApi()
    await renderPage()
    await userEvent.click(deleteButton('e-alpha'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
  })

  it('a confirmed delete removes the row, reads the entries, the totals and the day totals again, and focuses the heading', async () => {
    useApi({
      'DELETE /time-entries/:id': () => {
        held = held.filter((entry) => entry.id !== 'e-alpha')
        return { status: 204 }
      },
    })
    await renderPage()
    expect(screen.getByTestId('hours-entry-e-alpha')).not.toBeNull()
    const entriesBefore = entriesCalls().length
    const daysBefore = totalsCalls('day').length
    const groupedBefore = totalsCalls('project').length

    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteCalls()).toHaveLength(1)
    expect(deleteCalls()[0]).toMatchObject({ method: 'DELETE', path: '/time-entries/e-alpha' })
    await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
    await waitFor(() => expect(totalsCalls('day')).toHaveLength(daysBefore + 1))
    await waitFor(() => expect(totalsCalls('project')).toHaveLength(groupedBefore + 1))
    await waitFor(() => expect(screen.queryByTestId('hours-entry-e-alpha')).toBeNull())
    expect(screen.getByTestId('hours-entry-e-hidden')).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading()))
    expect(heading().getAttribute('tabindex')).toBe('-1')
  })

  it('confirms with a compact success banner where the person acted', async () => {
    useApi({
      'DELETE /time-entries/:id': () => {
        held = held.filter((entry) => entry.id !== 'e-alpha')
        return { status: 204 }
      },
    })
    await renderPage()
    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()

    const banner = await screen.findByTestId('hours-entry-deleted')
    expect(banner.textContent).toBe(e.delete.deleted)
    expect(banner.closest('[role="status"]')).not.toBeNull()
  })

  it('works for an entry on a project the person cannot read: there is no bookability check on a delete', async () => {
    useApi({ 'DELETE /time-entries/:id': () => ({ status: 204 }) })
    await renderPage()
    await userEvent.click(deleteButton('e-hidden'))
    await confirmDelete()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteCalls()[0]).toMatchObject({ path: '/time-entries/e-hidden' })
  })

  it('while the request runs the dialog says so, cannot be dismissed, and closes only when it answered', async () => {
    const answer = deferred<{ status: number }>()
    useApi({ 'DELETE /time-entries/:id': () => answer.promise })
    await renderPage()
    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()

    expect(inDelete().getByRole('button', { name: e.delete.busy })).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(deleteDialog()).not.toBeNull()
    expect(screen.queryByTestId('hours-entry-deleted')).toBeNull()
    answer.resolve({ status: 204 })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  // A delete has no target to ask about, so a 404 — with the code hours-api answers or without — is the entry.
  it.each([
    ['with no code (what hours-api answers)', () => refusal(404)],
    ['with `not_found`', () => refusal(404, 'not_found')],
  ])('a 404 %s is "already gone": it closes, reads again, and an info banner says so', async (_name, answer) => {
    useApi({
      'DELETE /time-entries/:id': () => {
        held = held.filter((entry) => entry.id !== 'e-alpha')
        return answer()
      },
    })
    await renderPage()
    const entriesBefore = entriesCalls().length
    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const banner = await screen.findByTestId('hours-entry-gone')
    expect(banner.textContent).toContain(e.delete.gone)
    expect(banner.closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByTestId('hours-entry-deleted')).toBeNull()
    await waitFor(() => expect(entriesCalls()).toHaveLength(entriesBefore + 1))
    await waitFor(() => expect(screen.queryByTestId('hours-entry-e-alpha')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('any other failure stays in the dialog as an alert, nothing is removed or reloaded, and Delete again retries', async () => {
    useApi({
      'DELETE /time-entries/:id': sequence(() => refusal(503, 'host_unavailable'), (() => ({
        status: 204,
      })) as FakeHandler),
    })
    await renderPage()
    const entriesBefore = entriesCalls().length
    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()

    const alert = await inDelete().findByRole('alert')
    expect(alert.textContent).toBe(e.delete.error)
    expect(deleteDialog()).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-alpha')).not.toBeNull()
    expect(entriesCalls()).toHaveLength(entriesBefore)
    expect(screen.queryByTestId('hours-entry-deleted')).toBeNull()

    await confirmDelete()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteCalls()).toHaveLength(2)
  })

  it('a network failure is the same inline error, and the entry is untouched', async () => {
    useApi({
      'DELETE /time-entries/:id': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await renderPage()
    await userEvent.click(deleteButton('e-alpha'))
    await confirmDelete()
    expect((await inDelete().findByRole('alert')).textContent).toBe(e.delete.error)
    expect(screen.getByTestId('hours-entry-e-alpha')).not.toBeNull()
  })
})
