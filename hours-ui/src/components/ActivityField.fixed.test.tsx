/**
 * @vitest-environment jsdom
 *
 * ActivityField `lock` (specs/20261116-record-hours-in-place T1; design S4 "The fixed task"; AC-3.2, AC-3.3).
 * `fixed` is the variant of a dialog opened from a task: the activity is a fact the page chose, shown with its own
 * words, not a control and never read. `hidden` is the "not visible" variant of specs/20261112-time-tracking T28
 * under its new name (`ActivityField.locked.test.tsx` keeps testing it through the old one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { strings } from '../strings'
import { fakeApi, requests } from '../test-support/fakeApi'
import { activitiesAnswer, projectTasks } from '../test-support/fixtures/activity'
import ActivityField, { type ActivityFieldProps } from './ActivityField'

const TASK = { id: 'a-offer', subject: 'Write the offer', visibility: 'visible' as const }
const HIDDEN_POINTER = { id: 'a-secret', subject: null, visibility: 'hidden' as const }

const renderField = (props: Partial<ActivityFieldProps> = {}) =>
  render(<ActivityField targetType="project" targetId="p1" value="a-offer" onChange={() => {}} {...props} />)

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => activitiesAnswer(projectTasks) }))
})
afterEach(() => cleanup())

describe('lock="fixed"', () => {
  it('shows the task’s subject under the label "Activity", with the hint that it cannot be changed here', () => {
    renderField({ lock: 'fixed', current: TASK })

    const term = screen.getByText(strings.activity.label, { selector: 'dt' })
    expect(within(term.closest('div') as HTMLElement).getByText('Write the offer', { selector: 'dd' })).not.toBeNull()
    expect(screen.getByText(strings.activity.fixed.hint)).not.toBeNull()
  })

  it('is not a control: no select, nothing aria-disabled, nothing to tab to', () => {
    renderField({ lock: 'fixed', current: TASK })

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('[aria-disabled], select, input, button')).toBeNull()
  })

  it('reads nothing from activities-api, however long it stays', async () => {
    renderField({ lock: 'fixed', current: TASK })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(requests(apiFetch)).toEqual([])
  })

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('reads "This task" for a task whose subject is %s', (_name, subject) => {
    renderField({ lock: 'fixed', current: { ...TASK, subject } })

    expect(screen.getByText(strings.activity.fixed.unnamed, { selector: 'dd' })).not.toBeNull()
  })

  it('reads "This task" when it is given no task to name at all', () => {
    renderField({ lock: 'fixed' })

    expect(screen.getByText(strings.activity.fixed.unnamed, { selector: 'dd' })).not.toBeNull()
  })

  it('shows the task even when the field would otherwise be waiting for a target', () => {
    renderField({ lock: 'fixed', current: TASK, targetId: null })

    expect(screen.getByText('Write the offer', { selector: 'dd' })).not.toBeNull()
  })
})

describe('lock="hidden"', () => {
  const description = () =>
    (screen.getByRole('combobox', { name: strings.activity.label }).getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ')

  it('is the "not visible" variant: the entry’s pointer, aria-disabled, why it cannot change, no read', async () => {
    renderField({ lock: 'hidden', current: HIDDEN_POINTER, value: 'a-secret', targetId: 'p-secret' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const select = screen.getByRole('combobox', { name: strings.activity.label }) as HTMLSelectElement
    expect(select.getAttribute('aria-disabled')).toBe('true')
    expect(select.selectedOptions[0]?.textContent).toBe('Not visible to you')
    expect(description()).toBe(strings.activity.locked.project)
    expect(requests(apiFetch)).toEqual([])
  })

  it('is the same field the old `locked` prop made', () => {
    const asLock = renderField({ lock: 'hidden', current: HIDDEN_POINTER, value: 'a-secret', targetId: 'p-secret' })
    const hidden = asLock.container.innerHTML
    asLock.unmount()
    const asLocked = renderField({ locked: true, current: HIDDEN_POINTER, value: 'a-secret', targetId: 'p-secret' })

    expect(asLocked.container.innerHTML.replace(/_r_\w+_/g, 'id')).toBe(hidden.replace(/_r_\w+_/g, 'id'))
  })
})
