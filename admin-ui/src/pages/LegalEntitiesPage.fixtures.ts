/**
 * Test support of the Legal entities page (T36): entity answers and a router harness around the real route
 * definition (`validateLegalEntitiesSearch`), without the shell. A `.ts` file on purpose: it is not a component.
 */
import { createElement, Fragment } from 'react'
import type { ElementType } from 'react'
import { render } from '@testing-library/react'
import {
  Link,
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import LegalEntitiesPage from './LegalEntitiesPage'
import { validateLegalEntitiesSearch } from '../router'
import type { LegalEntity, LegalEntityId } from '../lib/legalEntityModel'

const NAMES: Record<LegalEntityId, string> = { welld_it: 'wellD S.r.l.', welld_ch: 'wellD AG' }

/** A complete entity at version 3. Override what a test is about. */
export const entityFixture = (entity: LegalEntityId, overrides: Partial<LegalEntity> = {}): LegalEntity => ({
  entity,
  version: 3,
  updatedAt: '2026-11-12T16:40:00.000Z',
  legalName: NAMES[entity],
  address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: ['Via Esempio 12', '6900 Lugano', 'Italy'] },
  vatNumber: 'IT 00000000000',
  iban: 'IT60X0542811101000000123456',
  ibanPrint: 'IT60 X054 2811 1010 0000 0123 456',
  contacts: { it: 'Tel. +39 02 0000 0000', en: '' },
  complete: true,
  missing: [],
  invalid: [],
  ...overrides,
})

/** Not moved yet: version 0, every value empty. */
export const notMoved = (entity: LegalEntityId): LegalEntity =>
  entityFixture(entity, {
    version: 0,
    updatedAt: null,
    legalName: '',
    address: { it: [], en: [] },
    vatNumber: '',
    iban: '',
    ibanPrint: '',
    contacts: { it: '', en: '' },
    complete: false,
    missing: ['legalName', 'address.it', 'address.en', 'vatNumber'],
  })

const browserHistoryAt = (path: string) => {
  window.history.pushState(null, '', path)
  return createBrowserHistory()
}

/** The page under a router with a second route to leave to. `to-roles` is a link, `router.history` the memory history. */
export function renderPage(initialPath: string, options: { browserHistory?: boolean } = {}) {
  const rootRoute = createRootRoute({
    component: () =>
      createElement(
        Fragment,
        null,
        createElement(Link as ElementType, { to: '/roles', 'data-testid': 'to-roles' }, 'Roles'),
        createElement(Outlet),
      ),
  })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/legal-entities',
    validateSearch: validateLegalEntitiesSearch,
    component: LegalEntitiesPage,
  })
  const rolesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/roles',
    component: () => createElement('p', { 'data-testid': 'roles-page' }, 'Roles page'),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, rolesRoute]),
    // `beforeunload` is only wired by the browser history (the memory one has no page to unload).
    history: options.browserHistory ? browserHistoryAt(initialPath) : createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const view = render(createElement(RouterProvider, { router }))
  return { router, ...view }
}
