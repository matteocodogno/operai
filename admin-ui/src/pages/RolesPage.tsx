import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type { Role } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import CreateRoleModal from '../components/CreateRoleModal'
import SystemBadge from '../components/SystemBadge'
import PermissionDenied from '../components/PermissionDenied'

/**
 * RolesPage — Screen A1 (Roles list) + Modal M1 (Create role) — T17,
 * specs/004-auth-roles-permissions/tasks.md, refs AC-1.1, AC-2.4.
 *
 * Replaces T14's placeholder with the real screen: a table (Name /
 * Description / System badge / rule count / Edit-Delete — design.md's "Key
 * elements" for Screen A1), sourced from `adminApi.listRoles()` (plan.md
 * `GET /admin/roles`). "+ New role" opens Modal M1 (name+description) →
 * `POST /admin/roles` → navigates to Screen A2 (the role editor, T18) for
 * the new id (design.md F2 step 2). System roles get a `SystemBadge` and a
 * guardrailed, non-native-disabled Delete action (design.md: "disabled
 * Delete button with title='System roles can't be deleted'" — implemented
 * via `aria-disabled` + visually-hidden text rather than the native
 * `disabled` attribute, mirroring `Pagination.tsx`'s bounds-guard and
 * design.md's explicit "Guardrail-blocked save … inline path" a11y note:
 * "not just a bare CSS disabled state with a mouse-only tooltip").
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err",
 * same shape as AuditPage.tsx/T21):
 *   L    — SkeletonListRows while the list loads.
 *   E    — "No roles yet" + "+ New role" (design.md: "never a dead end" —
 *          this state shouldn't realistically occur post-bootstrap, T11,
 *          but is still designed defensively).
 *   P    — the table + "+ New role".
 *   Err  — ErrorBanner + Retry (mirrors EstimatesPage's list-error pattern).
 *   403  — PermissionDenied in place of the table (design.md Screen A1:
 *          "only reachable per F7's race-condition path").
 *
 * Fetch pattern: the initial list load is an explicit Promise chain rather
 * than an async/await helper invoked from `useEffect` — an async function
 * that calls a state setter anywhere in its body (even after an `await`)
 * trips `eslint-plugin-react-hooks@7.1.1`'s `react-hooks/set-state-in-effect`
 * static analysis, because await-continuations stay within the same
 * function body the rule inspects. Routing each state transition through
 * its own `.then()`/`.catch()` closure (AuditPage.tsx's precedent, T21)
 * keeps each setState call in its own function boundary, which the rule
 * doesn't need to trace through, while the runtime behavior — set loading,
 * fetch, then set loaded/error/forbidden, ignoring a stale response after
 * unmount — is identical to the equivalent async/await version.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; roles: Role[] }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

type CreateModalState =
  | { open: false }
  | {
      open: true
      name: string
      description: string
      submitting: boolean
      nameError: string | null
      generalError: string | null
    }

type DeleteModalState =
  | { open: false }
  | { open: true; role: Role; isDeleting: boolean; error: string | null }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load the roles list.'
}

export default function RolesPage() {
  const navigate = useNavigate()
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [createModal, setCreateModal] = useState<CreateModalState>({ open: false })
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({ open: false })

  // See the module doc comment above re: why this is a Promise chain, not
  // an async function called from the effect (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setListState({ status: 'loading' })
      })
      .then(() => adminApi.listRoles())
      .then((roles) => {
        if (!cancelled) setListState({ status: 'loaded', roles })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setListState({ status: 'forbidden' })
        } else {
          setListState({ status: 'error', message: errorMessageFor(error) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const handleOpenEditor = useCallback(
    (id: string) => {
      navigate({ to: '/roles/$id', params: { id } })
    },
    [navigate],
  )

  // ---------------------------------------------------------------------------
  // Create role (Modal M1 — design.md F2 step 2)
  // ---------------------------------------------------------------------------

  const handleCreateOpen = useCallback(() => {
    setCreateModal({ open: true, name: '', description: '', submitting: false, nameError: null, generalError: null })
  }, [])

  const handleCreateCancel = useCallback(() => {
    setCreateModal({ open: false })
  }, [])

  const handleCreateNameChange = useCallback((name: string) => {
    setCreateModal((prev) => (prev.open ? { ...prev, name, nameError: null } : prev))
  }, [])

  const handleCreateDescriptionChange = useCallback((description: string) => {
    setCreateModal((prev) => (prev.open ? { ...prev, description } : prev))
  }, [])

  const handleCreateSubmit = useCallback(async () => {
    if (!createModal.open) return
    const { name, description } = createModal
    setCreateModal((prev) => (prev.open ? { ...prev, submitting: true, nameError: null, generalError: null } : prev))
    try {
      const role = await adminApi.createRole({ name: name.trim(), description: description.trim() || null })
      setCreateModal({ open: false })
      navigate({ to: '/roles/$id', params: { id: role.id } })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setCreateModal((prev) =>
          prev.open ? { ...prev, submitting: false, nameError: error.detail ?? 'A role with this name already exists.' } : prev,
        )
      } else {
        setCreateModal((prev) =>
          prev.open ? { ...prev, submitting: false, generalError: 'Could not create the role. Try again.' } : prev,
        )
      }
    }
  }, [createModal, navigate])

  // ---------------------------------------------------------------------------
  // Delete role (Dialog D1 — design.md F2 step 5)
  // ---------------------------------------------------------------------------

  const handleDeleteRequest = useCallback((role: Role) => {
    if (role.isSystem) return
    setDeleteModal({ open: true, role, isDeleting: false, error: null })
  }, [])

  const handleDeleteCancel = useCallback(() => {
    setDeleteModal({ open: false })
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModal.open) return
    const { role } = deleteModal
    setDeleteModal((prev) => (prev.open ? { ...prev, isDeleting: true, error: null } : prev))
    try {
      await adminApi.deleteRole(role.id)
      setDeleteModal({ open: false })
      setReloadToken((token) => token + 1)
    } catch (error) {
      setDeleteModal((prev) =>
        prev.open
          ? {
              ...prev,
              isDeleting: false,
              error: error instanceof ApiError ? (error.detail ?? 'Delete failed. Try again.') : 'Delete failed. Try again.',
            }
          : prev,
      )
    }
  }, [deleteModal])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section aria-labelledby="admin-roles-heading" data-testid="admin-roles-page">
      {createModal.open && (
        <CreateRoleModal
          name={createModal.name}
          description={createModal.description}
          onNameChange={handleCreateNameChange}
          onDescriptionChange={handleCreateDescriptionChange}
          onSubmit={() => void handleCreateSubmit()}
          onCancel={handleCreateCancel}
          submitting={createModal.submitting}
          nameError={createModal.nameError}
          generalError={createModal.generalError}
        />
      )}

      {deleteModal.open && (
        <ConfirmDeleteModal
          entityLabel="role"
          itemName={deleteModal.role.name}
          isDeleting={deleteModal.isDeleting}
          errorMessage={deleteModal.error}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={handleDeleteCancel}
        />
      )}

      <div className="flex items-center justify-between gap-4">
        <h2 id="admin-roles-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          Roles
        </h2>
        {listState.status !== 'forbidden' && (
          <button
            type="button"
            onClick={handleCreateOpen}
            data-testid="roles-new-button"
            className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90"
            style={{ color: 'white', backgroundColor: 'var(--acc)' }}
          >
            + New role
          </button>
        )}
      </div>

      <div className="mt-4">
        {listState.status === 'forbidden' && <PermissionDenied />}

        {listState.status === 'loading' && <SkeletonListRows rows={4} />}

        {listState.status === 'error' && <ErrorBanner message={listState.message} onRetry={handleRetry} />}

        {listState.status === 'loaded' && listState.roles.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="roles-empty-state">
            <p className="text-sm" style={{ color: 'var(--soft)' }}>
              No roles yet.
            </p>
            <button
              type="button"
              onClick={handleCreateOpen}
              className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90"
              style={{ color: 'white', backgroundColor: 'var(--acc)' }}
            >
              + New role
            </button>
          </div>
        )}

        {listState.status === 'loaded' && listState.roles.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" data-testid="roles-table">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                  {(['Name', 'Description', 'System', 'Rules'] as const).map((label) => (
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
                {listState.roles.map((role) => (
                  <tr
                    key={role.id}
                    data-testid={`role-row-${role.id}`}
                    className="border-b"
                    style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                  >
                    <td className="py-1.5 px-2 font-medium" style={{ color: 'var(--text)' }}>
                      {role.name}
                    </td>
                    <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                      {role.description || '—'}
                    </td>
                    <td className="py-1.5 px-2">{role.isSystem && <SystemBadge />}</td>
                    <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                      {role.ruleCount ?? '—'}
                    </td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          onClick={() => handleOpenEditor(role.id)}
                          data-testid={`role-edit-${role.id}`}
                          className="py-1 px-2.5 text-[11px] font-medium border transition-opacity hover:opacity-80"
                          style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-disabled={role.isSystem}
                          title={role.isSystem ? "System roles can't be deleted" : undefined}
                          onClick={() => handleDeleteRequest(role)}
                          data-testid={`role-delete-${role.id}`}
                          className="py-1 px-2.5 text-[11px] font-medium border transition-opacity hover:opacity-80 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
                          style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
                        >
                          Delete
                          {role.isSystem && <span className="sr-only"> — System roles can't be deleted</span>}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
