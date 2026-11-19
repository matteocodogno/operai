/**
 * Test wrapper for a component that renders a router `<Link>` — since specs/20261110-activities AC-7.6 a
 * task's deal is one — without mounting the app's routes: the router context alone, on a memory history.
 * Use it as Testing Library's `wrapper` (`render(ui, { wrapper: RouterWrapper })`).
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'

export function RouterWrapper({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }) }),
  )
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>
}
