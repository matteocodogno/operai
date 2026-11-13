/**
 * @vitest-environment jsdom
 *
 * ActivityField, the "not visible" variant (specs/029-time-tracking T28; design S2 "The 'not visible' variant",
 * accessibility; AC-4.10, AC-2.12). An entry whose project or deal the author can no longer read opens with its
 * Activity NOT EDITABLE while the target is unchanged: the person cannot read that project's activities, so none
 * is listed and none is read; the field shows the entry's pointer ("Not visible to you", or "No activity") and says
 * why. Picking another target makes it a normal field again.
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { strings } from '../strings'
import { fakeApi, requests } from '../test-support/fakeApi'
import { activitiesAnswer, projectTasks } from '../test-support/fixtures/activity'
import ActivityField, { type ActivityFieldProps } from './ActivityField'

type HarnessProps = Partial<Omit<ActivityFieldProps, 'value' | 'onChange'>> & {
  initialValue?: string | null
  onChange?: (id: string | null) => void
}

function Harness({ initialValue = null, onChange, ...props }: HarnessProps) {
  const [value, setValue] = useState<string | null>(initialValue)
  return (
    <ActivityField
      targetType="project"
      targetId="p-secret"
      {...props}
      value={value}
      onChange={(id) => {
        setValue(id)
        onChange?.(id)
      }}
    />
  )
}

const field = () => screen.getByRole('combobox', { name: 'Activity' }) as HTMLSelectElement
const optionTexts = () =>
  within(field())
    .getAllByRole('option')
    .map((option) => option.textContent)
const description = () =>
  (field().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')

const HIDDEN_POINTER = { id: 'a-secret', subject: null, visibility: 'hidden' as const }

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => activitiesAnswer(projectTasks) }))
})
afterEach(() => cleanup())

describe('locked: the author cannot read the target', () => {
  it('reads nothing from activities-api, however long it stays', async () => {
    render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(requests(apiFetch, 'GET /activities')).toEqual([])
    expect(requests(apiFetch)).toEqual([])
  })

  it('shows the entry’s pointer as "Not visible to you" and is aria-disabled, so a keyboard user learns why', () => {
    render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(field().getAttribute('aria-disabled')).toBe('true')
    expect(field().disabled).toBe(false)
    expect(optionTexts()).toEqual(['No activity', 'Not visible to you'])
    expect(field().selectedOptions[0]?.textContent).toBe('Not visible to you')
  })

  it('never draws the id of the pointer it cannot name: not as text, not as an option value', () => {
    render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(screen.getByTestId('hours-activity').innerHTML).not.toContain('a-secret')
    // …and the field still reports the pointer as the same entry's (a pick of it would be the id, not a token).
    expect(field().selectedOptions[0]?.textContent).toBe('Not visible to you')
  })

  it('an entry that points at no activity shows "No activity"', () => {
    render(<Harness locked current={null} initialValue={null} />)
    expect(optionTexts()).toEqual(['No activity'])
    expect(field().value).toBe('')
  })

  it('says why it cannot be edited, for a project and for a deal', () => {
    const { unmount } = render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(description()).toBe(strings.activity.locked.project)
    unmount()
    render(<Harness locked targetType="deal" targetId="d-secret" current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(description()).toBe(strings.activity.locked.deal)
  })

  it('ignores a pick: the pointer stays what it was', async () => {
    const onChange = vi.fn()
    render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" onChange={onChange} />)
    await userEvent.selectOptions(field(), '')
    expect(onChange).not.toHaveBeenCalled()
    expect(field().selectedOptions[0]?.textContent).toBe('Not visible to you')
  })

  it('has no retry button and nothing in it is an alert: the field is optional', () => {
    render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(screen.queryByRole('button', { name: strings.common.tryAgain })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('no longer locked: another target was picked', () => {
  it('becomes a normal field and reads the new target’s activities as the person', async () => {
    const view = render(<Harness locked current={HIDDEN_POINTER} initialValue="a-secret" />)
    expect(requests(apiFetch, 'GET /activities')).toEqual([])

    view.rerender(<Harness targetId="p1" current={null} initialValue={null} />)
    await waitFor(() => expect(field().getAttribute('aria-disabled')).toBeNull())
    expect(requests(apiFetch, 'GET /activities').map((request) => request.query)).toEqual([
      { projectId: 'p1', pageSize: '100' },
    ])
    expect(optionTexts()).toContain('Task · Write the offer')
    expect(description()).toBe('')
  })
})
