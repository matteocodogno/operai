/**
 * @vitest-environment jsdom
 *
 * INC-25 — the notification center renders in Italian when <html lang> says
 * so (the shell sets it at startup). The catalog is selected when the strings
 * module is evaluated, so the language is set in a hoisted block before any
 * import below runs. Every other test file runs with the default English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  document.documentElement.setAttribute('lang', 'it')
})

vi.mock('shell/session', () => ({ resetUnreadCount: vi.fn(), navigateSuite: vi.fn() }))
vi.mock('./lib/notificationsApi', () => ({ listNotifications: vi.fn(), markAllRead: vi.fn() }))

import { cleanup, render, screen } from '@testing-library/react'
import { formatRelative } from '@operai/ui'
import NotificationCenterPage from './pages/NotificationCenterPage'
import { listNotifications, markAllRead } from './lib/notificationsApi'

afterEach(() => cleanup())

describe('notification center in Italian', () => {
  it('renders the heading, the action, the row labels and the relative time in Italian', async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    vi.mocked(markAllRead).mockResolvedValue({ updated: 0, count: 0 })
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        {
          id: 'n-1',
          title: 'Richiesta approvata',
          body: 'La richiesta di rimborso è stata approvata.',
          severity: 'success',
          originApp: 'refund',
          toastWorthy: false,
          readAt: null,
          createdAt,
        },
      ],
      nextCursor: null,
    })

    render(<NotificationCenterPage />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Posta in arrivo')
    expect(screen.getByRole('button', { name: 'Segna tutte come lette' })).not.toBeNull()
    expect(await screen.findByText('1 notifica caricata')).not.toBeNull()
    expect(screen.getByText('Gravità: Operazione riuscita')).not.toBeNull()
    expect(screen.getByTestId('notification-new-tag-n-1').textContent).toBe('Nuova')
    expect(screen.getByTestId('notification-origin-n-1').textContent).toBe('Rimborsi')
    expect(document.querySelector('time')?.textContent).toBe(formatRelative(createdAt, new Date(), 'it'))
    expect(document.querySelector('time')?.textContent).toBe('2 ore fa')
  })

  it('labels a notification raised by the projects origin "Progetti" (specs/022 AC-4.3)', async () => {
    vi.mocked(markAllRead).mockResolvedValue({ updated: 0, count: 0 })
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        {
          id: 'n-2',
          title: 'New project to staff',
          body: 'A project is waiting for a project manager.',
          severity: 'info',
          originApp: 'projects',
          toastWorthy: false,
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    })

    render(<NotificationCenterPage />)

    expect((await screen.findByTestId('notification-origin-n-2')).textContent).toBe('Progetti')
  })

  it('shows the Italian empty state', async () => {
    vi.mocked(markAllRead).mockResolvedValue({ updated: 0, count: 0 })
    vi.mocked(listNotifications).mockResolvedValue({ items: [], nextCursor: null })

    render(<NotificationCenterPage />)

    expect(await screen.findByText('Ancora nessuna notifica')).not.toBeNull()
  })
})
