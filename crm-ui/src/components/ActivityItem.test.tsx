/**
 * @vitest-environment jsdom
 *
 * ActivityItem and the Meetings mirror (specs/021 AC-14.2, AC-14.3, AC-14.4): an
 * activity that mirrors a meeting shows its title and date, its author by live
 * name, and an "Open meeting" link into the Meetings tool. Its body is the link
 * and nothing else, so no content of the meeting is ever rendered here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ActivityItem from './ActivityItem'
import type { Activity } from '../lib/types'

vi.mock('shell/session', () => ({
  useSession: () => ({ data: { user: { id: 'u-other' } } }),
  apiFetch: vi.fn(),
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

const MEETING_ACTIVITY: Activity = {
  id: 'a1',
  type: 'meeting',
  subject: 'Kick-off with Acme',
  body: null,
  occurredAt: '2026-11-03T09:30:00.000Z',
  company: { id: 'c1', name: 'Acme SA' },
  contact: null,
  deal: { id: 'd1', title: 'Platform rebuild' },
  author: { id: 'u-ada', name: 'Ada Lovelace', status: 'active' },
  task: null,
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
  meeting: { id: 'm-42', href: '/my-meetings/m/m-42' },
}

const noop = () => undefined
const show = (activity: Activity) =>
  render(<ActivityItem activity={activity} onChanged={noop} onEdit={noop} onDeleted={noop} />)

afterEach(cleanup)

describe('ActivityItem — a meeting activity', () => {
  it('links "Open meeting" to the meeting in the Meetings tool', () => {
    show(MEETING_ACTIVITY)
    const link = screen.getByRole('link', { name: 'Open meeting' })
    expect(link.getAttribute('href')).toBe('/my-meetings/m/m-42')
  })

  it('shows the subject, the type and the author by live name, with no body', () => {
    const { container } = show(MEETING_ACTIVITY)
    expect(screen.getByText('Kick-off with Acme')).not.toBeNull()
    expect(screen.getByText('Meeting')).not.toBeNull()
    expect(screen.getByText(/Ada Lovelace/)).not.toBeNull()
    expect(container.querySelector('p.whitespace-pre-line')).toBeNull()
  })

  it('never renders a body for a meeting activity, even if the server sent one', () => {
    show({ ...MEETING_ACTIVITY, body: 'Transcript: …' })
    expect(screen.queryByText(/Transcript/)).toBeNull()
  })

  it('builds the href from the meeting id, not from the server-supplied href', () => {
    show({ ...MEETING_ACTIVITY, meeting: { id: 'm 1/2', href: 'javascript:alert(1)' } })
    expect(screen.getByRole('link', { name: 'Open meeting' }).getAttribute('href')).toBe('/my-meetings/m/m%201%2F2')
  })

  it('shows an unknown author honestly rather than a name', () => {
    show({ ...MEETING_ACTIVITY, author: { id: 'u-gone', name: null, status: 'deleted' } })
    expect(screen.queryByText(/Ada Lovelace/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Open meeting' })).not.toBeNull()
  })
})

describe('ActivityItem — other activities', () => {
  it('a note has no "Open meeting" link and keeps its body', () => {
    show({ ...MEETING_ACTIVITY, id: 'a2', type: 'note', body: 'Called about pricing', meeting: null })
    expect(screen.queryByRole('link', { name: 'Open meeting' })).toBeNull()
    expect(screen.getByText('Called about pricing')).not.toBeNull()
  })

  it('an activity from a server that predates the field has no link', () => {
    const older: Activity = { ...MEETING_ACTIVITY, type: 'call', body: 'Quick call' }
    delete older.meeting
    show(older)
    expect(screen.queryByRole('link', { name: 'Open meeting' })).toBeNull()
  })
})
