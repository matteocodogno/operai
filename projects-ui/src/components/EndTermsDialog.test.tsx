/**
 * @vitest-environment jsdom
 *
 * EndTermsDialog (specs/021 AC-2.10; specs/022 AC-7.1, D53): ending terms is setting their end date. A
 * refused end date — empty, before the start, or refused by the server — loses its message and its invalid
 * mark as soon as the date changes, even to a value that is still wrong; the next submit checks it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import EndTermsDialog from './EndTermsDialog'

const onEnded = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const TERMS = termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 })

const renderDialog = (routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'PATCH /projects/p1/terms': () => ({ status: 200, body: { ...TERMS, endDate: '2026-06-30' } }),
      ...routes,
    }),
  )
  render(<EndTermsDialog projectId="p1" terms={TERMS} onEnded={onEnded} onCancel={onCancel} onStale={onStale} />)
  return screen.getByRole('dialog', { name: 'Set the end date' })
}

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const endDate = (dialog: HTMLElement) => within(dialog).getByLabelText(/End date/)
const setEnd = (dialog: HTMLElement, value: string) => fireEvent.change(endDate(dialog), { target: { value } })
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('terms-end-submit'))
const patches = () =>
  apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').length

describe('an error ends when the end date changes (AC-7.1, D53)', () => {
  const REQUIRED = 'This field is required.'
  const BEFORE_START = 'The end date must not be before the start date.'

  it('clears “required” as soon as a date is entered, and the next submit checks again', () => {
    const dialog = renderDialog()
    setEnd(dialog, '')
    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBe('true')

    setEnd(dialog, '2026-06-30')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBeNull()

    // Emptied again: still wrong, and quiet until the next submit.
    setEnd(dialog, '')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(patches()).toBe(0)
  })

  it('clears “before the start” when the date changes, even to another date before the start', () => {
    const dialog = renderDialog()
    setEnd(dialog, '2026-01-15')
    submit(dialog)
    expect(within(dialog).getByText(BEFORE_START)).not.toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBe('true')

    setEnd(dialog, '2026-01-16')
    expect(within(dialog).queryByText(BEFORE_START)).toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBeNull()

    submit(dialog)
    expect(within(dialog).getByText(BEFORE_START)).not.toBeNull()
    expect(patches()).toBe(0)
  })

  it('clears a message the server refused the end date with when the date changes', async () => {
    const dialog = renderDialog({
      'PATCH /projects/p1/terms': () => problem(422, 'validation_failed', { field: 'endDate' }, 'Not a date.'),
    })
    setEnd(dialog, '2026-06-30')
    submit(dialog)
    expect(await within(dialog).findByText('Not a date.')).not.toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBe('true')

    setEnd(dialog, '2026-07-01')
    expect(within(dialog).queryByText('Not a date.')).toBeNull()
    expect(endDate(dialog).getAttribute('aria-invalid')).toBeNull()
    await waitFor(() => expect(patches()).toBe(1))
  })
})
