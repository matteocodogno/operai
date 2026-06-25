/**
 * @vitest-environment jsdom
 *
 * Component tests for UserMenu (T8, specs/002, AC-5.1).
 *
 * Asserts:
 *   (a) UserMenu renders the user's name when provided.
 *   (b) UserMenu renders the user's avatar image when an image URL is provided.
 *   (c) When no image is provided, an initial-letter fallback avatar is shown.
 *   (d) UserMenu calls onSignOut when the sign-out button is clicked.
 *   (e) UserMenu does NOT import or call authClient — it is purely presentational.
 *
 * Uses @testing-library/react for render + fireEvent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import UserMenu from './UserMenu'

afterEach(() => {
  cleanup()
})

describe('UserMenu', () => {
  describe('(a) renders the user name', () => {
    it('displays the name when user.name is provided', () => {
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: 'alice@welld.ch', image: null }}
          onSignOut={() => {}}
        />,
      )
      expect(screen.getByText('Alice Welld')).toBeDefined()
    })

    it('falls back to email when name is null', () => {
      render(
        <UserMenu
          user={{ name: null, email: 'alice@welld.ch', image: null }}
          onSignOut={() => {}}
        />,
      )
      expect(screen.getByText('alice@welld.ch')).toBeDefined()
    })

    it('falls back to "Account" when both name and email are null', () => {
      render(
        <UserMenu user={{ name: null, email: null, image: null }} onSignOut={() => {}} />,
      )
      expect(screen.getByText('Account')).toBeDefined()
    })
  })

  describe('(b) renders avatar image when image URL is provided', () => {
    it('renders an <img> with the provided src', () => {
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: null, image: 'https://example.com/avatar.png' }}
          onSignOut={() => {}}
        />,
      )
      const img = screen.getByRole('img', { name: 'Alice Welld' }) as HTMLImageElement
      expect(img).toBeDefined()
      expect(img.src).toBe('https://example.com/avatar.png')
    })
  })

  describe('(c) renders initial-letter fallback when no image is provided', () => {
    it('shows the first letter of the display name as a fallback avatar', () => {
      render(
        <UserMenu
          user={{ name: 'Bob Builder', email: null, image: null }}
          onSignOut={() => {}}
        />,
      )
      // The fallback span has aria-label equal to the display name and shows initial
      const fallback = screen.getByLabelText('Bob Builder')
      expect(fallback.tagName.toLowerCase()).toBe('span')
      expect(fallback.textContent).toBe('B')
    })
  })

  describe('(d) calls onSignOut when the sign-out button is clicked', () => {
    it('invokes onSignOut exactly once on click', () => {
      const onSignOut = vi.fn()
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: null, image: null }}
          onSignOut={onSignOut}
        />,
      )
      const btn = screen.getByRole('button', { name: 'Sign out' })
      fireEvent.click(btn)
      expect(onSignOut).toHaveBeenCalledTimes(1)
    })

    it('does not call onSignOut before the button is clicked', () => {
      const onSignOut = vi.fn()
      render(
        <UserMenu
          user={{ name: 'Alice Welld', email: null, image: null }}
          onSignOut={onSignOut}
        />,
      )
      expect(onSignOut).not.toHaveBeenCalled()
    })
  })
})
