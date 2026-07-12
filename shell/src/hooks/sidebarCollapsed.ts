/**
 * sidebarCollapsed — shared collapse state for the shell's tool-navigation rail
 * (the context + reader hook; the Provider lives in SidebarCollapsedProvider.tsx).
 *
 * The rail (Sidebar.tsx) collapses to an icons-only width via a toggle in its
 * always-visible bottom section; ShellLayout reads the SAME state to size the
 * rail (`w-56` ↔ `w-16`). One source of truth (this context) keeps the width
 * and the item rendering in lockstep on toggle — not two independent `useState`.
 *
 * Split from the Provider so this module exports no component and the Provider
 * module exports only a component — satisfying `react-refresh/only-export-components`
 * (same convention as Header.tsx vs router.tsx). Persistence key mirrors
 * useTheme's `operai-theme` localStorage pattern.
 */
import { createContext, useContext } from 'react'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'operai_sidebar_collapsed'

/** Reads the persisted collapse choice; false (expanded) when unset/unavailable. */
export function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export interface SidebarCollapsedValue {
  collapsed: boolean
  toggle: () => void
}

const NON_COLLAPSED_DEFAULT: SidebarCollapsedValue = { collapsed: false, toggle: () => {} }

export const SidebarCollapsedContext = createContext<SidebarCollapsedValue | null>(null)

/**
 * Reads the shared sidebar-collapse state. Without a provider (isolated
 * component tests) returns a non-collapsed, no-op default rather than throwing.
 */
export function useSidebarCollapsed(): SidebarCollapsedValue {
  return useContext(SidebarCollapsedContext) ?? NON_COLLAPSED_DEFAULT
}
