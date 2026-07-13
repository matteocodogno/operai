/**
 * InvitationsPage — Screen U2 (design.md "Invitations list", T12,
 * specs/006-user-invitations). Route `/users/invitations` (../router.tsx,
 * registered in T10 pointing at this same file — the T10 placeholder is
 * fully replaced here).
 *
 * Paginated, searchable (`?q=` on email, same pattern as UsersPage.tsx),
 * status-filterable (`GET /admin/invitations?status=&q=`) list, plus:
 *   - Modal N1 ("+ Invite user" — `InviteUserModal.tsx`): email + optional
 *     role/department checkboxes → `POST /admin/invitations`. A 201 ALWAYS
 *     closes the modal (the invitation itself succeeded) regardless of
 *     `emailDelivery` — a send failure is surfaced on the row afterward, not
 *     as a modal error (design.md F1 step 3). 409 (active user / live
 *     pending invite — AC-1.3/1.4) and 422 (unknown role/department id) map
 *     onto the modal's `emailError`/`generalError` slots.
 *   - Per-row Resend (pending/expired only — AC-3.4 hides it entirely for
 *     accepted/revoked rows, no confirm dialog: resend isn't destructive) and
 *     Revoke (pending/expired only, terminal — confirmed via the extended
 *     `ConfirmDeleteModal`).
 *   - `InvitationStatusBadge` + a persistent inline "Email failed" indicator
 *     next to Resend when `emailDelivery === 'failed'` (never a toast — the
 *     admin must not miss a failed send).
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err"),
 * same pattern as ../pages/UsersPage.tsx / ../pages/AuditPage.tsx. Built as
 * explicit Promise chains in effects, not async/await — see
 * ../pages/AuditPage.tsx's doc comment for the full rationale
 * (`react-hooks/set-state-in-effect` false positive).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as adminApi from '../lib/adminApi'
import type { Department, EffectiveInvitationStatus, InvitationDetail, Paginated, Role } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'
import UsersSubNav from '../components/UsersSubNav'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import InviteUserModal from '../components/InviteUserModal'
import InvitationStatusBadge from '../components/InvitationStatusBadge'

const PAGE_SIZE = 20

const STATUS_OPTIONS: { value: EffectiveInvitationStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
]

/** Rows past their terminal state have nothing left to do (design.md F1a step 4). */
const isActionable = (status: EffectiveInvitationStatus): boolean =>
  status === 'pending' || status === 'expired'

/** design.md F1a — "expires in Xh"/"expired Xh ago" restated in words, never a bare countdown. */
const formatExpiry = (invitation: InvitationDetail): string => {
  const expires = new Date(invitation.expiresAt)
  const absolute = expires.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  if (invitation.status === 'accepted' && invitation.acceptedAt) {
    return `Accepted ${new Date(invitation.acceptedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
  }
  if (invitation.status === 'revoked') {
    return `Revoked (was due ${absolute})`
  }
  if (invitation.status === 'expired') {
    return `Expired ${absolute}`
  }
  return `Expires ${absolute}`
}

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

/** Distinguishes AC-1.3 (active user) vs AC-1.4 (live pending invite) 409s —
 *  the backend contract carries only a `detail` string, no structured
 *  discriminant field (design.md Gaps #1), so this pattern-matches the
 *  fixed template text `invitations.routes.ts` actually emits. */
const inviteConflictMessageFor = (detail: string | undefined): string => {
  const lower = (detail ?? '').toLowerCase()
  if (lower.includes('active user')) {
    return 'This email already belongs to an existing user — use their user page to change roles or departments instead.'
  }
  if (lower.includes('pending invitation')) {
    return 'An invitation is already pending for this email — resend it from the Invitations tab instead of creating a new one.'
  }
  return detail ?? 'This email cannot be invited right now.'
}

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; result: Paginated<InvitationDetail> }
  | { status: 'error'; message: string }

type CatalogState = { roles: Role[]; departments: Department[] } | null

type InviteModalState =
  | { open: false }
  | {
      open: true
      email: string
      selectedRoleIds: Set<string>
      selectedDepartmentIds: Set<string>
      submitting: boolean
      emailError: string | null
      generalError: string | null
    }

type RevokeModalState =
  | { open: false }
  | { open: true; invitation: InvitationDetail; isRevoking: boolean; error: string | null }

export default function InvitationsPage() {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<EffectiveInvitationStatus | ''>('')
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<ListState>({ status: 'loading' })

  const [catalog, setCatalog] = useState<CatalogState>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const [inviteModal, setInviteModal] = useState<InviteModalState>({ open: false })
  const [revokeModal, setRevokeModal] = useState<RevokeModalState>({ open: false })
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // Fetch the current page/filters whenever they (or `reloadToken`) change.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() =>
        adminApi.listInvitations({
          q: query || undefined,
          status: statusFilter || undefined,
          page,
          pageSize: PAGE_SIZE,
        }),
      )
      .then((result) => {
        if (!cancelled) setState({ status: 'loaded', result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageFor(error, 'Could not load invitations.') })
      })

    return () => {
      cancelled = true
    }
  }, [query, statusFilter, page, reloadToken])

  // Fetch the role/department catalogs once — needed by InviteUserModal's
  // two checkbox fieldsets whenever it opens.
  useEffect(() => {
    let cancelled = false

    Promise.all([adminApi.listRoles(), adminApi.listDepartments()])
      .then(([roles, departments]) => {
        if (!cancelled) setCatalog({ roles, departments })
      })
      .catch((error: unknown) => {
        if (!cancelled) setCatalogError(errorMessageFor(error, 'Could not load roles/departments.'))
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    setPage(1)
  }, [])

  const handleStatusFilterChange = useCallback((value: EffectiveInvitationStatus | '') => {
    setStatusFilter(value)
    setPage(1)
  }, [])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  // ---------------------------------------------------------------------------
  // Modal N1 — Invite user (design.md F1)
  // ---------------------------------------------------------------------------

  const handleInviteOpen = useCallback(() => {
    setInviteModal({
      open: true,
      email: '',
      selectedRoleIds: new Set(),
      selectedDepartmentIds: new Set(),
      submitting: false,
      emailError: null,
      generalError: null,
    })
  }, [])

  const handleInviteCancel = useCallback(() => {
    setInviteModal({ open: false })
  }, [])

  const handleInviteEmailChange = useCallback((value: string) => {
    setInviteModal((prev) => (prev.open ? { ...prev, email: value, emailError: null } : prev))
  }, [])

  const handleToggleInviteRole = useCallback((id: string) => {
    setInviteModal((prev) => {
      if (!prev.open) return prev
      const next = new Set(prev.selectedRoleIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...prev, selectedRoleIds: next }
    })
  }, [])

  const handleToggleInviteDepartment = useCallback((id: string) => {
    setInviteModal((prev) => {
      if (!prev.open) return prev
      const next = new Set(prev.selectedDepartmentIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...prev, selectedDepartmentIds: next }
    })
  }, [])

  const handleInviteSubmit = useCallback(async () => {
    if (!inviteModal.open) return
    const { email, selectedRoleIds, selectedDepartmentIds } = inviteModal
    setInviteModal((prev) => (prev.open ? { ...prev, submitting: true, emailError: null, generalError: null } : prev))
    try {
      const created = await adminApi.createInvitation({
        email: email.trim(),
        roleIds: Array.from(selectedRoleIds),
        departmentIds: Array.from(selectedDepartmentIds),
      })
      // A 201 ALWAYS closes the modal (design.md F1 step 3) — the invitation
      // itself succeeded regardless of the email delivery outcome, which is
      // surfaced on the new row instead (never blocks/errors the modal).
      setInviteModal({ open: false })
      setAnnouncement(
        created.emailDelivery === 'sent'
          ? `Invitation sent to ${created.email}`
          : `Invitation created for ${created.email} — email failed to send`,
      )
      setReloadToken((token) => token + 1)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setInviteModal((prev) =>
          prev.open ? { ...prev, submitting: false, emailError: inviteConflictMessageFor(error.detail) } : prev,
        )
        return
      }
      if (error instanceof ApiError && error.status === 422) {
        setInviteModal((prev) =>
          prev.open
            ? { ...prev, submitting: false, generalError: error.detail ?? 'One or more selected roles/departments no longer exist.' }
            : prev,
        )
        return
      }
      setInviteModal((prev) =>
        prev.open ? { ...prev, submitting: false, generalError: errorMessageFor(error, 'Could not create the invitation. Try again.') } : prev,
      )
    }
  }, [inviteModal])

  // ---------------------------------------------------------------------------
  // Resend (design.md F1a step 2 — no confirm, not destructive)
  // ---------------------------------------------------------------------------

  const handleResend = useCallback(async (invitation: InvitationDetail) => {
    setResendingId(invitation.id)
    setRowError(null)
    try {
      const updated = await adminApi.resendInvitation(invitation.id)
      setState((prev) =>
        prev.status === 'loaded'
          ? { status: 'loaded', result: { ...prev.result, items: prev.result.items.map((i) => (i.id === updated.id ? updated : i)) } }
          : prev,
      )
      setAnnouncement(`New link sent to ${updated.email}, expires in 72 hours`)
    } catch (error) {
      setRowError({ id: invitation.id, message: errorMessageFor(error, 'Could not resend this invitation.') })
    } finally {
      setResendingId(null)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Revoke (Dialog N2 — design.md F1a step 3, terminal)
  // ---------------------------------------------------------------------------

  const handleRevokeRequest = useCallback((invitation: InvitationDetail) => {
    setRevokeModal({ open: true, invitation, isRevoking: false, error: null })
  }, [])

  const handleRevokeCancel = useCallback(() => {
    setRevokeModal({ open: false })
  }, [])

  const handleRevokeConfirm = useCallback(async () => {
    if (!revokeModal.open) return
    const { invitation } = revokeModal
    setRevokeModal((prev) => (prev.open ? { ...prev, isRevoking: true, error: null } : prev))
    try {
      const updated = await adminApi.revokeInvitation(invitation.id)
      setState((prev) =>
        prev.status === 'loaded'
          ? { status: 'loaded', result: { ...prev.result, items: prev.result.items.map((i) => (i.id === updated.id ? updated : i)) } }
          : prev,
      )
      setRevokeModal({ open: false })
      setAnnouncement(`Invitation to ${updated.email} revoked`)
    } catch (error) {
      // AC-1.10/1.11's race — the invitation became accepted/revoked between
      // page-load and click. Surfaced inline in the dialog so the admin sees
      // why it didn't apply (design.md F1a step 3), not assumed impossible.
      setRevokeModal((prev) =>
        prev.open ? { ...prev, isRevoking: false, error: errorMessageFor(error, 'Could not revoke this invitation.') } : prev,
      )
    }
  }, [revokeModal])

  const revokeBody = useMemo(() => {
    if (!revokeModal.open) return null
    return (
      <p>
        Revoke the invitation to {revokeModal.invitation.email}? Its link stops working immediately.
        This can&rsquo;t be undone — inviting them again requires sending a brand-new invitation.
      </p>
    )
  }, [revokeModal])

  return (
    <section aria-labelledby="admin-invitations-heading" data-testid="admin-invitations-page">
      {inviteModal.open && catalog && (
        <InviteUserModal
          email={inviteModal.email}
          onEmailChange={handleInviteEmailChange}
          roles={catalog.roles}
          departments={catalog.departments}
          selectedRoleIds={inviteModal.selectedRoleIds}
          onToggleRole={handleToggleInviteRole}
          selectedDepartmentIds={inviteModal.selectedDepartmentIds}
          onToggleDepartment={handleToggleInviteDepartment}
          onSubmit={() => void handleInviteSubmit()}
          onCancel={handleInviteCancel}
          submitting={inviteModal.submitting}
          emailError={inviteModal.emailError}
          generalError={inviteModal.generalError}
        />
      )}

      {revokeModal.open && (
        <ConfirmDeleteModal
          entityLabel="invitation"
          itemName={revokeModal.invitation.email}
          body={revokeBody}
          isDeleting={revokeModal.isRevoking}
          errorMessage={revokeModal.error}
          onConfirm={() => void handleRevokeConfirm()}
          onCancel={handleRevokeCancel}
        />
      )}

      <UsersSubNav />

      <div className="flex items-center justify-between gap-4">
        <h2 id="admin-invitations-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          Invitations
        </h2>
        <button
          type="button"
          onClick={handleInviteOpen}
          disabled={!catalog}
          data-testid="invitations-invite-button"
          className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'white', backgroundColor: 'var(--acc)' }}
        >
          + Invite user
        </button>
      </div>

      {catalogError && <ErrorBanner message={catalogError} />}

      <p aria-live="polite" className="sr-only" data-testid="invitations-announcement">
        {announcement}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div>
          <label htmlFor="invitations-search-input" className="sr-only">
            Search invitations by email
          </label>
          <input
            id="invitations-search-input"
            type="search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search by email…"
            data-testid="invitations-search-input"
            className="w-full sm:w-72 border rounded-md px-3 py-2 text-sm"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
          />
        </div>

        <div>
          <label htmlFor="invitations-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="invitations-status-filter"
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value as EffectiveInvitationStatus | '')}
            data-testid="invitations-status-filter"
            className="border rounded-md px-3 py-2 text-sm"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={5} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && state.result.total === 0 && (
          <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="invitations-empty-state">
            <p className="text-sm" style={{ color: 'var(--soft)' }}>
              {query || statusFilter ? 'No invitations match your search/filter.' : 'No invitations yet.'}
            </p>
            <button
              type="button"
              onClick={handleInviteOpen}
              disabled={!catalog}
              className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'white', backgroundColor: 'var(--acc)' }}
            >
              + Invite user
            </button>
          </div>
        )}

        {state.status === 'loaded' && state.result.total > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="invitations-table">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                    {['Email', 'State', 'Roles', 'Departments', 'Invited by', 'Expires'].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                        style={{ color: 'var(--soft)' }}
                      >
                        {label}
                      </th>
                    ))}
                    <th scope="col" className="py-1.5 px-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.result.items.map((invitation) => (
                    <tr
                      key={invitation.id}
                      data-testid={`invitation-row-${invitation.id}`}
                      className="border-b"
                      style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                    >
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {invitation.email}
                      </td>
                      <td className="py-1.5 px-2">
                        <InvitationStatusBadge status={invitation.status} />
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {invitation.roles.length > 0 ? invitation.roles.map((r) => r.name).join(', ') : '— none —'}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {invitation.departments.length > 0
                          ? invitation.departments.map((d) => d.name).join(', ')
                          : '— none —'}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {invitation.invitedBy?.name ?? invitation.invitedBy?.email ?? '—'}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {formatExpiry(invitation)}
                      </td>
                      <td className="py-1.5 px-2">
                        {isActionable(invitation.status) ? (
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void handleResend(invitation)}
                                disabled={resendingId === invitation.id}
                                aria-label={`Resend invitation to ${invitation.email}`}
                                data-testid={`invitation-resend-${invitation.id}`}
                                className="py-1 px-2.5 text-[11px] font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                                style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
                              >
                                {resendingId === invitation.id ? 'Resending…' : 'Resend'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRevokeRequest(invitation)}
                                aria-label={`Revoke invitation to ${invitation.email}`}
                                data-testid={`invitation-revoke-${invitation.id}`}
                                className="py-1 px-2.5 text-[11px] font-medium border transition-opacity hover:opacity-80"
                                style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
                              >
                                Revoke
                              </button>
                            </div>
                            {invitation.emailDelivery === 'failed' && (
                              <span
                                data-testid={`invitation-email-failed-${invitation.id}`}
                                className="text-[10px]"
                                style={{ color: 'var(--org)' }}
                              >
                                ⚠<span className="sr-only"> — </span>Email failed
                              </span>
                            )}
                            {rowError?.id === invitation.id && (
                              <p role="alert" className="text-[10px]" style={{ color: 'var(--red)' }}>
                                {rowError.message}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="sr-only">No actions available</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={state.result.total} onPageChange={setPage} />
          </>
        )}
      </div>
    </section>
  )
}
