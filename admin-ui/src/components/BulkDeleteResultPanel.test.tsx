/**
 * @vitest-environment jsdom
 *
 * Component tests for BulkDeleteResultPanel (T11, specs/006-user-invitations,
 * design.md Panel N3).
 *
 * Covers:
 *   (A) role="status" (persistent, not a toast) with the one-line summary.
 *   (B) One <li> per skipped user, its label + the server's own reason
 *       verbatim, in a real <ul> (AC-6.3).
 *   (C) No <ul> at all when nothing was skipped (full success).
 *   (D) Dismiss "×" calls onDismiss — the only way this panel disappears.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BulkDeleteResultPanel from './BulkDeleteResultPanel'

afterEach(() => {
  cleanup()
})

describe('BulkDeleteResultPanel', () => {
  it('renders role="status" with the deleted/total summary', () => {
    render(
      <BulkDeleteResultPanel deletedCount={2} totalCount={3} skipped={[]} onDismiss={vi.fn()} />,
    )

    const panel = screen.getByTestId('bulk-delete-result-panel')
    expect(panel.getAttribute('role')).toBe('status')
    expect(screen.getByTestId('bulk-delete-result-summary').textContent).toBe(
      'Deleted 2 of 3 selected users.',
    )
  })

  it('uses singular "user" wording when totalCount is 1', () => {
    render(<BulkDeleteResultPanel deletedCount={1} totalCount={1} skipped={[]} onDismiss={vi.fn()} />)

    expect(screen.getByTestId('bulk-delete-result-summary').textContent).toBe(
      'Deleted 1 of 1 selected user.',
    )
  })

  it('renders one <li> per skipped user with its label + verbatim server reason', () => {
    render(
      <BulkDeleteResultPanel
        deletedCount={2}
        totalCount={4}
        skipped={[
          { userId: 'user-self', label: 'admin@welld.ch', reason: 'cannot delete your own account' },
          { userId: 'user-admin2', label: 'bob@welld.ch', reason: 'last remaining admin' },
        ]}
        onDismiss={vi.fn()}
      />,
    )

    const list = screen.getByTestId('bulk-delete-result-skipped-list')
    expect(list.tagName).toBe('UL')

    const selfItem = screen.getByTestId('bulk-delete-result-skipped-user-self')
    expect(selfItem.tagName).toBe('LI')
    expect(selfItem.textContent).toBe('admin@welld.ch — skipped: cannot delete your own account')

    const adminItem = screen.getByTestId('bulk-delete-result-skipped-user-admin2')
    expect(adminItem.textContent).toBe('bob@welld.ch — skipped: last remaining admin')
  })

  it('renders no <ul> when nothing was skipped (full success)', () => {
    render(<BulkDeleteResultPanel deletedCount={3} totalCount={3} skipped={[]} onDismiss={vi.fn()} />)

    expect(screen.queryByTestId('bulk-delete-result-skipped-list')).toBeNull()
  })

  it('the dismiss "×" calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<BulkDeleteResultPanel deletedCount={1} totalCount={1} skipped={[]} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByTestId('bulk-delete-result-dismiss'))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
