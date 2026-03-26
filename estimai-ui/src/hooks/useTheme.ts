import { useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'estimai-theme'

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
  light:  'Light theme',
  dark:   'Dark theme',
}
