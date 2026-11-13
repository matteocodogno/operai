/**
 * @vitest-environment jsdom
 *
 * The earliest day of a Custom period, in BOTH views (specs/029-time-tracking T29, plan amendment 4 of
 * 2026-11-13, § Entries "A day"): a From or To before 01.01.2000 is a field error on that field and nothing is
 * asked, on My hours and on Everyone's hours alike — hours-api refuses such a day with a 400, which only a
 * client bug should ever reach. The rule lives in `lib/period.ts` and the Filters card, which both pages share;
 * this proves each page uses them. Its own file because it renders both pages, and My hours' tests are T27's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => {
  const { shellSessionMock, READ_ALL_HOLDER } = await import('../test-support/fakeSession')
  return shellSessionMock(apiFetch, { permissions: READ_ALL_HOLDER })
})

import { createAppRouter } from '../router'
import { strings } from '../strings'
import { fakeApi, listsHandler, requests } from '../test-support/fakeApi'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const f = strings.filters

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const VIEWS = [
  ['My hours', '/hours', 'hours-my-page'],
  ['Everyone’s hours', '/hours/all', 'hours-everyone-page'],
] as const

describe.each(VIEWS)('%s', (_name, path, testId) => {
  const open = async (search: string) => {
    const api = fakeApi({ 'GET /time-lists': listsHandler(LISTS) })
    apiFetch.mockImplementation(api)
    const history = createMemoryHistory({ initialEntries: [`${path}?${search}`] })
    render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
    await screen.findByTestId(testId)
    await screen.findByTestId('hours-filters')
    return api
  }

  const asked = (api: ReturnType<typeof fakeApi>) => [
    ...requests(api, 'GET /time-entries'),
    ...requests(api, 'GET /time-entries/totals'),
  ]

  it('a Custom From before 01.01.2000 is an error on From once the field is left, and nothing is sent', async () => {
    const api = await open('period=custom&from=1999-12-31&to=2026-11-13')
    expect(asked(api)).toHaveLength(0)
    expect(screen.queryByText(f.rangeErrors.tooEarly('01.01.2000'))).toBeNull()

    screen.getByLabelText(f.from).focus()
    await userEvent.tab()

    expect(await screen.findByText(f.rangeErrors.tooEarly('01.01.2000'))).not.toBeNull()
    expect(screen.getByLabelText(f.from).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText(f.to).getAttribute('aria-invalid')).toBeNull()
    expect(asked(api)).toHaveLength(0)
  })

  it('a Custom To before 01.01.2000 is an error on To, never "end before start", and nothing is sent', async () => {
    const api = await open('period=custom&from=2026-11-01&to=1999-12-31')
    screen.getByLabelText(f.to).focus()
    await userEvent.tab()

    expect(await screen.findByText(f.rangeErrors.tooEarly('01.01.2000'))).not.toBeNull()
    expect(screen.queryByText(f.rangeErrors.toBeforeFrom)).toBeNull()
    expect(screen.getByLabelText(f.to).getAttribute('aria-invalid')).toBe('true')
    expect(asked(api)).toHaveLength(0)
  })

  it('2000-01-01 itself is a day like any other: asked, no error', async () => {
    const api = await open('period=custom&from=2000-01-01&to=2000-06-30')
    await vi.waitFor(() => expect(requests(api, 'GET /time-entries')).toHaveLength(1))
    expect(requests(api, 'GET /time-entries')[0]!.query).toMatchObject({ from: '2000-01-01', to: '2000-06-30' })
    expect(screen.queryByText(f.rangeErrors.tooEarly('01.01.2000'))).toBeNull()
  })
})
