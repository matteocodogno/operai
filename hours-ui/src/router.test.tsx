/**
 * @vitest-environment jsdom
 *
 * The inner router (specs/029-time-tracking T22): My hours at the root, Everyone's hours at `/all`
 * and a not-found fallback, all under the shell's `/hours` basepath, with `HoursShell` as the root
 * layout. A memory history stands in for the browser's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { strings } from './strings'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
}))

import HoursShell from './components/HoursShell'
import { createAppRouter } from './router'

const renderAt = (path: string) => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', HoursShell, history)} />)
}

afterEach(() => cleanup())

describe('createAppRouter', () => {
  it('serves My hours at the tool root, inside the "Hours" frame', async () => {
    renderAt('/hours')
    expect(await screen.findByTestId('hours-my-page')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.common.title)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(strings.myHours.heading)
  })

  it('serves Everyone’s hours at /all', async () => {
    renderAt('/hours/all')
    expect(await screen.findByTestId('hours-everyone-page')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(strings.everyone.heading)
    expect(screen.queryByTestId('hours-my-page')).toBeNull()
  })

  it('answers an unknown path with the not-found panel, focused, and a way back to My hours', async () => {
    renderAt('/hours/nope')
    const panel = await screen.findByTestId('hours-not-found')
    expect(panel.getAttribute('role')).toBe('alert')
    const heading = screen.getByRole('heading', { name: strings.common.notFound.heading })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByRole('link', { name: strings.common.notFound.back }).getAttribute('href')).toBe('/hours/')
    // The frame stays: the tool title is still there.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.common.title)
  })

  it('does not take a path deeper than the two screens for one of them', async () => {
    renderAt('/hours/all/extra')
    expect(await screen.findByTestId('hours-not-found')).not.toBeNull()
    expect(screen.queryByTestId('hours-everyone-page')).toBeNull()
  })

  it('without a root layout it renders a page under a bare outlet (the seam tests use)', async () => {
    const history = createMemoryHistory({ initialEntries: ['/hours'] })
    render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
    expect(await screen.findByTestId('hours-my-page')).not.toBeNull()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })
})
