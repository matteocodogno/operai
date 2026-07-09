/**
 * useTheme — shell-owned theme (system/light/dark) state + persistence.
 *
 * Relocated from estimai-ui/src/hooks/useTheme.ts (T6, specs/003-suite-shell, AC-1.4).
 *
 * The storage key MUST stay in sync with shell/index.html's pre-mount
 * theme-flash-avoidance inline script (T1), which reads `operai-theme` from
 * localStorage before React mounts to apply `data-theme` synchronously and avoid a
 * flash of the wrong theme.
 */
import { useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'operai-theme'

function readStored(): Theme {
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'light' || v === 'dark') return v
  return 'system'
}

function apply(theme: Theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')
    localStorage.removeItem(STORAGE_KEY)
  } else {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStored)

  function setTheme(t: Theme) {
    setThemeState(t)
    apply(t)
  }

  return { theme, setTheme }
}

export const THEME_CYCLE: Theme[] = ['system', 'light', 'dark']
export const THEME_ICON: Record<Theme, string> = { system: '◑', light: '☀', dark: '☾' }
export const THEME_LABEL: Record<Theme, string> = {
  system: 'System theme (auto)',
  light: 'Light theme',
  dark: 'Dark theme',
}
