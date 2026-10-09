/**
 * @vitest-environment jsdom
 *
 * Component tests for LoadMore (T26, specs/015-hardware-inventory; design.md
 * § NEW components "LoadMore" and § Accessibility T1 list: "Load more keeps
 * focus on its button and announces '{n} more assets loaded'; when the last
 * page loads the button is removed").
 *
 * The API is cursor-only (`nextCursor`), so this is a button, not a pager.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LoadMore from './LoadMore'
import type { LoadMoreProps } from './LoadMore'

afterEach(() => {
  cleanup()
})

const renderLoadMore = (props: Partial<LoadMoreProps> = {}) =>
  render(
    <LoadMore
      hasMore={true}
      isLoading={false}
      onLoadMore={vi.fn()}
      label="Load more"
      loadingLabel="Loading more…"
      {...props}
    />,
  )

describe('LoadMore', () => {
  it('renders a real button with the given label and calls onLoadMore when clicked', () => {
    const onLoadMore = vi.fn()
    renderLoadMore({ onLoadMore })

    const button = screen.getByRole('button', { name: 'Load more' })
    expect(button.tagName).toBe('BUTTON')
    fireEvent.click(button)

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('removes the button when there is no further page', () => {
    renderLoadMore({ hasMore: false })

    expect(screen.queryByRole('button')).toBeNull()
  })

  describe('while a page is loading', () => {
    it('swaps the label, is aria-busy, and ignores clicks', () => {
      const onLoadMore = vi.fn()
      renderLoadMore({ isLoading: true, onLoadMore })

      const button = screen.getByRole('button', { name: 'Loading more…' })
      expect(button.getAttribute('aria-busy')).toBe('true')
      fireEvent.click(button)

      expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('keeps focus on the button: it is aria-disabled, not disabled, so the browser does not drop focus', () => {
      const { rerender } = renderLoadMore()
      const button = screen.getByRole('button')
      button.focus()

      rerender(
        <LoadMore hasMore={true} isLoading={true} onLoadMore={vi.fn()} label="Load more" loadingLabel="Loading more…" />,
      )

      const busy = screen.getByRole('button')
      expect(busy).toBe(button)
      expect(busy.hasAttribute('disabled')).toBe(false)
      expect(busy.getAttribute('aria-disabled')).toBe('true')
      expect(document.activeElement).toBe(busy)
    })
  })

  it('is not aria-busy or aria-disabled when idle', () => {
    renderLoadMore()

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(button.getAttribute('aria-disabled')).toBeNull()
  })

  describe('announcement', () => {
    it('renders the caller-supplied text in a polite status region', () => {
      renderLoadMore({ announcement: '25 more assets loaded' })

      const status = screen.getByRole('status')
      expect(status.textContent).toBe('25 more assets loaded')
      expect(status.className).toContain('sr-only')
    })

    it('keeps the status region mounted after the button is removed, so the last announcement is still read', () => {
      const { rerender } = renderLoadMore({ announcement: '' })
      rerender(
        <LoadMore
          hasMore={false}
          isLoading={false}
          onLoadMore={vi.fn()}
          label="Load more"
          loadingLabel="Loading more…"
          announcement="3 more assets loaded"
        />,
      )

      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getByRole('status').textContent).toBe('3 more assets loaded')
    })
  })

  it('shows a failed load as an alert next to the button, which stays usable as the retry', () => {
    const onLoadMore = vi.fn()
    renderLoadMore({ errorMessage: 'Could not load more assets.', onLoadMore })

    expect(screen.getByRole('alert').textContent).toBe('Could not load more assets.')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('renders no alert when there is no error', () => {
    renderLoadMore()

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
