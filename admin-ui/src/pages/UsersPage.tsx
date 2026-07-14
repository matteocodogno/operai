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
 *
 * --- T11, specs/006-user-invitations (design.md Screen U1 / Panel N3) ---
 * Gains: a leftmost checkbox column with a tri-state "select all on this
 * page" header checkbox (`role="region" aria-label="Bulk actions"` action bar
 * once ≥1 row is checked, `POST /admin/users/delete`), and a persistent
 * `BulkDeleteResultPanel` (never a toast — AC-6.3) listing every skipped user
 * with the server's own verbatim reason. Selection is scoped to the current
 * page only (design.md F4: no cross-page selection) — it resets whenever the
 * query or page changes. The acting admin's own row checkbox is disabled
 * (never selectable), matching the row Delete button's own disabled-for-self
 * treatment (T10) — it therefore never needs the server's defense-in-depth
 * self-skip either, though the bulk endpoint still defends against it.
 *
 * --- Design-fidelity gap closed post-T12 (design.md Screen U1, specs/006-user-invitations) ---
 * Gains: a "+ Invite user" button next to the heading — Screen U1's own entry
 * point into F1, parallel to (and independent of) the Invitations tab's
 * identical button (T12, ./InvitationsPage.tsx). Opens the SAME
 * `InviteUserModal` component and calls the SAME `adminApi.createInvitation`
 * + `inviteConflictMessageFor` 409-mapping helper (../lib/inviteConflict.ts,
 * extracted from InvitationsPage.tsx so neither screen re-implements the
 * 409/422 handling) — only the modal's local state/wiring is page-owned, same
 * as this file's row-delete wiring already duplicates `ConfirmDeleteModal`
 * plumbing independently from `UserDetail.tsx`'s. On success, the modal
 * closes and an `aria-live="polite"` confirmation announces the outcome
 * (design.md F1 step 3) — the new invitation itself is visible on the
 * Invitations tab on next visit; this screen has no reason to re-fetch users.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { Link } from '@tanstack/react-router'
import { useSession } from 'shell/session'
import * as adminApi from '../lib/adminApi'
import type { Department, Paginated, Role, UserSummary } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import { inviteConflictMessageFor } from '../lib/inviteConflict'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'
import UsersSubNav from '../components/UsersSubNav'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import GuardrailDialog from '../components/GuardrailDialog'
import BulkDeleteResultPanel from '../components/BulkDeleteResultPanel'
import type { BulkDeleteSkipItem } from '../components/BulkDeleteResultPanel'
import InviteUserModal from '../components/InviteUserModal'

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

type BulkDeleteModalState =
  | { open: false }
  | { open: true; users: UserSummary[]; isDeleting: boolean; error: string | null }

type BulkResultState = {
  deletedCount: number
  totalCount: number
  skipped: BulkDeleteSkipItem[]
} | null

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

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load users.'
}

/**
 * SelectAllCheckbox — the header "select all on this page" control (T11).
 * A true tri-state checkbox: HTML has no declarative `aria-checked="mixed"`
 * for a native checkbox's indeterminate visual, so the DOM `.indeterminate`
 * property is set imperatively via a ref (design.md "Accessibility —
 * Bulk-select": "the indeterminate state is exposed to AT via the checkbox's
 * own `indeterminate` property"). Local to this file — not a shared
 * top-level component, since nothing else in admin-ui needs a tri-state
 * checkbox yet.
 */
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  ...rest
}: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'>) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} {...rest} />
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

  // --- Bulk select + bulk delete (T11) ---
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [bulkDeleteModal, setBulkDeleteModal] = useState<BulkDeleteModalState>({ open: false })
  const [bulkResult, setBulkResult] = useState<BulkResultState>(null)

  // --- "+ Invite user" (Screen U1's own entry point into F1 — closed post-T12) ---
  const [catalog, setCatalog] = useState<CatalogState>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [inviteModal, setInviteModal] = useState<InviteModalState>({ open: false })
  const [inviteAnnouncement, setInviteAnnouncement] = useState('')

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

  // Selection is scoped to the current page only (design.md F4) — reset it
  // whenever the query or page changes, so a stale id set from a previous
  // page's rows never lingers into a POST /admin/users/delete call.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [query, page])

  // ---------------------------------------------------------------------------
  // "+ Invite user" (Modal N1 reused — design.md Screen U1 / F1)
  // ---------------------------------------------------------------------------

  // Fetch the role/department catalogs once — needed by InviteUserModal's two
  // checkbox fieldsets whenever it opens (mirrors InvitationsPage.tsx's own
  // identical fetch).
  useEffect(() => {
    let cancelled = false

    Promise.all([adminApi.listRoles(), adminApi.listDepartments()])
      .then(([roles, departments]) => {
        if (!cancelled) setCatalog({ roles, departments })
      })
      .catch((error: unknown) => {
        if (!cancelled) setCatalogError(errorMessageFor(error))
      })

    return () => {
      cancelled = true
    }
  }, [])

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

  const handleToggleInviteRole = useCallback((roleId: string) => {
    setInviteModal((prev) => {
      if (!prev.open) return prev
      const next = new Set(prev.selectedRoleIds)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return { ...prev, selectedRoleIds: next }
    })
  }, [])

  const handleToggleInviteDepartment = useCallback((departmentId: string) => {
    setInviteModal((prev) => {
      if (!prev.open) return prev
      const next = new Set(prev.selectedDepartmentIds)
      if (next.has(departmentId)) next.delete(departmentId)
      else next.add(departmentId)
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
      // announced here instead (the row itself lives on the Invitations tab,
      // not this screen).
      setInviteModal({ open: false })
      setInviteAnnouncement(
        created.emailDelivery === 'sent'
          ? `Invitation sent to ${created.email}`
          : `Invitation created for ${created.email} — email failed to send`,
      )
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
            ? {
                ...prev,
                submitting: false,
                generalError: error.detail ?? 'One or more selected roles/departments no longer exist.',
              }
            : prev,
        )
        return
      }
      setInviteModal((prev) => (prev.open ? { ...prev, submitting: false, generalError: errorMessageFor(error) } : prev))
    }
  }, [inviteModal])

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

  // ---------------------------------------------------------------------------
  // Bulk soft-delete (Panel N3 — design.md F4, T11 specs/006-user-invitations)
  // ---------------------------------------------------------------------------

  const selectableUsers = useMemo(
    () => (state.status === 'loaded' ? state.result.items.filter((u) => u.id !== currentUserId) : []),
    [state, currentUserId],
  )

  const allSelectableSelected =
    selectableUsers.length > 0 && selectableUsers.every((u) => selectedIds.has(u.id))
  const someSelectableSelected = selectableUsers.some((u) => selectedIds.has(u.id))

  const handleToggleRow = useCallback((userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }, [])

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = selectableUsers.length > 0 && selectableUsers.every((u) => prev.has(u.id))
      return allSelected ? new Set() : new Set(selectableUsers.map((u) => u.id))
    })
  }, [selectableUsers])

  const handleBulkDeleteRequest = useCallback(() => {
    if (state.status !== 'loaded') return
    const selected = state.result.items.filter((u) => selectedIds.has(u.id))
    if (selected.length === 0) return
    setBulkDeleteModal({ open: true, users: selected, isDeleting: false, error: null })
  }, [state, selectedIds])

  const handleBulkDeleteCancel = useCallback(() => {
    setBulkDeleteModal({ open: false })
  }, [])

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (!bulkDeleteModal.open) return
    const { users } = bulkDeleteModal
    setBulkDeleteModal((prev) => (prev.open ? { ...prev, isDeleting: true, error: null } : prev))
    try {
      const result = await adminApi.bulkDeleteUsers(users.map((u) => u.id))
      const labelFor = new Map(users.map((u) => [u.id, u.name ?? u.email]))
      setBulkDeleteModal({ open: false })
      setBulkResult({
        deletedCount: result.deleted.length,
        totalCount: users.length,
        skipped: result.skipped.map((s) => ({
          userId: s.userId,
          label: labelFor.get(s.userId) ?? s.userId,
          reason: s.reason,
        })),
      })
      setSelectedIds(new Set())
      setReloadToken((token) => token + 1)
    } catch (error) {
      setBulkDeleteModal((prev) =>
        prev.open ? { ...prev, isDeleting: false, error: errorMessageFor(error) } : prev,
      )
    }
  }, [bulkDeleteModal])

  const handleDismissBulkResult = useCallback(() => {
    setBulkResult(null)
  }, [])

  const bulkDeleteBody = useMemo(() => {
    if (!bulkDeleteModal.open) return null
    const { users } = bulkDeleteModal
    return (
      <>
        <p>
          Delete {users.length} selected users? Anyone in this selection who is the last remaining
          administrator, or your own account, is automatically skipped — everyone else in the
          batch is still deleted.
        </p>
        <ul className="mt-2 max-h-32 overflow-y-auto text-xs" style={{ color: 'var(--soft)' }}>
          {users.map((u) => (
            <li key={u.id}>{u.email}</li>
          ))}
        </ul>
      </>
    )
  }, [bulkDeleteModal])

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

      {bulkDeleteModal.open && (
        <ConfirmDeleteModal
          entityLabel={`${bulkDeleteModal.users.length} users`}
          itemName={`${bulkDeleteModal.users.length} users`}
          body={bulkDeleteBody}
          isDeleting={bulkDeleteModal.isDeleting}
          errorMessage={bulkDeleteModal.error}
          onConfirm={() => void handleBulkDeleteConfirm()}
          onCancel={handleBulkDeleteCancel}
        />
      )}

      {guardrailMessage && (
        <GuardrailDialog
          title="Can't delete this user"
          message={guardrailMessage}
          onAcknowledge={handleAcknowledgeGuardrail}
        />
      )}

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

      <UsersSubNav />

      <div className="flex items-center justify-between gap-4">
        <h2 id="admin-users-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          Users
        </h2>
        <button
          type="button"
          onClick={handleInviteOpen}
          disabled={!catalog}
          data-testid="users-invite-button"
          className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'white', backgroundColor: 'var(--acc)' }}
        >
          + Invite user
        </button>
      </div>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        Browse every signed-in user, then open one to set attributes and assign roles or
        departments.
      </p>

      {catalogError && <ErrorBanner message={catalogError} />}

      <p aria-live="polite" className="sr-only" data-testid="users-invite-announcement">
        {inviteAnnouncement}
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
        {bulkResult && (
          <BulkDeleteResultPanel
            deletedCount={bulkResult.deletedCount}
            totalCount={bulkResult.totalCount}
            skipped={bulkResult.skipped}
            onDismiss={handleDismissBulkResult}
          />
        )}

        {selectedIds.size > 0 && (
          <div
            role="region"
            aria-label="Bulk actions"
            data-testid="bulk-action-bar"
            className="mb-3 flex items-center justify-between gap-4 px-3 py-2 border rounded-md"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
          >
            <p aria-live="polite" className="text-sm" style={{ color: 'var(--text)' }} data-testid="bulk-action-count">
              {selectedIds.size} {selectedIds.size === 1 ? 'user' : 'users'} selected
            </p>
            <button
              type="button"
              onClick={handleBulkDeleteRequest}
              data-testid="bulk-delete-button"
              className="text-sm font-medium py-1.5 px-3 border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
            >
              Delete selected ({selectedIds.size})
            </button>
          </div>
        )}

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
                    <th scope="col" className="py-1.5 px-2">
                      <span className="sr-only">Select all</span>
                      <SelectAllCheckbox
                        checked={allSelectableSelected}
                        indeterminate={someSelectableSelected && !allSelectableSelected}
                        onChange={handleToggleSelectAll}
                        disabled={selectableUsers.length === 0}
                        aria-label="Select all users on this page"
                        data-testid="users-select-all"
                      />
                    </th>
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
                          <input
                            type="checkbox"
                            checked={selectedIds.has(user.id)}
                            disabled={isSelf}
                            onChange={() => handleToggleRow(user.id)}
                            aria-label={`Select ${user.name ?? user.email}`}
                            data-testid={`user-checkbox-${user.id}`}
                          />
                        </td>
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
