/**
 * @vitest-environment jsdom
 *
 * ActivityTimeline keeps the rows it still lists (specs/20261116-record-hours-in-place design S3, plan G1, QE D3):
 * hours-ui's Record hours shows its success message in the row, and the message "goes by ×, by the next save, or by
 * leaving the page" — never because another write in the same card made the list reload. The company, deal and
 * contact pages all show their activities through this one card, so a write (Mark done, Edit, Delete, Log activity)
 * re-reads the list behind the rows already on screen: a row the re-read still lists keeps its element, and with
 * it the widget's message; a row it removes goes; the first load and a failed load behave as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import ActivityTimeline from './ActivityTimeline'
import type { ActivityTarget } from '../lib/activitiesApi'
import type { Activity, PersonRef } from '../lib/types'
import { fakeApi, page } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { RouterWrapper } from '../test-support/RouterWrapper'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  useSession: () => ({ data: { user: { id: 'u-me' } } }),
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))
// The real widget keeps its success message in its own state, which is what an unmounted row loses.
vi.mock('shell/extensions', async () => {
  const { useState } = await import('react')
  const Widget = () => {
    const [message, setMessage] = useState<string | null>(null)
    return (
      <>
        <button type="button" data-testid="hours-widget" onClick={() => setMessage('2 h recorded')}>
          Record hours
        </button>
        {message && (
          <p role="status" data-testid="hours-message">
            {message}
          </p>
        )}
      </>
    )
  }
  return {
    HostExtension: ({ name }: { name: string; props: Record<string, string>; fallback: ReactNode }) =>
      name === 'hours.recordHours' ? <Widget /> : null,
  }
})

const person = (id: string): PersonRef => ({ id, name: `Person ${id}`, status: 'active' })

const task = (id: string, subject: string, overrides: { assignee?: string; author?: string; done?: boolean } = {}) =>
  ({
    id,
    type: 'task',
    subject,
    body: null,
    occurredAt: '2026-11-03T09:30:00.000Z',
    company: { id: 'c1', name: 'Acme SA' },
    contact: null,
    deal: { id: 'd1', title: 'Platform rebuild' },
    author: person(overrides.author ?? 'u-author'),
    participants: [],
    task: {
      dueDate: null,
      assignee: person(overrides.assignee ?? 'u-else'),
      completedAt: overrides.done ? '2026-11-10T10:00:00.000Z' : null,
      completedBy: overrides.done ? person('u-else') : null,
    },
    createdAt: '2026-11-03T08:00:00.000Z',
    updatedAt: '2026-11-03T08:00:00.000Z',
  }) satisfies Activity

/** Mine to record hours on (the row under test), someone else's to mark done, one I wrote (Edit and Delete). */
const MINE = task('mine', 'Send the offer', { assignee: 'u-me' })
const THEIRS = task('theirs', 'Prepare the demo')
const WRITTEN = task('written', 'Book the room', { author: 'u-me' })

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/**
 * The list the server holds, with a gate on every read after the first: a test sees the card between the write
 * landing and the re-read answering, which is the moment a skeleton used to replace the rows.
 */
function server(initial: Activity[]) {
  const state = { items: initial, reads: 0, gate: deferred(), failNextRead: false }
  const routes = {
    'GET /activities': async (): Promise<FakeAnswer> => {
      state.reads += 1
      if (state.failNextRead) {
        state.failNextRead = false
        return { status: 500, body: { status: 500, title: 'Internal Server Error', detail: 'Boom' } }
      }
      if (state.reads > 1) await state.gate.promise
      return { status: 200, body: page(state.items) }
    },
    'POST /activities/theirs/complete': (): FakeAnswer => {
      const done = task('theirs', 'Prepare the demo', { done: true })
      state.items = state.items.map((item) => (item.id === 'theirs' ? done : item))
      return { status: 200, body: done }
    },
    'DELETE /activities/written': (): FakeAnswer => {
      state.items = state.items.filter((item) => item.id !== 'written')
      return { status: 204 }
    },
    'POST /activities': (): FakeAnswer => {
      const created = task('logged', 'Called Acme')
      state.items = [created, ...state.items]
      return { status: 201, body: created }
    },
    'PATCH /activities/written': (): FakeAnswer => {
      const edited = { ...WRITTEN, subject: 'Book the big room' }
      state.items = state.items.map((item) => (item.id === 'written' ? edited : item))
      return { status: 200, body: edited }
    },
  }
  apiFetch.mockImplementation(fakeApi(routes))
  return state
}

const TARGETS: [string, ActivityTarget][] = [
  ['a deal’s page', { dealId: 'd1' }],
  ['a company’s page', { companyId: 'c1' }],
  ['a contact’s page', { contactId: 'k1' }],
]

const showTimeline = (target: ActivityTarget) =>
  render(<ActivityTimeline target={target} company={{ id: 'c1', name: 'Acme SA' }} />, { wrapper: RouterWrapper })
const rowOf = (id: string) => screen.getByTestId(`crm-activity-${id}`)

/** Mine has recorded hours: its row now holds the widget's message. */
async function recordedOnMine() {
  fireEvent.click(await within(rowOf('mine')).findByTestId('hours-widget'))
  expect(within(rowOf('mine')).getByTestId('hours-message').textContent).toBe('2 h recorded')
  return rowOf('mine')
}

/** The write has landed and the re-read is pending: the card says so and shows no skeleton. */
const waitForSavedBehindRows = async (message: string) => {
  expect((await screen.findByTestId('crm-saved')).textContent).toContain(message)
  expect(screen.queryByTestId('crm-loading')).toBeNull()
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ActivityTimeline — a write elsewhere in the card does not unmount the rows still listed', () => {
  it.each(TARGETS)(
    '%s: Mark done on another row keeps this row’s element and its hours message',
    async (_p, target) => {
      const api = server([MINE, THEIRS, WRITTEN])
      showTimeline(target)
      await screen.findByText('Send the offer')
      const mine = await recordedOnMine()

      fireEvent.click(screen.getByTestId('crm-activity-theirs-toggle'))
      await waitForSavedBehindRows('Activity saved.')
      // While the re-read is out, and after it answers, the same element still holds the message.
      expect(rowOf('mine')).toBe(mine)
      expect(within(mine).getByTestId('hours-message')).not.toBeNull()

      api.gate.resolve()
      await waitFor(() =>
        expect(within(rowOf('theirs')).getByTestId('crm-activity-theirs-toggle').textContent).toContain('Reopen'),
      )
      expect(api.reads).toBe(2)
      expect(rowOf('mine')).toBe(mine)
      expect(mine.isConnected).toBe(true)
      expect(within(mine).getByTestId('hours-message').textContent).toBe('2 h recorded')
    },
  )

  it('Delete of a row above this one: that row goes with its dialog, this row keeps its element and message', async () => {
    // The deleted row sits above, so every row below it moves up one place.
    const api = server([WRITTEN, MINE, THEIRS])
    showTimeline({ dealId: 'd1' })
    await screen.findByText('Send the offer')
    const mine = await recordedOnMine()

    fireEvent.click(within(rowOf('written')).getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByTestId('crm-activity-delete-confirm'))
    await waitForSavedBehindRows('Activity deleted.')
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message')).not.toBeNull()

    api.gate.resolve()
    await waitFor(() => expect(screen.queryByTestId('crm-activity-written')).toBeNull())
    expect(screen.queryByTestId('crm-activity-delete-confirm')).toBeNull()
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message').textContent).toBe('2 h recorded')
    expect(rowOf('theirs')).not.toBeNull()
  })

  it('Edit of another row: this row keeps its element and message', async () => {
    const api = server([MINE, THEIRS, WRITTEN])
    showTimeline({ companyId: 'c1' })
    await screen.findByText('Send the offer')
    const mine = await recordedOnMine()

    fireEvent.click(within(rowOf('written')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit activity' })
    fireEvent.change(within(dialog).getByLabelText('Subject', { exact: false }), {
      target: { value: 'Book the big room' },
    })
    fireEvent.click(within(dialog).getByTestId('crm-activity-form-submit'))
    await waitForSavedBehindRows('Activity saved.')
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message')).not.toBeNull()

    api.gate.resolve()
    await screen.findByText('Book the big room')
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message').textContent).toBe('2 h recorded')
  })

  it('Log activity: the new row appears above after the re-read and this row keeps its element and message', async () => {
    const api = server([MINE, THEIRS])
    showTimeline({ dealId: 'd1' })
    await screen.findByText('Send the offer')
    const mine = await recordedOnMine()

    fireEvent.click(screen.getByTestId('crm-activity-log'))
    const dialog = await screen.findByRole('dialog', { name: 'Log activity' })
    fireEvent.change(within(dialog).getByLabelText('Subject', { exact: false }), { target: { value: 'Called Acme' } })
    fireEvent.click(within(dialog).getByTestId('crm-activity-form-submit'))
    await waitForSavedBehindRows('Activity logged.')
    expect(screen.queryByTestId('crm-activity-logged')).toBeNull()
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message')).not.toBeNull()

    api.gate.resolve()
    await screen.findByTestId('crm-activity-logged')
    expect(rowOf('mine')).toBe(mine)
    expect(within(mine).getByTestId('hours-message').textContent).toBe('2 h recorded')
  })

  it('a row the re-read no longer lists goes, with its message', async () => {
    const api = server([MINE, THEIRS])
    showTimeline({ dealId: 'd1' })
    await screen.findByText('Send the offer')
    await recordedOnMine()

    // The task was removed by someone else; my Mark done on the other row re-reads a list without it.
    api.items = api.items.filter((item) => item.id !== 'mine')
    fireEvent.click(screen.getByTestId('crm-activity-theirs-toggle'))
    await waitForSavedBehindRows('Activity saved.')
    api.gate.resolve()
    await waitFor(() => expect(screen.queryByTestId('crm-activity-mine')).toBeNull())
    expect(screen.queryByTestId('hours-message')).toBeNull()
    expect(screen.getByTestId('crm-activity-theirs')).not.toBeNull()
  })
})

describe('ActivityTimeline — loading and failing as designed', () => {
  it('the first load shows the skeleton, not rows', async () => {
    const api = server([MINE])
    api.reads = 1 // the gate applies to this very first read
    showTimeline({ dealId: 'd1' })

    expect(screen.getByTestId('crm-loading')).not.toBeNull()
    expect(screen.queryByTestId('crm-activity-mine')).toBeNull()
    api.gate.resolve()
    await screen.findByTestId('crm-activity-mine')
    expect(screen.queryByTestId('crm-loading')).toBeNull()
  })

  it('a re-read that fails after a write is the error state with Retry, and Retry brings the rows back', async () => {
    const api = server([MINE, THEIRS])
    showTimeline({ dealId: 'd1' })
    await screen.findByText('Send the offer')

    api.failNextRead = true
    fireEvent.click(screen.getByTestId('crm-activity-theirs-toggle'))
    expect(await screen.findByTestId('crm-load-error')).not.toBeNull()
    expect(screen.queryByTestId('crm-activity-mine')).toBeNull()

    api.gate.resolve()
    fireEvent.click(await screen.findByTestId('crm-load-error-retry'))
    await screen.findByTestId('crm-activity-mine')
    expect(screen.queryByTestId('crm-load-error')).toBeNull()
  })

  it('an empty list is the empty state, and a write that empties it shows it', async () => {
    const api = server([THEIRS])
    showTimeline({ dealId: 'd1' })
    await screen.findByText('Prepare the demo')

    api.items = []
    fireEvent.click(screen.getByTestId('crm-activity-theirs-toggle'))
    await waitForSavedBehindRows('Activity saved.')
    api.gate.resolve()
    expect(await screen.findByText('No activity yet')).not.toBeNull()
    expect(screen.queryByTestId('crm-activity-theirs')).toBeNull()
  })
})
