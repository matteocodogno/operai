/**
 * @vitest-environment jsdom
 *
 * A long Tasks card × Record hours (specs/20261116-record-hours-in-place plan R1): a list mounts one widget per
 * row the person may record on and NONE for the rest, and the whole list asks for `shell/extensions` once, not once
 * per row — the federation runtime caches the module after the first import, so it is evaluated once however many
 * rows ask for it. The mock factory counts how often the module is evaluated.
 *
 * The two tests are ORDER-DEPENDENT on purpose and share one module registry (a vitest module mock lives per file): the
 * first proves a list with no row the person may record on never loads the seam at all (the count stays 0), the
 * second that 100 rows load it once. Run the file as a whole, or each test alone: both pass either way, but
 * reversed in one run the first would see the second's import.
 *
 * Rows mount in one commit, so they import `shell/extensions` in the same tick, and vitest gives a factory mock
 * to only the first of such concurrent imports (the aliased stub file to the others: a harness limit that the
 * federation runtime does not have). So this file asserts that every row mounted ITS OWN action, widget or link, and
 * leaves "every row shows the widget" to MyTasksPageRow.recordHours.test.tsx, which automocks the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fakeApi, personRef, projectDetail, projectTask } from '../test-support/fakeApi'
import TasksCard from './TasksCard'

const { apiFetch, seam } = vi.hoisted(() => ({ apiFetch: vi.fn(), seam: { factoryRuns: 0 } }))

vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

vi.mock('shell/extensions', () => {
  seam.factoryRuns += 1
  return { HostExtension: () => <button data-testid="widget-record-hours">Record hours</button> }
})

const person = (id: string) => personRef(id, id)
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25 })

const renderCard = (items: unknown[]) => {
  apiFetch.mockImplementation(fakeApi({ 'GET /tasks': () => ({ status: 200, body: page(items) }) }))
  render(<TasksCard project={projectDetail()} canManage={false} currentUserId="u-ada" />)
}

/** The row's own action, whichever of the widget and its fallback link the harness gave it. */
const actionOf = (row: HTMLElement) =>
  row.querySelector('[data-testid="widget-record-hours"], [data-testid="record-hours-fallback"]')

/** Lets the rows' dynamic imports settle, so a count that stays 0 is not just "not yet". */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50))

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

describe('a long Tasks card (R1)', () => {
  it('never loads `shell/extensions` when no row is one the person may record on', async () => {
    const theirs = Array.from({ length: 30 }, (_, i) =>
      projectTask(`o${i}`, { author: person('u-other') }, { assignee: person('u-other') }),
    )
    renderCard(theirs)

    await screen.findAllByTestId(/^project-task-o\d+$/)
    await settled()
    expect(screen.getAllByTestId(/^project-task-o\d+$/)).toHaveLength(30)
    expect(seam.factoryRuns).toBe(0)
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
    expect(screen.queryByTestId('record-hours-fallback')).toBeNull()
  })

  it('imports `shell/extensions` once for 100 rows the person may record on, and gives every row an action of its own', async () => {
    renderCard(Array.from({ length: 100 }, (_, i) => projectTask(`t${i}`)))

    await waitFor(() => expect(screen.getAllByTestId(/^project-task-t\d+$/)).toHaveLength(100))
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^project-task-t\d+$/)
      expect(rows.filter((row) => actionOf(row) !== null)).toHaveLength(100)
    })
    expect(seam.factoryRuns).toBe(1)
  })
})
