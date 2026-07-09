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
