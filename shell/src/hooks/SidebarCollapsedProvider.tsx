/**
 * SidebarCollapsedProvider — provides the shared sidebar-collapse state
 * (see sidebarCollapsed.ts for the context + `useSidebarCollapsed` reader).
 *
 * Kept in its own file so it is the module's ONLY export (a component),
 * satisfying `react-refresh/only-export-components`. Rendered once by
 * ShellLayout around the rail + content; the Sidebar's toggle (a descendant)
 * and ShellLayout's rail-width both read the state via `useSidebarCollapsed`.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { SIDEBAR_COLLAPSED_STORAGE_KEY, SidebarCollapsedContext, readStoredCollapsed } from './sidebarCollapsed'

export function SidebarCollapsedProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readStoredCollapsed)

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next))
      } catch {
        // Storage unavailable (privacy mode, disabled storage) — non-fatal;
        // the choice just won't persist across reloads.
      }
      return next
    })
  }, [])

  return <SidebarCollapsedContext.Provider value={{ collapsed, toggle }}>{children}</SidebarCollapsedContext.Provider>
}
