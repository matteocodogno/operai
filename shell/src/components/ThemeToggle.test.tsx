/**
 * @vitest-environment jsdom
 *
 * Component tests for ThemeToggle (T6, specs/003-suite-shell, AC-1.4).
 *
 * Covers the cycle system → light → dark → system, the aria-label/title reflecting
 * the current theme (THEME_LABEL), persistence to localStorage under the
 * `operai-theme` key (matching shell/index.html's pre-mount script, T1), and reading
 * a previously-stored theme on mount.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ThemeToggle from './ThemeToggle'
import { THEME_LABEL } from '../hooks/useTheme'

const STORAGE_KEY = 'operai-theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('ThemeToggle', () => {
  it('starts in system theme when nothing is stored', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: THEME_LABEL.system })).toBeDefined()
  })

  it('cycles system -> light -> dark -> system on repeated clicks, persisting to localStorage', () => {
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: THEME_LABEL.system }))
    expect(screen.getByRole('button', { name: THEME_LABEL.light })).toBeDefined()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: THEME_LABEL.light }))
    expect(screen.getByRole('button', { name: THEME_LABEL.dark })).toBeDefined()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: THEME_LABEL.dark }))
    expect(screen.getByRole('button', { name: THEME_LABEL.system })).toBeDefined()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('reads a previously stored theme on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: THEME_LABEL.dark })).toBeDefined()
  })
})
