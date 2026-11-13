/**
 * @vitest-environment jsdom
 *
 * HoursShell: the "Hours" frame, and the tabs that exist only for a holder of `time-entry:read-all`
 * (design § Frame of hours-ui; AC-5.1: the screens are ungated, the tab is a UX convenience and the
 * server is the gate, ADR-0075).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { strings } from '../strings'

type Permissions = {
  epoch: number
  apps: string[]
  roles: string[]
  departments: string[]
  permissions: { resource: string; action: string }[]
}

// The shell's permissions, as an external store, so a test can let them "arrive" while mounted.
const { permissionsStore } = vi.hoisted(() => {
  let value = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] } as Permissions
  const listeners = new Set<() => void>()
  return {
    permissionsStore: {
      get: () => value,
      set: (next: Permissions) => {
        value = next
        listeners.forEach((listener) => listener())
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
})
vi.mock('shell/session', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    apiFetch: vi.fn(),
    getHoursApiBaseUrl: () => 'http://hours-api.test',
    usePermissions: () => useSyncExternalStore(permissionsStore.subscribe, permissionsStore.get),
  }
})

import { createAppRouter } from '../router'
import HoursShell from './HoursShell'

const NOT_RESOLVED: Permissions = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] }
const EMPLOYEE: Permissions = {
  epoch: 2,
  apps: ['meetings'],
  roles: ['employee'],
  departments: [],
  permissions: [{ resource: 'meetings', action: 'access' }],
}
const HOLDER: Permissions = {
  epoch: 5,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions: [
    { resource: 'meetings', action: 'access' },
    { resource: 'time-entry', action: 'read-all' },
  ],
}

const renderAt = (path: string, permissions: Permissions) => {
  permissionsStore.set(permissions)
  const history = createMemoryHistory({ initialEntries: [path] })
  return render(<RouterProvider router={createAppRouter('/hours', HoursShell, history)} />)
}

const tabs = () => screen.queryByRole('navigation', { name: strings.common.nav.landmarkLabel })

afterEach(() => {
  cleanup()
  permissionsStore.set(NOT_RESOLVED)
})

describe('HoursShell', () => {
  it('is the tool frame: the tool title as the page’s one h1, then the routed page', async () => {
    renderAt('/hours', EMPLOYEE)
    await screen.findByTestId('hours-my-page')
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    expect(h1[0]!.textContent).toBe('Hours')
    expect(screen.getByTestId('hours-shell')).not.toBeNull()
  })

  it('draws no <main> of its own: the shell owns the page’s one landmark', async () => {
    renderAt('/hours', EMPLOYEE)
    await screen.findByTestId('hours-my-page')
    expect(screen.queryByRole('main')).toBeNull()
  })
})

describe('the tabs (AC-5.1, ADR-0075)', () => {
  it('are out of the DOM while permissions have not resolved', async () => {
    renderAt('/hours', NOT_RESOLVED)
    await screen.findByTestId('hours-my-page')
    expect(tabs()).toBeNull()
    expect(screen.queryByRole('link', { name: strings.common.nav.everyone })).toBeNull()
  })

  it('are out of the DOM for a person who is not a holder: one tab is noise', async () => {
    renderAt('/hours', EMPLOYEE)
    await screen.findByTestId('hours-my-page')
    expect(tabs()).toBeNull()
    expect(screen.queryByRole('link', { name: strings.common.nav.myHours })).toBeNull()
    expect(screen.queryByRole('link', { name: strings.common.nav.everyone })).toBeNull()
  })

  it('show My hours and Everyone’s hours for a holder of time-entry:read-all', async () => {
    renderAt('/hours', HOLDER)
    await screen.findByTestId('hours-my-page')
    const nav = tabs()
    expect(nav).not.toBeNull()
    const links = screen.getAllByRole('link').filter((link) => nav!.contains(link))
    expect(links.map((link) => link.textContent)).toEqual([strings.common.nav.myHours, strings.common.nav.everyone])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/hours/', '/hours/all'])
  })

  it('mark the current one, and only that one, with aria-current', async () => {
    renderAt('/hours', HOLDER)
    await screen.findByTestId('hours-my-page')
    expect(screen.getByRole('link', { name: strings.common.nav.myHours }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: strings.common.nav.everyone }).getAttribute('aria-current')).toBeNull()
  })

  it('follow the page: on /all the second tab is the current one, and My hours is not', async () => {
    renderAt('/hours/all', HOLDER)
    await screen.findByTestId('hours-everyone-page')
    expect(screen.getByRole('link', { name: strings.common.nav.everyone }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: strings.common.nav.myHours }).getAttribute('aria-current')).toBeNull()
  })

  it('appear once the permissions arrive, without the page being remounted', async () => {
    renderAt('/hours', NOT_RESOLVED)
    const page = await screen.findByTestId('hours-my-page')
    expect(tabs()).toBeNull()

    act(() => permissionsStore.set(HOLDER))

    expect(tabs()).not.toBeNull()
    expect(screen.getByTestId('hours-my-page')).toBe(page)
  })

  it('go again when a grant is withdrawn while the page is open', async () => {
    renderAt('/hours', HOLDER)
    await screen.findByTestId('hours-my-page')
    expect(tabs()).not.toBeNull()

    act(() => permissionsStore.set(EMPLOYEE))

    expect(tabs()).toBeNull()
  })
})
