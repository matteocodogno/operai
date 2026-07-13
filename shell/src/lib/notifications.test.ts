/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/notifications.ts — the shell notification transport
 * seam (T10, specs/005-notification-center).
 *
 * Covers, per tasks.md T10's "done when":
 *   (a) raiseNotification — posts to the right URL, request body carries no
 *       recipient field, resolves the created notification.
 *   (b) useUnreadCount — increments on a mocked SSE `notification` event and
 *       zeroes on a mocked `unread-reset` event.
 *   (c) resetUnreadCount — zeros the count locally, no network call.
 *   (d) the internal SSE connection manager — reconnects with a FRESH ticket
 *       and re-syncs the count from REST after a stream error (mocked
 *       EventSource + apiFetch).
 *   (e) getTrustedOrigins (session.ts) includes the notify-api origin —
 *       proven behaviorally via apiFetch, the same way session.test.ts
 *       already proves the auth/API origins (getTrustedOrigins itself is not
 *       exported).
 *   (f) bonus (touch-list coverage): signOut() closes the tab's open SSE
 *       connection.
 *
 * `fetch` is mocked with a small URL router (rather than session.test.ts's
 * `mockResolvedValueOnce` chain) because the SSE manager fires several
 * different requests (ticket mint, unread-count resync) in an order that
 * isn't strictly linear across (re)connects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// Mock better-auth's client factory so importing ./session (a notifications.ts
// dependency, via the circular `export * from './notifications'`) doesn't
// perform real network/env work — mirrors session.test.ts's own mock.
const mockAuthClientSignOut = vi.fn().mockResolvedValue(undefined)
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    getSession: vi.fn(),
    useSession: vi.fn(),
    signOut: mockAuthClientSignOut,
  }),
}))

const {
  raiseNotification,
  useUnreadCount,
  resetUnreadCount,
  closeSseConnection,
} = await import('./notifications')
const { apiFetch, signOut } = await import('./session')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL = 'http://auth.test'
const NOTIFY_URL = 'http://notify.test'
const FAKE_JWT = 'header.payload.signature'

// ---------------------------------------------------------------------------
// Mock EventSource — jsdom does not implement EventSource, so the real
// browser API is replaced wholesale via vi.stubGlobal. Exposes `emit()` /
// `triggerError()` so tests can drive the notification.ts connection
// manager's event handlers directly.
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  closed = false
  onerror: ((event: Event) => void) | null = null
  onopen: (() => void) | null = null
  private listeners: Record<string, Array<(event: MessageEvent<string>) => void>> = {}

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  close(): void {
    this.closed = true
  }

  /** Test helper: dispatches a named SSE event with a JSON-encoded payload. */
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>
    for (const listener of this.listeners[type] ?? []) {
      listener(event)
    }
  }

  /** Test helper: fires the connection's onerror handler. */
  triggerError(): void {
    this.onerror?.(new Event('error'))
  }

  /** Test helper: fires the connection's onopen handler (simulates a successful connect). */
  triggerOpen(): void {
    this.onopen?.()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

let ticketCounter = 0
/** Mutable — tests set this before an action to control the next resync's server truth. */
let serverUnreadCount = 0

const resolveUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

/**
 * A small router-style fetch mock (rather than session.test.ts's ordered
 * `mockResolvedValueOnce` chain) — the SSE manager makes several distinct
 * calls (ticket mint, unread-count resync) whose relative ordering across
 * (re)connects isn't worth pinning exactly; routing by URL+method keeps the
 * tests robust to that.
 */
function buildFetchRouter() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url === `${AUTH_URL}/auth/token`) {
      return makeResponse(200, { token: FAKE_JWT })
    }
    if (url === `${NOTIFY_URL}/notifications/stream-ticket` && method === 'POST') {
      ticketCounter += 1
      return makeResponse(200, { ticket: `ticket-${ticketCounter}`, expiresIn: 30 })
    }
    if (url === `${NOTIFY_URL}/notifications/unread-count`) {
      return makeResponse(200, { count: serverUnreadCount })
    }
    if (url === `${NOTIFY_URL}/notifications` && method === 'POST') {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return makeResponse(201, {
        id: 'n1',
        title: parsed['title'],
        body: parsed['body'],
        severity: parsed['severity'] ?? 'info',
        originApp: parsed['originApp'],
        link: parsed['link'],
        toastWorthy: parsed['toast'] ?? false,
        readAt: null,
        createdAt: '2026-07-13T09:00:00.000Z',
      })
    }

    throw new Error(`notifications.test.ts: unexpected fetch to ${method} ${url}`)
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', AUTH_URL)
  vi.stubEnv('VITE_NOTIFY_API_URL', NOTIFY_URL)

  ticketCounter = 0
  serverUnreadCount = 0
  MockEventSource.instances = []

  vi.stubGlobal('EventSource', MockEventSource)
  vi.stubGlobal('fetch', buildFetchRouter())

  Object.defineProperty(window, 'location', {
    value: {
      href: 'http://localhost:5173/estimai',
      assign: vi.fn(),
    },
    writable: true,
    configurable: true,
  })

  // Start every test from a clean slate — a previous test's connection/count
  // must never leak (module-scope state, shared across it() blocks in this file).
  closeSseConnection()
  resetUnreadCount()
  mockAuthClientSignOut.mockClear()
})

afterEach(() => {
  closeSseConnection()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// (a) raiseNotification
// ---------------------------------------------------------------------------

describe('raiseNotification', () => {
  it('posts to POST {notifyBase}/notifications with no recipient field and resolves the created notification', async () => {
    const result = await raiseNotification({
      title: 'Export finished',
      body: 'Your XLSX export is ready.',
      severity: 'success',
      originApp: 'estimai',
      toast: true,
    })

    expect(result).toMatchObject({
      id: 'n1',
      title: 'Export finished',
      body: 'Your XLSX export is ready.',
      severity: 'success',
      originApp: 'estimai',
      toastWorthy: true,
      readAt: null,
    })

    const mockFetch = vi.mocked(fetch)
    const raiseCalls = mockFetch.mock.calls.filter(([url]) => resolveUrl(url) === `${NOTIFY_URL}/notifications`)
    expect(raiseCalls).toHaveLength(1)

    const [, init] = raiseCalls[0]
    expect((init as RequestInit)?.method).toBe('POST')

    const sentBody = JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('recipient')
    expect(sentBody).not.toHaveProperty('recipientId')
    expect(sentBody).toEqual({
      title: 'Export finished',
      body: 'Your XLSX export is ready.',
      severity: 'success',
      originApp: 'estimai',
      toast: true,
    })

    // Bearer-attached — raiseNotification goes through apiFetch like every
    // other Operai call.
    expect((init as RequestInit & { headers: Record<string, string> }).headers).toMatchObject({
      Authorization: `Bearer ${FAKE_JWT}`,
    })
  })

  it('rejects when notify-api responds with a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = resolveUrl(input)
        if (url === `${AUTH_URL}/auth/token`) return makeResponse(200, { token: FAKE_JWT })
        if (url === `${NOTIFY_URL}/notifications` && init?.method === 'POST') {
          return makeResponse(400, {
            type: 'https://httpstatuses.com/400',
            title: 'Bad Request',
            status: 400,
            detail: 'title is required',
            instance: '/notifications',
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    await expect(
      raiseNotification({ title: '', body: 'x', originApp: 'estimai' }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// (b) useUnreadCount — SSE-driven
// ---------------------------------------------------------------------------

describe('useUnreadCount', () => {
  it('starts at 0, opens one SSE connection lazily, and increments on a mocked notification event (re-syncing from REST)', async () => {
    const { result, unmount } = renderHook(() => useUnreadCount())
    expect(result.current).toBe(0)

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })
    const es = MockEventSource.instances[0]
    expect(es.url).toBe(`${NOTIFY_URL}/notifications/stream?ticket=ticket-1`)

    // Server truth once the resync (triggered by the notification event) resolves.
    serverUnreadCount = 1

    act(() => {
      es.emit('notification', {
        id: 'n2',
        title: 'New estimate ready',
        body: 'Body',
        severity: 'info',
        originApp: 'estimai',
        toastWorthy: false,
        readAt: null,
        createdAt: '2026-07-13T10:00:00.000Z',
      })
    })

    await waitFor(() => {
      expect(result.current).toBe(1)
    })

    unmount()
  })

  it('zeroes the count on a mocked unread-reset event', async () => {
    const { result, unmount } = renderHook(() => useUnreadCount())

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })
    const es = MockEventSource.instances[0]

    serverUnreadCount = 4
    act(() => {
      es.emit('notification', {
        id: 'n3',
        title: 'x',
        body: 'y',
        severity: 'info',
        originApp: 'estimai',
        toastWorthy: false,
        readAt: null,
        createdAt: '2026-07-13T10:00:00.000Z',
      })
    })
    await waitFor(() => {
      expect(result.current).toBe(4)
    })

    act(() => {
      es.emit('unread-reset', { count: 0 })
    })

    await waitFor(() => {
      expect(result.current).toBe(0)
    })

    unmount()
  })
})

// ---------------------------------------------------------------------------
// (c) resetUnreadCount
// ---------------------------------------------------------------------------

describe('resetUnreadCount', () => {
  it('zeros the count locally, immediately, with no network call', async () => {
    const { result, unmount } = renderHook(() => useUnreadCount())

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })
    const es = MockEventSource.instances[0]

    serverUnreadCount = 5
    act(() => {
      es.emit('notification', {
        id: 'n4',
        title: 'x',
        body: 'y',
        severity: 'info',
        originApp: 'estimai',
        toastWorthy: false,
        readAt: null,
        createdAt: '2026-07-13T10:00:00.000Z',
      })
    })
    await waitFor(() => {
      expect(result.current).toBe(5)
    })

    const fetchCallCountBefore = vi.mocked(fetch).mock.calls.length

    act(() => {
      resetUnreadCount()
    })

    expect(result.current).toBe(0)
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCallCountBefore)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// (d) SSE connection manager — reconnect with a fresh ticket + REST resync
// ---------------------------------------------------------------------------

describe('SSE connection manager', () => {
  it(
    'on error: closes the dead connection, mints a FRESH ticket, opens a new EventSource, and re-syncs the count from REST',
    async () => {
      const { result, unmount } = renderHook(() => useUnreadCount())

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1)
      })
      const first = MockEventSource.instances[0]
      expect(first.url).toBe(`${NOTIFY_URL}/notifications/stream?ticket=ticket-1`)
      expect(first.closed).toBe(false)

      // What the server will report once the reconnect's resync resolves.
      serverUnreadCount = 7

      act(() => {
        first.triggerError()
      })

      // The dead connection is closed immediately — this is what stops the
      // browser's OWN built-in retry against the now-consumed ticket's URL.
      expect(first.closed).toBe(true)

      await waitFor(
        () => {
          expect(MockEventSource.instances).toHaveLength(2)
        },
        { timeout: 3000 },
      )
      const second = MockEventSource.instances[1]
      // A fresh ticket — never the consumed one.
      expect(second.url).toBe(`${NOTIFY_URL}/notifications/stream?ticket=ticket-2`)
      expect(second.url).not.toBe(first.url)

      await waitFor(() => {
        expect(result.current).toBe(7)
      })

      unmount()
    },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// Reconnect backoff — DEFECT 3 fix: fixed 1s unbounded retry replaced with
// exponential backoff + cap + jitter (schedule: 1s, 2s, 4s, 8s, 16s, 30s,
// 30s, …), resetting to the prompt ~1s retry on a successful (re)connect,
// with a leaked-timer guard on teardown. `Math.random` is stubbed to 0 in
// these tests so the (deliberately small, ratio-based) jitter term is
// neutralized and the schedule is asserted exactly; real jitter only ever
// adds up to 20% on top.
// ---------------------------------------------------------------------------

describe('SSE reconnect backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('grows exponentially across consecutive failures, capped at 30s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { unmount } = renderHook(() => useUnreadCount())

    // Flush the initial (successful) connect.
    await vi.advanceTimersByTimeAsync(0)
    expect(MockEventSource.instances).toHaveLength(1)

    // Never call triggerOpen() below — every reconnect in this test also
    // fails immediately, so the attempt counter keeps climbing per the
    // documented schedule.
    const schedule = [1000, 2000, 4000, 8000, 16000, 30000, 30000]

    for (const [i, delay] of schedule.entries()) {
      const latest = MockEventSource.instances[MockEventSource.instances.length - 1]
      act(() => {
        latest.triggerError()
      })

      // One tick short of the expected delay: no reconnect yet.
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(MockEventSource.instances).toHaveLength(i + 1)

      // The delay elapses: the reconnect fires.
      await vi.advanceTimersByTimeAsync(1)
      expect(MockEventSource.instances).toHaveLength(i + 2)
    }

    unmount()
  })

  it('keeps the FIRST reconnect after a drop prompt (~1s), only backing off on repeated failures', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { unmount } = renderHook(() => useUnreadCount())
    await vi.advanceTimersByTimeAsync(0)
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      MockEventSource.instances[0].triggerError()
    })

    // Not yet at 999ms...
    await vi.advanceTimersByTimeAsync(999)
    expect(MockEventSource.instances).toHaveLength(1)
    // ...fires at 1000ms.
    await vi.advanceTimersByTimeAsync(1)
    expect(MockEventSource.instances).toHaveLength(2)

    unmount()
  })

  it('resets the backoff to ~1s after a successful (re)connect', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { unmount } = renderHook(() => useUnreadCount())
    await vi.advanceTimersByTimeAsync(0)
    expect(MockEventSource.instances).toHaveLength(1)

    // Two consecutive failures — climbs to a 4s-delay attempt (1s, then 2s).
    act(() => {
      MockEventSource.instances[0].triggerError()
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockEventSource.instances).toHaveLength(2)

    act(() => {
      MockEventSource.instances[1].triggerError()
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(MockEventSource.instances).toHaveLength(3)

    // This (re)connect succeeds — the backoff resets.
    act(() => {
      MockEventSource.instances[2].triggerOpen()
    })

    act(() => {
      MockEventSource.instances[2].triggerError()
    })

    // A subsequent failure backs off from scratch: ~1s, not 4s/8s.
    await vi.advanceTimersByTimeAsync(999)
    expect(MockEventSource.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockEventSource.instances).toHaveLength(4)

    unmount()
  })

  it('close()/signOut cancels a pending reconnect timer — no leaked reconnect', async () => {
    const { unmount } = renderHook(() => useUnreadCount())
    await vi.advanceTimersByTimeAsync(0)
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      MockEventSource.instances[0].triggerError()
    })
    // A reconnect is scheduled (~1s out) but has not fired yet.
    expect(MockEventSource.instances).toHaveLength(1)

    await signOut()
    expect(mockAuthClientSignOut).toHaveBeenCalledOnce()

    // Advance well past the scheduled delay (and the whole backoff ceiling)
    // — the cancelled timer must never fire.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockEventSource.instances).toHaveLength(1)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// (e) getTrustedOrigins (session.ts) includes the notify-api origin —
// proven behaviorally via apiFetch, matching session.test.ts's own
// auth-origin / API-origin assertions (getTrustedOrigins itself is a
// private, unexported helper).
// ---------------------------------------------------------------------------

describe('trusted origins', () => {
  it('apiFetch attaches the Bearer header for a request to the notify-api origin', async () => {
    const response = await apiFetch(`${NOTIFY_URL}/notifications/unread-count`)
    expect(response.status).toBe(200)

    const mockFetch = vi.mocked(fetch)
    const calls = mockFetch.mock.calls.filter(
      ([url]) => resolveUrl(url) === `${NOTIFY_URL}/notifications/unread-count`,
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const [, init] = calls[calls.length - 1]
    expect((init as RequestInit & { headers: Record<string, string> })?.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_JWT}`,
    })
  })
})

// ---------------------------------------------------------------------------
// (f) signOut closes the tab's open SSE connection (ADR-0009 R8)
// ---------------------------------------------------------------------------

describe('signOut', () => {
  it('closes the open SSE connection', async () => {
    const { unmount } = renderHook(() => useUnreadCount())

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })
    const es = MockEventSource.instances[0]
    expect(es.closed).toBe(false)

    await signOut()

    expect(es.closed).toBe(true)
    expect(mockAuthClientSignOut).toHaveBeenCalledOnce()

    unmount()
  })
})
