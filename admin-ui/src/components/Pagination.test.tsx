/**
 * @vitest-environment jsdom
 *
 * Component tests for Pagination (T15, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Previous/Next are real <button>s.
 *   (B) at the first page, Previous is aria-disabled and clicking it is a
 *       no-op (onPageChange not called).
 *   (C) at the last page, Next is aria-disabled and clicking it is a no-op.
 *   (D) mid-range: neither button is aria-disabled, and clicking each calls
 *       onPageChange with the correct page.
 *   (E) the aria-live status region announces "Page N of M — Showing X–Y of N".
 *   (F) zero-total edge case renders without crashing and both buttons disabled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Pagination from './Pagination'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Pagination', () => {
  it('renders Previous/Next as real buttons', () => {
    render(<Pagination page={2} pageSize={20} total={63} onPageChange={vi.fn()} />)

    const prev = screen.getByTestId('pagination-previous')
    const next = screen.getByTestId('pagination-next')
    expect(prev.tagName).toBe('BUTTON')
    expect(next.tagName).toBe('BUTTON')
  })

  it('disables Previous (aria-disabled) at the first page and clicking it does nothing', () => {
    const onPageChange = vi.fn()
    render(<Pagination page={1} pageSize={20} total={63} onPageChange={onPageChange} />)

    const prev = screen.getByTestId('pagination-previous')
    expect(prev.getAttribute('aria-disabled')).toBe('true')
    // Not a native disabled attribute — stays focusable/perceivable.
    expect(prev.hasAttribute('disabled')).toBe(false)

    fireEvent.click(prev)
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('disables Next (aria-disabled) at the last page and clicking it does nothing', () => {
    const onPageChange = vi.fn()
    // 63 items, pageSize 20 → 4 pages (21–40, 41-60, 61-63 ... actually ceil(63/20)=4)
    render(<Pagination page={4} pageSize={20} total={63} onPageChange={onPageChange} />)

    const next = screen.getByTestId('pagination-next')
    expect(next.getAttribute('aria-disabled')).toBe('true')
    expect(next.hasAttribute('disabled')).toBe(false)

    fireEvent.click(next)
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('mid-range: neither button is disabled and both call onPageChange with the right page', () => {
    const onPageChange = vi.fn()
    render(<Pagination page={2} pageSize={20} total={63} onPageChange={onPageChange} />)

    const prev = screen.getByTestId('pagination-previous')
    const next = screen.getByTestId('pagination-next')
    expect(prev.getAttribute('aria-disabled')).toBe('false')
    expect(next.getAttribute('aria-disabled')).toBe('false')

    fireEvent.click(prev)
    expect(onPageChange).toHaveBeenLastCalledWith(1)

    fireEvent.click(next)
    expect(onPageChange).toHaveBeenLastCalledWith(3)
  })

  it('announces "Page N of M — Showing X–Y of N" in an aria-live region', () => {
    render(<Pagination page={2} pageSize={20} total={63} onPageChange={vi.fn()} />)

    const status = screen.getByTestId('pagination-status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('Page 2 of 4 — Showing 21–40 of 63')
  })

  it('the last (partial) page shows the correct truncated range', () => {
    render(<Pagination page={4} pageSize={20} total={63} onPageChange={vi.fn()} />)

    expect(screen.getByTestId('pagination-status').textContent).toBe('Page 4 of 4 — Showing 61–63 of 63')
  })

  it('handles a zero-total list without crashing, both buttons disabled', () => {
    render(<Pagination page={1} pageSize={20} total={0} onPageChange={vi.fn()} />)

    expect(screen.getByTestId('pagination-previous').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('pagination-next').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('pagination-status').textContent).toBe('Page 1 of 1 — Showing 0 of 0')
  })
})
