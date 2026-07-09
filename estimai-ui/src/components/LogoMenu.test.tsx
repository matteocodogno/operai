/**
 * @vitest-environment jsdom
 *
 * Tests for LogoMenu — the header logo as a dropdown whose "About" item opens
 * the About dialog (via the onAbout callback).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import LogoMenu from './LogoMenu'

afterEach(() => cleanup())

describe('LogoMenu', () => {
  it('shows no menu until the logo is clicked', () => {
    render(<LogoMenu onAbout={() => {}} />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: /menu/i })).toBeDefined()
  })

  it('opens a menu with an About item when the logo is clicked', () => {
    render(<LogoMenu onAbout={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /menu/i }))
    expect(screen.getByRole('menu')).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /about/i })).toBeDefined()
  })

  it('calls onAbout and closes the menu when About is clicked', () => {
    const onAbout = vi.fn()
    render(<LogoMenu onAbout={onAbout} />)
    fireEvent.click(screen.getByRole('button', { name: /menu/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /about/i }))
    expect(onAbout).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the menu on Escape', () => {
    render(<LogoMenu onAbout={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /menu/i }))
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
