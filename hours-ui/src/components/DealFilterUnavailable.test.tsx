/**
 * @vitest-environment jsdom
 *
 * DealFilterUnavailable — the one banner that replaces Totals and Entries while Meetings cannot say which
 * meetings belong to the filtered deal (specs/029-time-tracking T25; AC-4.11; design S1 "Deal filter
 * unavailable"). An alert announced where it appears; it never takes focus by itself (the person is in the
 * Filters card); its Retry and "Clear the deal filter" are real buttons; and it can be focused (`ref`,
 * `tabIndex={-1}`) by the page after a retry that failed, because the Retry button that had focus is gone.
 */
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strings } from '../strings'
import DealFilterUnavailable from './DealFilterUnavailable'

afterEach(() => cleanup())

const t = strings.entries.dealFilterUnavailable

describe('DealFilterUnavailable (AC-4.11)', () => {
  it('is an alert titled "Hours on this deal can\'t be shown right now" that says nothing is shown until it can be', () => {
    render(<DealFilterUnavailable onRetry={vi.fn()} onClear={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(t.title)
    expect(alert.textContent).toContain(t.body)
    expect(t.title).toBe("Hours on this deal can't be shown right now")
    expect(t.body).toMatch(/Nothing is shown until it can/)
    expect(t.body).toMatch(/Try again in a moment/)
  })

  it('offers Retry and "Clear the deal filter" as buttons with visible text', async () => {
    const onRetry = vi.fn()
    const onClear = vi.fn()
    render(<DealFilterUnavailable onRetry={onRetry} onClear={onClear} />)

    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: t.clear }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(t.clear).toBe('Clear the deal filter')
  })

  it('does not take focus when it appears', () => {
    render(<DealFilterUnavailable onRetry={vi.fn()} onClear={vi.fn()} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('can be focused by the page: it is the alert itself, reachable by `ref` but not a tab stop', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DealFilterUnavailable ref={ref} onRetry={vi.fn()} onClear={vi.fn()} />)

    expect(ref.current).toBe(screen.getByRole('alert'))
    expect(ref.current!.getAttribute('tabindex')).toBe('-1')
    ref.current!.focus()
    expect(document.activeElement).toBe(screen.getByRole('alert'))
  })
})
