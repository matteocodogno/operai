/**
 * UsersPage — Screen C1 (design.md "Users list — search+pagination", T20,
 * specs/004-auth-roles-permissions/tasks.md). Replaces T14's placeholder.
 *
 * A search input (name/email → `?q=`, design.md's plan-drift-fix) drives a
 * paginated table (`adminApi.listUsers({ q, page, pageSize })`, plan.md
 * `GET /admin/users`) rendered with the shared Pagination primitive (T15) —
 * the `{ items, page, pageSize, total }` envelope. Columns: Name (links to
 * Screen C2), Email, Entity, Job title, and role/department chip counts
 * (design.md "Key elements"). Selecting a row navigates to
 * `/users/$id` (Screen C2, ./UserDetail.tsx).
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err"),
 * same pattern as ../pages/AuditPage.tsx (T21):
 *   L — SkeletonListRows while the current page loads.
 *   E — "No users match your search." (design.md: search-scoped empty state,
 *       distinct from a true zero-users case which can't happen post-sign-in
 *       since every signed-in user gets `employee`, AC-6.3).
 *   P — the table + Pagination control.
 *   Err — ErrorBanner + Retry, re-running the same page/query.
 *
 * Changing the search query resets to page 1 (a stale page number against a
 * new, possibly-shorter result set would otherwise strand the user past the
 * last page).
 *
 * Built as an explicit Promise chain in the fetch effect, not async/await —
 * see ../pages/AuditPage.tsx's doc comment for the full rationale
 * (`react-hooks/set-state-in-effect` false positive on an async function
 * that calls a state setter after an `await`).
 *
 * --- T10, specs/006-user-invitations (design.md Screen U1) ---
 * Gains: `UsersSubNav` ("Active users" | "Invitations") above the search
 * input; a per-row soft-delete action (`DELETE /admin/users/:id`, plan.md)
 * behind `ConfirmDeleteModal`'s extended `body` prop. The acting admin's own
 * row is **disabled-with-explanation** — `aria-disabled` + `title` + a
 * visually-hidden explanation, mirroring `RolesPage.tsx`'s System-role
 * Delete-button convention exactly (design.md: "disabled + explained", not
 * silent omission) — never native `disabled`, so the control stays
 * perceivable/focusable to assistive tech. Self-identity comes from
 * `shell/session`'s `useSession()` (already federated, ADR-0001/0006 — no
 * new endpoint). A `422` (the last-admin guard, AC-5.5 — self-delete AC-5.6
 * is UI-unreachable since the button is disabled, but defended anyway)
 * surfaces via `GuardrailDialog`, the same "genuinely blocked, nothing to
 * retry" shape `UserDetail.tsx` already uses for the identical guard on
 * roles/departments saves.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useSession } from 'shell/session'
import * as adminApi from '../lib/adminApi'
import type { Paginated, UserSummary } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'
import UsersSubNav from '../components/UsersSubNav'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import GuardrailDialog from '../components/GuardrailDialog'

const PAGE_SIZE = 20

/** design.md F3 — fixed acknowledgement copy for the last-admin delete guard, adapted from UserDetail.tsx's LAST_ADMIN_MESSAGE. */
const LAST_ADMIN_DELETE_MESSAGE =
  'This is the last administrator — deleting this user would leave nobody able to manage access. Assign another admin first.'

const formatEntity = (entity: UserSummary['entity']): string => {
  if (entity === 'welld_ch') return 'WellD CH'
  if (entity === 'welld_it') return 'WellD Italia'
  return '—'
}

type UsersState =
  | { status: 'loading' }
  | { status: 'loaded'; result: Paginated<UserSummary> }
  | { status: 'error'; message: string }

type DeleteModalState =
  | { open: false }
  | { open: true; user: UserSummary; isDeleting: boolean; error: string | null }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load users.'
}

export default function UsersPage() {
  const session = useSession()
  const currentUserId = session.data?.user?.id

  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<UsersState>({ status: 'loading' })
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({ open: false })
  const [guardrailMessage, setGuardrailMessage] = useState<string | null>(null)

  // Fetches the current page/query whenever they (or `reloadToken`, bumped by
  // "Retry" or a successful delete) change. See ../pages/AuditPage.tsx's doc
  // comment for why this is a Promise chain rather than an async/await helper.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.listUsers({ q: query || undefined, page, pageSize: PAGE_SIZE }))
      .then((result) => {
        if (!cancelled) setState({ status: 'loaded', result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageFor(error) })
      })

    return () => {
      cancelled = true
    }
  }, [query, page, reloadToken])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    setPage(1)
  }, [])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  // ---------------------------------------------------------------------------
  // Single-row soft-delete (Dialog N2 — design.md F3, T10 specs/006-user-invitations)
  // ---------------------------------------------------------------------------

  const handleDeleteRequest = useCallback(
    (user: UserSummary) => {
      if (user.id === currentUserId) return // defensive — the button is already disabled for this row
      setDeleteModal({ open: true, user, isDeleting: false, error: null })
    },
    [currentUserId],
  )

  const handleDeleteCancel = useCallback(() => {
    setDeleteModal({ open: false })
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModal.open) return
    const { user } = deleteModal
    setDeleteModal((prev) => (prev.open ? { ...prev, isDeleting: true, error: null } : prev))
    try {
      await adminApi.deleteUser(user.id)
      setDeleteModal({ open: false })
      setReloadToken((token) => token + 1)
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        // AC-5.5/5.6 — genuinely blocked, nothing to retry from this dialog.
        setDeleteModal({ open: false })
        setGuardrailMessage(LAST_ADMIN_DELETE_MESSAGE)
        return
      }
      setDeleteModal((prev) =>
        prev.open ? { ...prev, isDeleting: false, error: errorMessageFor(error) } : prev,
      )
    }
  }, [deleteModal])

  const handleAcknowledgeGuardrail = useCallback(() => {
    setGuardrailMessage(null)
  }, [])

  const deleteBody = useMemo(() => {
    if (!deleteModal.open) return null
    const identity = deleteModal.user.name ?? deleteModal.user.email
    return (
      <p>
        Delete {identity}? They will immediately lose all access to Operai — every active session
        ends and they can no longer sign in. Their record and data are retained for audit, but
        there is no undo: regaining access requires a brand-new invitation.
      </p>
    )
  }, [deleteModal])

  return (
    <section aria-labelledby="admin-users-heading" data-testid="admin-users-page">
      {deleteModal.open && (
        <ConfirmDeleteModal
          entityLabel="user"
          itemName={deleteModal.user.email}
          body={deleteBody}
          isDeleting={deleteModal.isDeleting}
          errorMessage={deleteModal.error}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={handleDeleteCancel}
        />
      )}

      {guardrailMessage && (
        <GuardrailDialog
          title="Can't delete this user"
          message={guardrailMessage}
          onAcknowledge={handleAcknowledgeGuardrail}
        />
      )}

      <UsersSubNav />

      <h2 id="admin-users-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Users
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        Browse every signed-in user, then open one to set attributes and assign roles or
        departments.
      </p>

      <div className="mt-4">
        <label htmlFor="users-search-input" className="sr-only">
          Search users by name or email
        </label>
        <input
          id="users-search-input"
          type="search"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search by name or email…"
          data-testid="users-search-input"
          className="w-full sm:w-80 border rounded-md px-3 py-2 text-sm"
          style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
        />
      </div>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={5} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && state.result.total === 0 && (
          <p
            className="text-sm py-6 text-center"
            style={{ color: 'var(--soft)' }}
            data-testid="users-empty-state"
          >
            No users match your search.
          </p>
        )}

        {state.status === 'loaded' && state.result.total > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="users-table">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                    {['Name', 'Email', 'Entity', 'Job title', 'Roles', 'Departments'].map((label) => (
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
                  {state.result.items.map((user) => {
                    const isSelf = user.id === currentUserId
                    return (
                      <tr
                        key={user.id}
                        className="border-b"
                        style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                      >
                        <td className="py-1.5 px-2">
                          <Link
                            to="/users/$id"
                            params={{ id: user.id }}
                            data-testid={`user-row-${user.id}`}
                            className="font-medium transition-opacity hover:opacity-80"
                            style={{ color: 'var(--acc)' }}
                          >
                            {user.name ?? user.email}
                          </Link>
                        </td>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                          {user.email}
                        </td>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                          {formatEntity(user.entity)}
                        </td>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                          {user.jobTitle ?? '—'}
                        </td>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                          {user.roleCount}
                        </td>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                          {user.departmentCount}
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center justify-end">
                            <button
                              type="button"
                              aria-disabled={isSelf}
                              title={isSelf ? "You can't delete your own account" : undefined}
                              onClick={() => handleDeleteRequest(user)}
                              data-testid={`user-delete-${user.id}`}
                              className="py-1 px-2.5 text-[11px] font-medium border transition-opacity hover:opacity-80 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
                              style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
                            >
                              Delete
                              {isSelf && <span className="sr-only"> — You can't delete your own account</span>}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
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
