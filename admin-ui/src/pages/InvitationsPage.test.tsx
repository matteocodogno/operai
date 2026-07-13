/**
 * @vitest-environment jsdom
 *
 * Component tests for InvitationsPage — Screen U2 (T12, specs/006-user-invitations).
 *
 * Covers:
 *   (A) Loading / populated / empty / error list states (mirrors UsersPage.test.tsx).
 *   (B) Status filter + search re-fetch with the right query params.
 *   (C) InvitationStatusBadge renders per row; actionable (pending/expired)
 *       rows show Resend/Revoke, terminal (accepted/revoked) rows don't.
 *   (D) Invite modal: submit → createInvitation called; a 201 always closes
 *       the modal and the list re-fetches; 409 (AC-1.3/1.4) and 422 map onto
 *       inline modal errors, modal stays open.
 *   (E) The "Email failed" indicator renders when emailDelivery === 'failed'.
 *   (F) Resend: calls resendInvitation, patches the row in place, no confirm.
 *   (G) Revoke: opens ConfirmDeleteModal, confirms → revokeInvitation called,
 *       row patched to revoked in place.
 *
 * Strategy mirrors ../pages/UsersPage.test.tsx: `../lib/adminApi` mocked at
 * module level, keeping the real `ApiError` class via `importOriginal`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import InvitationsPage from './InvitationsPage'
import type { InvitationDetail, Paginated, Department, Role } from '../lib/adminApi'

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    listInvitations: vi.fn(),
    createInvitation: vi.fn(),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    listRoles: vi.fn(),
    listDepartments: vi.fn(),
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Test router harness — InvitationsPage renders UsersSubNav (<Link>s to
// `/users` and `/users/invitations`), which needs a real router context to
// resolve `to`. Mirrors ../pages/UsersPage.test.tsx's `renderUsersPage`.
// ---------------------------------------------------------------------------

function renderInvitationsPage() {
  window.history.pushState(null, '', '/users/invitations')
  const rootRoute = createRootRoute()
  const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/users', component: () => null })
  const invitationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/invitations',
    component: InvitationsPage,
  })
  const routeTree = rootRoute.addChildren([usersRoute, invitationsRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roleAccounting: Role = {
  id: 'role-1',
  name: 'accounting',
  description: null,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const deptFinance: Department = {
  id: 'dept-1',
  name: 'Finance',
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const pendingInvitation: InvitationDetail = {
  id: 'inv-1',
  email: 'alice@welld.ch',
  status: 'pending',
  roles: [{ id: 'role-1', name: 'accounting' }],
  departments: [],
  invitedBy: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@welld.ch' },
  invitedAt: '2026-07-13T10:00:00.000Z',
  expiresAt: '2099-01-01T10:00:00.000Z',
  acceptedAt: null,
  emailDelivery: 'sent',
}

const acceptedInvitation: InvitationDetail = {
  ...pendingInvitation,
  id: 'inv-2',
  email: 'bob@welld.ch',
  status: 'accepted',
  acceptedAt: '2026-07-14T09:00:00.000Z',
}

const failedEmailInvitation: InvitationDetail = {
  ...pendingInvitation,
  id: 'inv-3',
  email: 'carla@welld.ch',
  emailDelivery: 'failed',
}

const pageOf = (items: InvitationDetail[], total = items.length): Paginated<InvitationDetail> => ({
  items,
  page: 1,
  pageSize: 20,
  total,
})

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  vi.mocked(adminApi.listRoles).mockResolvedValue([roleAccounting])
  vi.mocked(adminApi.listDepartments).mockResolvedValue([deptFinance])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('InvitationsPage', () => {
  // (A) List states
  it('renders SkeletonListRows while listInvitations is in-flight', async () => {
    vi.mocked(adminApi.listInvitations).mockReturnValue(pendingPromise())

    renderInvitationsPage()

    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('renders the invitations table with status badges, roles/departments, inviter, and expiry', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation, acceptedInvitation]))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    expect(screen.getByText('alice@welld.ch')).not.toBeNull()
    expect(screen.getAllByText('accounting')).toHaveLength(2) // both fixtures share the same role
    expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2) // both fixtures share the same inviter
    expect(screen.getAllByTestId('invitation-status-badge')).toHaveLength(2)
  })

  it('renders "No invitations yet." with a repeated "+ Invite user" affordance when empty', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([], 0))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByTestId('invitations-empty-state')).not.toBeNull()
    })
    expect(screen.getByText('No invitations yet.')).not.toBeNull()
  })

  it('renders an ErrorBanner with Retry on a load failure', async () => {
    vi.mocked(adminApi.listInvitations)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Nope.' }))
      .mockResolvedValueOnce(pageOf([pendingInvitation]))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })
  })

  // (B) Filters
  it('re-fetches with status/q set and resets to page 1 when the filter/search changes', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation]))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    fireEvent.change(screen.getByTestId('invitations-status-filter'), { target: { value: 'revoked' } })
    await waitFor(() => {
      expect(adminApi.listInvitations).toHaveBeenLastCalledWith({
        q: undefined,
        status: 'revoked',
        page: 1,
        pageSize: 20,
      })
    })

    fireEvent.change(screen.getByTestId('invitations-search-input'), { target: { value: 'alice' } })
    await waitFor(() => {
      expect(adminApi.listInvitations).toHaveBeenLastCalledWith({
        q: 'alice',
        status: 'revoked',
        page: 1,
        pageSize: 20,
      })
    })
  })

  // (C) Actionable vs terminal rows
  it('shows Resend/Revoke for a pending row, nothing for an accepted row', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation, acceptedInvitation]))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    expect(screen.getByTestId('invitation-resend-inv-1')).not.toBeNull()
    expect(screen.getByTestId('invitation-revoke-inv-1')).not.toBeNull()
    expect(screen.queryByTestId('invitation-resend-inv-2')).toBeNull()
    expect(screen.queryByTestId('invitation-revoke-inv-2')).toBeNull()
  })

  // (E) Email-failed indicator
  it('renders a persistent "Email failed" indicator when emailDelivery is "failed"', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([failedEmailInvitation]))

    renderInvitationsPage()

    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    expect(screen.getByTestId('invitation-email-failed-inv-3').textContent).toContain('Email failed')
  })

  // (D) Invite modal
  describe('invite modal', () => {
    it('opens InviteUserModal, submits, and closes + re-fetches on 201 success (emailDelivery sent)', async () => {
      vi.mocked(adminApi.listInvitations)
        .mockResolvedValueOnce(pageOf([]))
        .mockResolvedValueOnce(pageOf([pendingInvitation], 1))
      vi.mocked(adminApi.createInvitation).mockResolvedValue(pendingInvitation)

      renderInvitationsPage()

      await waitFor(() => {
        expect(screen.getByTestId('invitations-invite-button').hasAttribute('disabled')).toBe(false)
      })

      fireEvent.click(screen.getByTestId('invitations-invite-button'))
      fireEvent.change(screen.getByTestId('invite-user-email'), { target: { value: 'alice@welld.ch' } })
      fireEvent.click(screen.getByTestId('invite-user-role-role-1'))
      fireEvent.click(screen.getByTestId('invite-user-submit'))

      await waitFor(() => {
        expect(adminApi.createInvitation).toHaveBeenCalledWith({
          email: 'alice@welld.ch',
          roleIds: ['role-1'],
          departmentIds: [],
        })
      })
      await waitFor(() => {
        expect(screen.queryByTestId('invite-user-modal')).toBeNull()
      })
      expect(screen.getByTestId('invitations-announcement').textContent).toBe('Invitation sent to alice@welld.ch')
      await waitFor(() => {
        expect(adminApi.listInvitations).toHaveBeenCalledTimes(2)
      })
    })

    it('closes the modal even when emailDelivery is "failed" (creation still succeeded)', async () => {
      vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([]))
      vi.mocked(adminApi.createInvitation).mockResolvedValue({ ...pendingInvitation, emailDelivery: 'failed' })

      renderInvitationsPage()

      await waitFor(() => {
        expect(screen.getByTestId('invitations-invite-button').hasAttribute('disabled')).toBe(false)
      })

      fireEvent.click(screen.getByTestId('invitations-invite-button'))
      fireEvent.change(screen.getByTestId('invite-user-email'), { target: { value: 'alice@welld.ch' } })
      fireEvent.click(screen.getByTestId('invite-user-submit'))

      await waitFor(() => {
        expect(screen.queryByTestId('invite-user-modal')).toBeNull()
      })
      expect(screen.getByTestId('invitations-announcement').textContent).toContain('email failed to send')
    })

    it('409 active-user conflict (AC-1.3) shows the fixed inline copy, modal stays open', async () => {
      vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([]))
      vi.mocked(adminApi.createInvitation).mockRejectedValue(
        new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'An active user already exists with email "alice@welld.ch"',
        }),
      )

      renderInvitationsPage()
      await waitFor(() => expect(screen.getByTestId('invitations-invite-button').hasAttribute('disabled')).toBe(false))

      fireEvent.click(screen.getByTestId('invitations-invite-button'))
      fireEvent.change(screen.getByTestId('invite-user-email'), { target: { value: 'alice@welld.ch' } })
      fireEvent.click(screen.getByTestId('invite-user-submit'))

      await waitFor(() => {
        expect(screen.getByTestId('invite-user-email-error').textContent).toContain(
          'use their user page to change roles or departments instead',
        )
      })
      expect(screen.getByTestId('invite-user-modal')).not.toBeNull()
    })

    it('409 live-pending-invite conflict (AC-1.4) shows the fixed inline copy', async () => {
      vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([]))
      vi.mocked(adminApi.createInvitation).mockRejectedValue(
        new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A pending invitation already exists for "alice@welld.ch" (id: inv-9)',
        }),
      )

      renderInvitationsPage()
      await waitFor(() => expect(screen.getByTestId('invitations-invite-button').hasAttribute('disabled')).toBe(false))

      fireEvent.click(screen.getByTestId('invitations-invite-button'))
      fireEvent.change(screen.getByTestId('invite-user-email'), { target: { value: 'alice@welld.ch' } })
      fireEvent.click(screen.getByTestId('invite-user-submit'))

      await waitFor(() => {
        expect(screen.getByTestId('invite-user-email-error').textContent).toContain(
          'resend it from the Invitations tab',
        )
      })
    })

    it('422 unknown role/department id shows a general error banner, modal stays open', async () => {
      vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([]))
      vi.mocked(adminApi.createInvitation).mockRejectedValue(
        new ApiError({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'Unknown role id(s): role-x' }),
      )

      renderInvitationsPage()
      await waitFor(() => expect(screen.getByTestId('invitations-invite-button').hasAttribute('disabled')).toBe(false))

      fireEvent.click(screen.getByTestId('invitations-invite-button'))
      fireEvent.change(screen.getByTestId('invite-user-email'), { target: { value: 'alice@welld.ch' } })
      fireEvent.click(screen.getByTestId('invite-user-submit'))

      await waitFor(() => {
        expect(screen.getByTestId('invite-user-general-error').textContent).toBe('Unknown role id(s): role-x')
      })
      expect(screen.getByTestId('invite-user-modal')).not.toBeNull()
    })
  })

  // (F) Resend
  it('Resend calls resendInvitation and patches the row in place (no confirm dialog)', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation]))
    const resent: InvitationDetail = { ...pendingInvitation, expiresAt: '2099-06-01T00:00:00.000Z' }
    vi.mocked(adminApi.resendInvitation).mockResolvedValue(resent)

    renderInvitationsPage()
    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('invitation-resend-inv-1'))

    expect(screen.queryByRole('alertdialog')).toBeNull() // never a confirm dialog

    await waitFor(() => {
      expect(adminApi.resendInvitation).toHaveBeenCalledWith('inv-1')
    })
    await waitFor(() => {
      expect(screen.getByTestId('invitations-announcement').textContent).toContain('New link sent to')
    })
  })

  // (G) Revoke
  it('Revoke opens a confirm dialog; confirming calls revokeInvitation and patches the row to revoked', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation]))
    const revoked: InvitationDetail = { ...pendingInvitation, status: 'revoked' }
    vi.mocked(adminApi.revokeInvitation).mockResolvedValue(revoked)

    renderInvitationsPage()
    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('invitation-revoke-inv-1'))

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Revoke the invitation to alice@welld.ch/)).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(adminApi.revokeInvitation).toHaveBeenCalledWith('inv-1')
    })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    // Row actions disappear now that it's terminal (revoked).
    expect(screen.queryByTestId('invitation-resend-inv-1')).toBeNull()
    expect(screen.queryByTestId('invitation-revoke-inv-1')).toBeNull()
  })

  it('a 422 race on revoke (already accepted/revoked) surfaces inline in the dialog, which stays open', async () => {
    vi.mocked(adminApi.listInvitations).mockResolvedValue(pageOf([pendingInvitation]))
    vi.mocked(adminApi.revokeInvitation).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'Already accepted' }),
    )

    renderInvitationsPage()
    await waitFor(() => {
      expect(screen.getByTestId('invitations-table')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('invitation-revoke-inv-1'))
    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(screen.getByTestId('confirm-delete-error')).not.toBeNull()
    })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })
})
