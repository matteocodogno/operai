/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchEmployeeGroupList (T10, specs/008-refund-monthly-
 * processing/tasks.md). Covers both modes:
 *   - `preview`: name/email, request count, per-currency subtotals — no
 *     per-request rows/links (a dry-run candidate set has nothing persisted
 *     yet to link to).
 *   - `detail`: the same grouping, PLUS real request rows (id status badge,
 *     per-currency subtotal) that link to `/refund/review/$id`.
 *
 * `detail` mode uses a real, minimal TanStack Router harness (mirrors
 * RefundShell.test.tsx's technique exactly) since `Link` only resolves a
 * real `href` inside a router context.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import BatchEmployeeGroupList from './BatchEmployeeGroupList'
import type { CandidateEmployeeGroup, BatchEmployeeGroup } from '../lib/batchesApi'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

const previewGroup: CandidateEmployeeGroup = {
  owner: { userId: 'u1', email: 'alice@welld.ch', name: 'Alice' },
  requestIds: ['req-1', 'req-2'],
  subtotals: [
    { currency: 'EUR', approvedCents: 910 },
    { currency: 'CHF', approvedCents: 5000 },
  ],
}

const previewGroupNoName: CandidateEmployeeGroup = {
  owner: { userId: 'u2', email: 'bob@welld.ch', name: null },
  requestIds: ['req-3'],
  subtotals: [{ currency: 'EUR', approvedCents: 100 }],
}

const detailGroup: BatchEmployeeGroup = {
  owner: { userId: 'u1', email: 'alice@welld.ch', name: 'Alice' },
  requests: [
    { id: 'req-1', status: 'approved', subtotals: [{ currency: 'EUR', approvedCents: 910 }] },
    { id: 'req-2', status: 'paid', subtotals: [{ currency: 'CHF', approvedCents: 5000 }] },
  ],
}

async function renderDetailAt(groups: readonly BatchEmployeeGroup[]) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <BatchEmployeeGroupList mode="detail" groups={groups} />,
  })
  const reviewDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review/$id',
    component: () => <p>review detail</p>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, reviewDetailRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByTestId('batch-employee-group-list')
  return utils
}

describe('BatchEmployeeGroupList — preview mode', () => {
  it('renders nothing for an empty group list', () => {
    const { container } = render(<BatchEmployeeGroupList mode="preview" groups={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one section per employee — name, request count, per-currency subtotals', () => {
    render(<BatchEmployeeGroupList mode="preview" groups={[previewGroup]} />)

    const group = screen.getByTestId('batch-employee-group-u1')
    expect(group.textContent).toContain('Alice')
    expect(screen.getByTestId('batch-employee-group-u1-count').textContent).toBe('2 requests')
    expect(group.querySelector('[data-testid="batch-subtotals-panel-card-EUR"]')).not.toBeNull()
    expect(group.querySelector('[data-testid="batch-subtotals-panel-card-CHF"]')).not.toBeNull()
  })

  it('omits per-request links in preview mode (a dry run has nothing persisted to link to)', () => {
    render(<BatchEmployeeGroupList mode="preview" groups={[previewGroup]} />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('falls back to the owner email when name is null', () => {
    render(<BatchEmployeeGroupList mode="preview" groups={[previewGroupNoName]} />)
    expect(screen.getByTestId('batch-employee-group-u2').textContent).toContain('bob@welld.ch')
  })
})

describe('BatchEmployeeGroupList — detail mode', () => {
  it('renders nothing for an empty group list', () => {
    const { container } = render(<BatchEmployeeGroupList mode="detail" groups={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the group heading, request count, and an aggregated per-currency subtotal', async () => {
    await renderDetailAt([detailGroup])

    const group = screen.getByTestId('batch-employee-group-u1')
    expect(group.textContent).toContain('Alice')
    expect(screen.getByTestId('batch-employee-group-u1-count').textContent).toBe('2 requests')
    expect(group.querySelector('[data-testid="batch-subtotals-panel-card-EUR"]')).not.toBeNull()
    expect(group.querySelector('[data-testid="batch-subtotals-panel-card-CHF"]')).not.toBeNull()
  })

  it('renders one linked row per request, each carrying its own RequestStatusBadge', async () => {
    await renderDetailAt([detailGroup])

    const row1 = screen.getByTestId('batch-employee-group-u1-request-req-1')
    expect(row1.tagName).toBe('A')
    expect(row1.getAttribute('href')).toBe('/review/req-1')
    expect(row1.querySelector('[data-testid="request-status-badge"]')?.textContent).toBe('✓Approved')

    const row2 = screen.getByTestId('batch-employee-group-u1-request-req-2')
    expect(row2.getAttribute('href')).toBe('/review/req-2')
    expect(row2.querySelector('[data-testid="request-status-badge"]')?.textContent).toBe('◆Paid')
  })

  it('gives each request row a full, disambiguating aria-label (employee, status, amount)', async () => {
    await renderDetailAt([detailGroup])

    const row1 = screen.getByTestId('batch-employee-group-u1-request-req-1')
    expect(row1.getAttribute('aria-label')).toBe('Open Alice’s request, Approved, 9,10 €')
  })
})
