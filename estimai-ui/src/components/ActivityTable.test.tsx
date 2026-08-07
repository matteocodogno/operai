/**
 * @vitest-environment jsdom
 *
 * Tests for the "+ Add Activity" affordance placement.
 *
 * Bug: the only "+ Add Activity" button lived in the section header at the top
 * of the table. With many activities the user had to scroll all the way back up
 * to add another row. A second button is now rendered at the BOTTOM of the table
 * so the action is reachable after scrolling through a long list.
 *
 * Covers:
 *   (A) both a top and a bottom "+ Add Activity" button are rendered.
 *   (B) clicking the bottom button invokes onAdd (same handler as the top one).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ActivityTable from './ActivityTable'
import type { Activity } from '../types'

const makeActivity = (id: string, epic: string): Activity => ({
  id,
  num: '',
  epic,
  act: `Activity ${id}`,
  prof: 'Developer',
  o: 3,
  ml: 5,
  p: 8,
  risk: 0,
  notes: '',
  release: 'Release 1',
})

const renderTable = (onAdd = vi.fn()) => {
  const activities = [makeActivity('a1', 'Epic A'), makeActivity('a2', 'Epic A')]
  render(
    <ActivityTable
      activities={activities}
      releaseNames={['Release 1']}
      globalAiGain={0.3}
      activityWarnings={new Map()}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onAdd={onAdd}
      onAddRelease={vi.fn(() => 'Release 2')}
      onReorder={vi.fn()}
    />,
  )
  return { onAdd }
}

afterEach(() => cleanup())

describe('ActivityTable — "+ Add Activity" is reachable at the bottom', () => {
  it('renders a top AND a bottom "+ Add Activity" button (A)', () => {
    renderTable()
    const buttons = screen.getAllByRole('button', { name: /add activity/i })
    // One in the header, one appended below the table body.
    expect(buttons.length).toBe(2)
  })

  it('clicking the bottom button invokes onAdd (B)', () => {
    const { onAdd } = renderTable()
    const buttons = screen.getAllByRole('button', { name: /add activity/i })
    fireEvent.click(buttons[buttons.length - 1])
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// T17 (specs/013-estimate-sharing/tasks.md; design.md S5) — readOnly gating.
//
// Covers every row in design.md's S5 table for ActivityTable specifically:
//   - text/number cells become readOnly, not disabled (still focusable)
//   - the Profile <select> renders as plain text, not a disabled <select>
//   - the Release <select> (and its "＋ New release…" mutation route) is
//     likewise absent entirely, replaced by plain text
//   - the drag handle is empty/non-interactive
//   - the per-row delete "×" cell is empty (not a disabled button)
//   - both "+ Add Activity" buttons are absent
// ---------------------------------------------------------------------------

const renderTableReadOnly = () => {
  const activities = [makeActivity('a1', 'Epic A'), makeActivity('a2', 'Epic A')]
  const onUpdate = vi.fn()
  const onDelete = vi.fn()
  const onAdd = vi.fn()
  render(
    <ActivityTable
      activities={activities}
      releaseNames={['Release 1']}
      globalAiGain={0.3}
      activityWarnings={new Map()}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onAdd={onAdd}
      onAddRelease={vi.fn(() => 'Release 2')}
      onReorder={vi.fn()}
      readOnly
    />,
  )
  return { onUpdate, onDelete, onAdd }
}

describe('ActivityTable — readOnly (viewer) gating (T17, AC-3.1/AC-3.2)', () => {
  it('every text/number input is readOnly, not disabled (stays focusable)', () => {
    renderTableReadOnly()
    const textboxes = screen.getAllByRole('textbox') as HTMLInputElement[]
    const spinbuttons = screen.getAllByRole('spinbutton') as HTMLInputElement[]
    expect(textboxes.length + spinbuttons.length).toBeGreaterThan(0)
    for (const el of [...textboxes, ...spinbuttons]) {
      expect(el.readOnly).toBe(true)
      expect(el.disabled).toBe(false)
    }
  })

  it('renders the Profile column as plain text, never a <select>', () => {
    renderTableReadOnly()
    expect(screen.queryAllByRole('combobox').length).toBe(0)
    expect(screen.getAllByText('Developer').length).toBeGreaterThan(0)
  })

  it('renders the Release column as plain text and never offers "＋ New release…"', () => {
    renderTableReadOnly()
    expect(screen.queryByText(/new release/i)).toBeNull()
    expect(screen.getAllByText('Release 1').length).toBeGreaterThan(0)
  })

  it('renders the drag handle as empty/non-interactive (no "⠿" glyph, no drag title)', () => {
    renderTableReadOnly()
    expect(screen.queryByText('⠿')).toBeNull()
    expect(screen.queryByTitle('Drag to reorder')).toBeNull()
  })

  it('renders no per-row delete "×" button', () => {
    renderTableReadOnly()
    expect(screen.queryByTitle('Delete activity')).toBeNull()
  })

  it('renders neither the header nor the footer "+ Add Activity" button', () => {
    renderTableReadOnly()
    expect(screen.queryAllByRole('button', { name: /add activity/i }).length).toBe(0)
  })

  it('never calls onUpdate/onDelete/onAdd from any rendered control (zero mutating controls)', () => {
    const { onUpdate, onDelete, onAdd } = renderTableReadOnly()
    for (const btn of screen.queryAllByRole('button')) fireEvent.click(btn)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    expect(onAdd).not.toHaveBeenCalled()
  })
})

describe('ActivityTable — editor (readOnly=false, the default) keeps every mutating control', () => {
  it('renders enabled Profile/Release <select> elements and a delete button per row', () => {
    renderTable()
    // 2 rows × (Profile + Release) selects = 4
    expect(screen.getAllByRole('combobox').length).toBe(4)
    expect(screen.getAllByTitle('Delete activity').length).toBe(2)
    expect(screen.getAllByTitle('Drag to reorder').length).toBe(2)
  })
})
