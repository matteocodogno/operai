/**
 * @vitest-environment jsdom
 *
 * DealFilterUnavailable — the one banner that replaces Totals and Entries while Meetings cannot say which
 * meetings belong to the filtered deal (specs/20261112-time-tracking T25; AC-4.11; design S1 "Deal filter
 * unavailable") or to the filtered project (specs/20261112-project-hours T12; AC-4.8; design S4: the same banner,
 * `kind: 'deal' | 'project'` picks the words and the test ids). An alert announced where it appears; it never takes
 * focus by itself (the person is in the Filters card); its Retry and "Clear the … filter" are real buttons; and it
 * can be focused (`ref`, `tabIndex={-1}`) by the page after a retry that failed, because the Retry button that had
 * focus is gone.
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
    render(<DealFilterUnavailable kind="deal" onRetry={vi.fn()} onClear={vi.fn()} />)

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
    render(<DealFilterUnavailable kind="deal" onRetry={onRetry} onClear={onClear} />)

    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: t.clear }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(t.clear).toBe('Clear the deal filter')
  })

  it('does not take focus when it appears', () => {
    render(<DealFilterUnavailable kind="deal" onRetry={vi.fn()} onClear={vi.fn()} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('can be focused by the page: it is the alert itself, reachable by `ref` but not a tab stop', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DealFilterUnavailable kind="deal" ref={ref} onRetry={vi.fn()} onClear={vi.fn()} />)

    expect(ref.current).toBe(screen.getByRole('alert'))
    expect(ref.current!.getAttribute('tabindex')).toBe('-1')
    ref.current!.focus()
    expect(document.activeElement).toBe(screen.getByRole('alert'))
  })
})

const p = strings.entries.projectFilterUnavailable

describe('the same banner for a project filter (AC-4.8)', () => {
  it('is an alert titled "Hours on this project can\'t be shown right now" that says nothing is shown until it can be', () => {
    render(<DealFilterUnavailable kind="project" onRetry={vi.fn()} onClear={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(p.title)
    expect(alert.textContent).toContain(p.body)
    expect(p.title).toBe("Hours on this project can't be shown right now")
    expect(p.body).toBe(
      'Operai could not check which meetings belong to this project, so a list or total would be incomplete. Nothing is shown until it can. Try again in a moment.',
    )
    expect(alert.textContent).not.toMatch(/deal/i)
  })

  it('offers Retry and "Clear the project filter" as buttons, and calls the page for each', async () => {
    const onRetry = vi.fn()
    const onClear = vi.fn()
    render(<DealFilterUnavailable kind="project" onRetry={onRetry} onClear={onClear} />)

    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: p.clear }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(p.clear).toBe('Clear the project filter')
  })

  it('has its own test ids, and the deal’s keep theirs', () => {
    const { unmount } = render(<DealFilterUnavailable kind="project" onRetry={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByTestId('hours-project-filter-unavailable')).not.toBeNull()
    expect(screen.getByTestId('hours-project-filter-unavailable-retry')).not.toBeNull()
    expect(screen.getByTestId('hours-project-filter-unavailable-clear')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    unmount()

    render(<DealFilterUnavailable kind="deal" onRetry={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByTestId('hours-deal-filter-unavailable')).not.toBeNull()
    expect(screen.getByTestId('hours-deal-filter-unavailable-retry')).not.toBeNull()
    expect(screen.getByTestId('hours-deal-filter-unavailable-clear')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
  })

  it('does not take focus when it appears, and can be focused by the page through `ref`', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DealFilterUnavailable kind="project" ref={ref} onRetry={vi.fn()} onClear={vi.fn()} />)

    expect(document.activeElement).toBe(document.body)
    expect(ref.current).toBe(screen.getByRole('alert'))
    expect(ref.current!.getAttribute('tabindex')).toBe('-1')
    ref.current!.focus()
    expect(document.activeElement).toBe(screen.getByRole('alert'))
  })
})
