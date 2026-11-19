/**
 * @vitest-environment jsdom
 *
 * ChangeHistoryDrawer (T22, specs/20261118-refund-accounting-export, design S6e): newest first, the caller's value columns,
 * the empty state, and the drawer's own focus and close behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../test-support/axe'
import ChangeHistoryDrawer from './ChangeHistoryDrawer'
import type { HistoryRow } from './ChangeHistoryDrawer'

afterEach(cleanup)

type Row = HistoryRow & { account: string | null }

const rows: Row[] = [
  { at: '2026-03-01T09:00:00Z', byEmail: 'first@welld.ch', account: '5901' },
  { at: '2026-04-01T09:00:00Z', byEmail: 'second@welld.ch', account: '5905' },
  { at: '2026-05-01T09:00:00Z', byEmail: 'third@welld.ch', account: null },
]

const valueColumns = [{ id: 'account', header: 'Account', render: (row: Row) => row.account ?? 'None' }]

describe('ChangeHistoryDrawer', () => {
  it('is a modal dialog titled with the subject', () => {
    render(<ChangeHistoryDrawer subject="Travel — train" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'History — Travel — train' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByText('Every change, newest first.')).not.toBeNull()
  })

  it('lists the changes newest first, whatever order the API sent them in', () => {
    render(<ChangeHistoryDrawer subject="x" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />)
    const bodyRows = screen.getAllByRole('row').slice(1)
    expect(bodyRows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'third@welld.ch',
      'second@welld.ch',
      'first@welld.ch',
    ])
  })

  it('shows When as a time element, By, and the caller’s columns, "None" included', () => {
    render(<ChangeHistoryDrawer subject="x" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />)
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual(['When', 'By', 'Account'])
    const newest = screen.getAllByRole('row')[1]
    expect(newest.querySelector('time')?.getAttribute('datetime')).toBe('2026-05-01T09:00:00Z')
    expect(within(newest).getByText('None')).not.toBeNull()
  })

  it('keeps rows with the same instant in reverse API order (a tie never reorders the story)', () => {
    const same: Row[] = [
      { at: '2026-03-01T09:00:00Z', byEmail: 'a@welld.ch', account: '1' },
      { at: '2026-03-01T09:00:00Z', byEmail: 'b@welld.ch', account: '2' },
    ]
    render(<ChangeHistoryDrawer subject="x" rows={same} valueColumns={valueColumns} onClose={vi.fn()} />)
    expect(screen.getAllByRole('row')[1].textContent).toContain('b@welld.ch')
  })

  it('says so when nothing has changed yet, with no table', () => {
    render(<ChangeHistoryDrawer subject="x" rows={[]} valueColumns={valueColumns} onClose={vi.fn()} />)
    expect(screen.getByText('No changes recorded yet.')).not.toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('moves focus to the heading on open', () => {
    render(<ChangeHistoryDrawer subject="x" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'History — x' }))
  })

  it('closes on the × button and on Escape', () => {
    const onClose = vi.fn()
    render(<ChangeHistoryDrawer subject="x" rows={rows} valueColumns={valueColumns} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close the history' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not mutate the rows it was given', () => {
    const copy = rows.map((row) => ({ ...row }))
    render(<ChangeHistoryDrawer subject="x" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />)
    expect(rows).toEqual(copy)
  })
})

// T44: automated axe checks (test-support/axe.ts): the drawer with rows, with none, and with a null value.
describe('ChangeHistoryDrawer: accessibility (axe)', () => {
  it('has no violations with a history, a "None" value, and with no changes yet', async () => {
    const { rerender } = render(
      <ChangeHistoryDrawer subject="Travel — train" rows={rows} valueColumns={valueColumns} onClose={vi.fn()} />,
    )
    await expectNoAxeViolations()
    rerender(<ChangeHistoryDrawer subject="Travel — train" rows={[]} valueColumns={valueColumns} onClose={vi.fn()} />)
    await expectNoAxeViolations()
  })
})
