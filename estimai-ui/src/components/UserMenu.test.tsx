/**
 * @vitest-environment jsdom
 *
 * Component tests for UserMenu (T8, specs/002, AC-5.1).
 *
 * The user menu is an avatar button that opens a dropdown. The avatar is always
 * visible; the full name/email and the sign-out control live inside the menu.
 *
 * Asserts:
 *   (a) the avatar (image or initial fallback) renders without opening the menu.
 *   (b) clicking the avatar opens a menu showing the user's name (and email).
 *   (c) the name is NOT visible until the menu is opened.
 *   (d) the sign-out item inside the menu calls onSignOut.
 *   (e) the menu closes on Escape.
 *
 * Uses @testing-library/react for render + fireEvent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import UserMenu from './UserMenu'

afterEach(() => {
  cleanup()
})

const openMenu = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('UserMenu', () => {
  describe('(a) avatar renders without opening the menu', () => {
    it('renders the avatar image when an image URL is provided', () => {
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: null, image: 'https://example.com/avatar.png' }}
          onSignOut={() => {}}
        />,
      )
      const img = screen.getByRole('img', { name: 'Alice Welld' }) as HTMLImageElement
      expect(img.src).toBe('https://example.com/avatar.png')
    })

    it('shows an initial-letter fallback when no image is provided', () => {
      render(
        <UserMenu user={{ name: 'Bob Builder', email: null, image: null }} onSignOut={() => {}} />,
      )
      const fallback = screen.getByLabelText('Bob Builder')
      expect(fallback.tagName.toLowerCase()).toBe('span')
      expect(fallback.textContent).toBe('B')
    })
  })

  describe('(b) opening the menu reveals the name/email', () => {
    it('shows the name after the avatar is clicked', () => {
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: 'alice@welld.ch', image: null }}
          onSignOut={() => {}}
        />,
      )
      openMenu('Alice Welld')
      const menu = screen.getByRole('menu')
      expect(menu.textContent).toContain('Alice Welld')
      expect(menu.textContent).toContain('alice@welld.ch')
    })

    it('falls back to email as the name when user.name is null', () => {
      render(
        <UserMenu user={{ name: null, email: 'alice@welld.ch', image: null }} onSignOut={() => {}} />,
      )
      openMenu('alice@welld.ch')
      expect(screen.getByRole('menu').textContent).toContain('alice@welld.ch')
    })

    it('falls back to "Account" when both name and email are null', () => {
      render(<UserMenu user={{ name: null, email: null, image: null }} onSignOut={() => {}} />)
      openMenu('Account')
      expect(screen.getByRole('menu').textContent).toContain('Account')
    })
  })

  describe('(c) the menu is closed by default', () => {
    it('does not render a menu until the avatar is clicked', () => {
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: 'alice@welld.ch', image: null }}
          onSignOut={() => {}}
        />,
      )
      expect(screen.queryByRole('menu')).toBeNull()
      // The name is not present anywhere until opened.
      expect(screen.queryByText('alice@welld.ch')).toBeNull()
    })
  })

  describe('(d) sign-out lives inside the menu and calls onSignOut', () => {
    it('invokes onSignOut exactly once when the sign-out item is clicked', () => {
      const onSignOut = vi.fn()
      render(
        <UserMenu user={{ name: 'Alice Welld', email: null, image: null }} onSignOut={onSignOut} />,
      )
      // Not present before opening.
      expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()

      openMenu('Alice Welld')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
      expect(onSignOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('(e) the menu closes on Escape', () => {
    it('hides the menu when Escape is pressed', () => {
      render(
        <UserMenu user={{ name: 'Alice Welld', email: null, image: null }} onSignOut={() => {}} />,
      )
      openMenu('Alice Welld')
      expect(screen.getByRole('menu')).toBeDefined()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
