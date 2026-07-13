/**
 * @vitest-environment jsdom
 *
 * Component tests for ToastHost (T12, specs/005-notification-center,
 * design.md "Toast (ToastHost, shell-chrome overlay)", US-5: AC-5.1, AC-5.2,
 * AC-5.3, AC-5.5).
 *
 * `../lib/notifications` (T10) is mocked here, deliberately: ToastHost's only
 * dependency on it is `subscribeToasts()`, the toast-worthy-event seam. Mocking
 * it lets each test drive the exact sequence of `ToastEvent`s a real SSE
 * connection would eventually deliver, without standing up a fake EventSource
 * (that machinery is already covered by notifications.test.ts). Capturing the
 * listener `subscribeToasts` was called with is how tests "emit" an event.
 *
 * Covers, per tasks.md T12's "done when":
 *   (a) a toast pops on a toast-worthy event
 *   (b) the auto-dismiss timer removes it (severity-scaled duration)
 *   (c) manual dismiss removes it and it does not reappear
 *   (d) a non-toast event pops nothing (by construction: nothing here ever
 *       calls the captured listener for it — subscribeToasts only ever fires
 *       for toast-worthy events per T10's contract)
 *   (e) correct role by severity (status vs alert)
 *   (f) multiple toasts stack, newest first, capped/queued beyond the visible max
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Notification, NotificationSeverity, ToastEvent } from '../lib/notifications'

const { subscribeToasts } = vi.hoisted(() => ({ subscribeToasts: vi.fn() }))
vi.mock('../lib/notifications', () => ({ subscribeToasts }))

import ToastHost from './ToastHost'

/** Captures the listener ToastHost registered, so tests can "emit" a toast event. */
let capturedListener: ((event: ToastEvent) => void) | null = null
const unsubscribe = vi.fn()

beforeEach(() => {
  capturedListener = null
  subscribeToasts.mockImplementation((listener: (event: ToastEvent) => void) => {
    capturedListener = listener
    return unsubscribe
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  title: 'Export finished',
  body: 'Your XLSX export is ready.',
  severity: 'info',
  originApp: 'estimai',
  toastWorthy: true,
  readAt: null,
  createdAt: '2026-07-13T09:00:00.000Z',
  ...overrides,
})

const emit = (notification: Notification): void => {
  act(() => {
    capturedListener?.({ notification })
  })
}

describe('ToastHost', () => {
  it('renders nothing when no toast-worthy event has fired', () => {
    render(<ToastHost />)
    expect(subscribeToasts).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  describe('(a) a toast pops on a toast-worthy event', () => {
    it('shows the title and body once the subscribed listener fires', () => {
      render(<ToastHost />)

      emit(makeNotification({ title: 'Export finished', body: 'Your XLSX export is ready.' }))

      expect(screen.getByText('Export finished')).toBeDefined()
      expect(screen.getByText('Your XLSX export is ready.')).toBeDefined()
    })
  })

  describe('(b) auto-dismiss', () => {
    it('removes an info/success toast after 6s', () => {
      vi.useFakeTimers()
      render(<ToastHost />)
      emit(makeNotification({ severity: 'info' }))
      expect(screen.getByText('Export finished')).toBeDefined()

      act(() => { vi.advanceTimersByTime(5999) })
      expect(screen.getByText('Export finished')).toBeDefined()

      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.queryByText('Export finished')).toBeNull()
    })

    it('removes a warning toast after 8s and an error toast after 10s', () => {
      vi.useFakeTimers()
      render(<ToastHost />)
      emit(makeNotification({ id: 'w1', title: 'Warning toast', severity: 'warning' }))
      emit(makeNotification({ id: 'e1', title: 'Error toast', severity: 'error' }))

      act(() => { vi.advanceTimersByTime(8000) })
      expect(screen.queryByText('Warning toast')).toBeNull()
      expect(screen.getByText('Error toast')).toBeDefined()

      act(() => { vi.advanceTimersByTime(2000) })
      expect(screen.queryByText('Error toast')).toBeNull()
    })

    it('pauses the auto-dismiss timer on hover and resumes on mouse-leave', () => {
      vi.useFakeTimers()
      render(<ToastHost />)
      emit(makeNotification({ severity: 'info' }))
      const toast = screen.getByRole('status')

      act(() => { vi.advanceTimersByTime(5000) })
      fireEvent.mouseEnter(toast)
      // Paused: the remaining ~1000ms must not elapse while hovered.
      act(() => { vi.advanceTimersByTime(5000) })
      expect(screen.getByText('Export finished')).toBeDefined()

      fireEvent.mouseLeave(toast)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('Export finished')).toBeNull()
    })
  })

  describe('(c) manual dismiss', () => {
    it('removes the toast immediately on "×" click and it does not reappear', () => {
      vi.useFakeTimers()
      render(<ToastHost />)
      emit(makeNotification())

      fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }))
      expect(screen.queryByText('Export finished')).toBeNull()

      // Advance well past every severity's auto-dismiss window — a dismissed
      // toast must never come back via a timer that was still pending.
      act(() => { vi.advanceTimersByTime(20_000) })
      expect(screen.queryByText('Export finished')).toBeNull()
    })

    it('dismisses on Escape while part of the toast has focus', () => {
      render(<ToastHost />)
      emit(makeNotification())

      const dismissButton = screen.getByRole('button', { name: /dismiss notification/i })
      dismissButton.focus()
      fireEvent.keyDown(dismissButton, { key: 'Escape' })

      expect(screen.queryByText('Export finished')).toBeNull()
    })
  })

  describe('(d) a non-toast-worthy event pops nothing', () => {
    it('renders nothing when the listener is simply never invoked', () => {
      render(<ToastHost />)
      // subscribeToasts only ever calls its listener for toast-worthy events
      // (T10's contract) — asserting the DOM stays empty when nothing is
      // emitted is the behavioral proof available at this layer.
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  describe('(e) correct ARIA role by severity', () => {
    it.each<[NotificationSeverity, 'status' | 'alert']>([
      ['info', 'status'],
      ['success', 'status'],
      ['warning', 'alert'],
      ['error', 'alert'],
    ])('severity=%s -> role=%s', (severity, expectedRole) => {
      render(<ToastHost />)
      emit(makeNotification({ id: `n-${severity}`, title: `Toast ${severity}`, severity }))

      const toast = screen.getByText(`Toast ${severity}`).closest(`[role="${expectedRole}"]`)
      expect(toast).not.toBeNull()
    })

    it('sets aria-live="assertive" for warning/error and "polite" for info/success', () => {
      render(<ToastHost />)
      emit(makeNotification({ id: 'w', title: 'W', severity: 'warning' }))
      emit(makeNotification({ id: 'i', title: 'I', severity: 'info' }))

      const warningToast = screen.getByText('W').closest('[role="alert"]')
      const infoToast = screen.getByText('I').closest('[role="status"]')
      expect(warningToast?.getAttribute('aria-live')).toBe('assertive')
      expect(infoToast?.getAttribute('aria-live')).toBe('polite')
    })
  })

  describe('(f) stacking', () => {
    it('stacks multiple toasts with the newest first', () => {
      render(<ToastHost />)
      emit(makeNotification({ id: 'n1', title: 'First' }))
      emit(makeNotification({ id: 'n2', title: 'Second' }))
      emit(makeNotification({ id: 'n3', title: 'Third' }))

      const titles = screen.getAllByText(/^(First|Second|Third)$/).map(el => el.textContent)
      expect(titles).toEqual(['Third', 'Second', 'First'])
    })

    it('caps visible toasts and promotes a queued one once a slot frees up', () => {
      vi.useFakeTimers()
      render(<ToastHost />)
      // 4 visible (the cap) + 1 queued.
      emit(makeNotification({ id: 'n1', title: 'Toast 1', severity: 'error' }))
      emit(makeNotification({ id: 'n2', title: 'Toast 2', severity: 'error' }))
      emit(makeNotification({ id: 'n3', title: 'Toast 3', severity: 'error' }))
      emit(makeNotification({ id: 'n4', title: 'Toast 4', severity: 'error' }))
      emit(makeNotification({ id: 'n5', title: 'Toast 5', severity: 'error' }))

      expect(screen.queryAllByText(/^Toast \d$/)).toHaveLength(4)
      expect(screen.queryByText('Toast 5')).toBeNull()

      // Dismiss one of the visible four — the queued 5th should be promoted.
      const dismissButtons = screen.getAllByRole('button', { name: /dismiss notification/i })
      fireEvent.click(dismissButtons[0])

      expect(screen.getByText('Toast 5')).toBeDefined()
      expect(screen.queryAllByText(/^Toast \d$/)).toHaveLength(4)
    })
  })

  it('does not use color as the only severity signal (icon is aria-hidden, a sr-only label states severity)', () => {
    render(<ToastHost />)
    emit(makeNotification({ severity: 'error' }))

    const toast = screen.getByRole('alert')
    expect(within(toast).getByText('Severity: error', { selector: '.sr-only' })).toBeDefined()
  })
})
