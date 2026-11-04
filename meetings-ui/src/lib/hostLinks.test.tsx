/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({ navigateSuite: vi.fn(), apiFetch: vi.fn(), getMeetingsApiBaseUrl: () => '' }))

import { navigateSuite } from 'shell/session'
import { crmDealHost, hostView } from '../test-support/fakeApi'
import { describeHost, hostNames, suiteLinkProps } from './hostLinks'

afterEach(() => {
  cleanup()
  vi.mocked(navigateSuite).mockClear()
})

describe('suiteLinkProps', () => {
  it('a plain click goes through the shell router; a modified click is left to the browser', () => {
    // After React's handler has run, stop jsdom from trying a real navigation on the modified clicks.
    const stop = (event: Event) => event.preventDefault()
    document.addEventListener('click', stop)
    render(<a {...suiteLinkProps('/crm/deals/d1')}>deal</a>)
    const link = screen.getByRole('link', { name: 'deal' })
    expect(link.getAttribute('href')).toBe('/crm/deals/d1')

    fireEvent.click(link, { ctrlKey: true })
    fireEvent.click(link, { button: 1 })
    expect(navigateSuite).not.toHaveBeenCalled()

    fireEvent.click(link)
    expect(navigateSuite).toHaveBeenCalledWith('/crm/deals/d1')
    document.removeEventListener('click', stop)
  })
})

describe('describeHost (AC-10.3)', () => {
  it('open: "Entity · title" with the href', () => {
    expect(describeHost(hostView(), [crmDealHost])).toEqual({
      kind: 'open',
      text: 'Deal · Acme renewal',
      href: '/crm/deals/d1',
    })
  })

  it.each(['closed', 'unavailable'] as const)('%s: only the app and the type, no title', (state) => {
    expect(describeHost(hostView({ state, title: null, href: null }), [crmDealHost])).toEqual({
      kind: 'plain',
      text: 'CRM · deal',
    })
  })

  it('missing: no longer available', () => {
    expect(describeHost(hostView({ state: 'missing', title: null, href: null }), [crmDealHost])).toEqual({
      kind: 'missing',
    })
  })

  it('degrades to the raw ids when the registry is not known', () => {
    expect(hostNames(null, 'crm', 'deal')).toEqual({ app: 'crm', entity: 'deal' })
    expect(describeHost(hostView({ state: 'closed', title: null, href: null }), null)).toEqual({
      kind: 'plain',
      text: 'crm · deal',
    })
  })
})
