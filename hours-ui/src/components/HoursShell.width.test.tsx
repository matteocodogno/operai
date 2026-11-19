/**
 * @vitest-environment jsdom
 *
 * HoursShell's column (specs/20261116-record-hours-in-place T10, T19; design S6 and § Width, C1, D16; AC-5.33): `wide` —
 * the full width, the EstimAI workspace's — on EVERY hours page and view: My hours (the table view in either period and the
 * List), Everyone's hours, Settings and the not-found panel, so no switch of view, period or tab moves the column. It was
 * `wide` only while My hours showed the Week (T10); it no longer reads the route or the address at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () =>
  (await import('../test-support/fakeSession')).shellSessionMock(apiFetch, {
    permissions: (await import('../test-support/fakeSession')).READ_ALL_HOLDER,
  }),
)

import { createAppRouter } from '../router'
import { fakeApi } from '../test-support/fakeApi'
import HoursShell from './HoursShell'

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi())
})
afterEach(() => cleanup())

const renderAt = async (path: string, page: string) => {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter('/hours', HoursShell, history)
  render(<RouterProvider router={router} />)
  await screen.findByTestId(page)
  return router
}

const isWide = () => screen.getByTestId('hours-shell').classList.contains('tool-width-wide')

describe('the column of the tool (C1, AC-5.33)', () => {
  it.each([
    ['/hours', 'the table view, the current week'],
    ['/hours?week=2026-11-02', 'the table view, another week'],
    ['/hours?view=week', 'the first contract’s address of the week'],
    ['/hours?view=month', 'the month’s address'],
    ['/hours?view=list', 'the List'],
    ['/hours/?view=list', 'the List, with the address’s trailing slash'],
    ['/hours?view=anything-else', 'a view this page does not have'],
  ])('is wide on My hours at %s (%s)', async (path) => {
    await renderAt(path, 'hours-my-page')
    expect(isWide()).toBe(true)
  })

  it('is wide on Everyone’s hours, on Settings and on the not-found panel: no page of the tool is narrower than another', async () => {
    await renderAt('/hours/all', 'hours-everyone-page')
    expect(isWide()).toBe(true)
    cleanup()
    await renderAt('/hours/settings', 'hours-shell')
    expect(isWide()).toBe(true)
    cleanup()
    await renderAt('/hours/nope', 'hours-not-found')
    expect(isWide()).toBe(true)
  })

  it('follows no address: ?view=list on Everyone’s hours and Settings changes nothing', async () => {
    await renderAt('/hours/all?view=list', 'hours-everyone-page')
    expect(isWide()).toBe(true)
    cleanup()
    await renderAt('/hours/settings?view=list', 'hours-shell')
    expect(isWide()).toBe(true)
  })

  it('stays wide from the table view to the List and back, without remounting the page: nothing jumps', async () => {
    const router = await renderAt('/hours', 'hours-my-page')
    const page = screen.getByTestId('hours-my-page')
    expect(isWide()).toBe(true)

    await act(() => router.navigate({ to: '/', search: { view: 'list' } as never }))
    expect(isWide()).toBe(true)

    await act(() => router.navigate({ to: '/', search: {} as never }))
    expect(isWide()).toBe(true)
    expect(screen.getByTestId('hours-my-page')).toBe(page)
  })

  it('stays wide from My hours to Everyone’s hours and Settings: the tabs do not change the column either', async () => {
    const router = await renderAt('/hours', 'hours-my-page')
    const shell = screen.getByTestId('hours-shell')

    await act(() => router.navigate({ to: '/all' }))
    await screen.findByTestId('hours-everyone-page')
    expect(isWide()).toBe(true)

    await act(() => router.navigate({ to: '/settings' }))
    expect(isWide()).toBe(true)
    expect(screen.getByTestId('hours-shell')).toBe(shell)
  })
})
