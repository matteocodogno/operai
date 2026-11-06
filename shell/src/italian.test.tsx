/**
 * @vitest-environment jsdom
 *
 * INC-25 — the shell's chrome renders in Italian when <html lang> says so.
 * The language is selected when the strings module is evaluated, so it is set
 * in a hoisted block, before any import below runs (as main.tsx does through
 * ./locale). Every other test file runs with the default English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  document.documentElement.setAttribute('lang', 'it')
})

vi.mock('./lib/profileApi', () => ({ getMyAddress: vi.fn() }))

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import UserMenu from './components/UserMenu'
import { AccountScreen } from './components/AccountScreen'
import { NoAccessScreen } from './components/NoAccessScreen'
import { TOOLS } from './lib/tools'
import { getMyAddress } from './lib/profileApi'

afterEach(() => cleanup())

async function renderUserMenu() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <UserMenu user={{ name: 'Alice Welld', email: null, image: null }} onSignOut={() => {}} />
        <Outlet />
      </>
    ),
  })
  const routes = ['/', '/account', '/devices'].map((path) => createRoute({ getParentRoute: () => rootRoute, path }))
  const router = createRouter({ routeTree: rootRoute.addChildren(routes) })
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Alice Welld' }))
}

describe('shell chrome in Italian', () => {
  it('labels the user menu in Italian (moved from UserMenu.test.tsx: the menu no longer reads navigator.language itself)', async () => {
    await renderUserMenu()

    expect(screen.getByRole('menuitem', { name: 'Il mio profilo' }).getAttribute('href')).toBe('/account')
    expect(screen.getByRole('menuitem', { name: 'I miei dispositivi' }).getAttribute('href')).toBe('/devices')
    expect(screen.getByRole('menuitem', { name: 'Esci' })).not.toBeNull()
  })

  it('renders /account in Italian', async () => {
    vi.mocked(getMyAddress).mockResolvedValue(null)
    render(<AccountScreen />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Il mio profilo')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Indirizzo di residenza')
    expect(await screen.findByText('Nessun indirizzo registrato')).not.toBeNull()
  })

  it('renders /no-access and the tool names in Italian', () => {
    render(<NoAccessScreen />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nessuno strumento disponibile')
    expect(TOOLS.map((tool) => tool.label)).toEqual(['EstimAI', 'Rimborsi', 'Amministrazione', 'Inventario', 'CRM', 'Progetti'])
  })
})
