/**
 * @vitest-environment jsdom
 *
 * AC-11.7 (specs/021): in this release the company page does not roll up its
 * deals' meetings. Only the deal page hosts the Meetings extension; the company
 * page renders no extension and never even imports the seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { createAppRouter } from '../router'
import { ADA, companySummary, fakeApi, page } from '../test-support/fakeApi'

const { apiFetch, hostExtension } = vi.hoisted(() => ({ apiFetch: vi.fn(), hostExtension: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: ADA.id } } }),
}))
vi.mock('shell/extensions', () => ({
  HostExtension: (props: unknown) => {
    hostExtension(props)
    return <section data-testid="host-meetings-panel" />
  },
}))

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CompanyDetailPage and meetings (AC-11.7)', () => {
  it('renders no Meetings section and no host extension', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({
          status: 200,
          body: { deal: ['welld_ch'], canErase: false, financials: true, managesAll: false },
        }),
        'GET /companies/c1': () => ({
          status: 200,
          body: {
            ...companySummary(),
            legalName: null,
            street: null,
            postalCode: null,
            website: null,
            notes: null,
            version: 1,
            createdAt: '2026-10-01T10:00:00.000Z',
          },
        }),
        'GET /contacts': () => ({ status: 200, body: page([]) }),
        'GET /deals': () => ({ status: 200, body: page([]) }),
        'GET /activities': () => ({ status: 200, body: page([]) }),
      }),
    )
    window.history.pushState(null, '', '/companies/c1')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    await screen.findByRole('heading', { level: 2, name: 'Acme SA' })
    // The page has settled once its own timeline is there.
    await screen.findByRole('heading', { level: 3, name: 'Activity' })

    expect(screen.queryByRole('heading', { name: 'Meetings' })).toBeNull()
    expect(screen.queryByTestId('crm-deal-meetings')).toBeNull()
    expect(screen.queryByTestId('host-meetings-panel')).toBeNull()
    expect(hostExtension).not.toHaveBeenCalled()
  })
})
