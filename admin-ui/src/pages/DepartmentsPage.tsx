import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type { Department } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import CreateDepartmentModal from '../components/CreateDepartmentModal'

/**
 * DepartmentsPage — Screen B1 (design.md "Departments list", T19,
 * specs/004-auth-roles-permissions/tasks.md). Replaces T14's placeholder.
 *
 * Browse/create/delete departments (AC-1.2). List/create/delete states
 * mirror Screen A1's pattern exactly per design.md ("L/E/P/Err mirror Screen
 * A1 exactly … no System-role equivalent … no lock badge here") — no System
 * badge, no protected-delete guardrail; every department is ordinarily
 * deletable (the seed `hr` department "has no special default powers" per
 * the spec).
 *
 * Columns are Name / Description / actions only — NOT member+role counts.
 * `GET /admin/departments` (adminApi.listDepartments, T16) returns bare
 * `Department` rows (id/name/description/timestamps); neither plan.md's API
 * contracts table nor the admin-ui client type carries a per-row
 * member/role count for the LIST endpoint (only `GET /admin/departments/:id`,
 * i.e. Screen B2, embeds `roleIds`/`members`). Fetching each row's detail
 * just to show a count would be an N+1 anti-pattern this task should not
 * introduce silently — flagged as a drift/gap in this task's report rather
 * than faked or worked around here (see also Screen A1's analogous
 * "rule count" column, which has the same gap for T17).
 *
 * Create (Modal M2, ../components/CreateDepartmentModal.tsx) → on success,
 * navigates straight to the new department's detail (Screen B2, AC-1.2:
 * "admin creates a department and adds users to it"). Delete (Dialog D1,
 * ../components/ConfirmDeleteModal.tsx) → back to this list, refetched.
 *
 * Async pattern: the list fetch runs inside `useEffect` as an explicit
 * `.then()/.catch()` Promise chain, not an async/await helper invoked from
 * the effect — mirrors AuditPage.tsx's (T21) documented reasoning:
 * admin-ui's `eslint-plugin-react-hooks@7.1.1` flags an async function that
 * calls a state setter (even after an `await`) as "this effect calls
 * setState directly" (`react-hooks/set-state-in-effect`). Routing each
 * setState through its own `.then()`/`.catch()` closure sidesteps that,
 * with identical runtime behavior. Event-handler-triggered API calls
 * (create/delete, below) are NOT inside a `useEffect` and use async/await
 * freely, exactly like `estimai-ui/src/pages/EstimatesPage.tsx`'s
 * `handleDeleteConfirm` — the lint rule only polices effects.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; items: Department[] }
  | { status: 'error'; message: string }

type CreateModalState =
  | { open: false }
  | { open: true; isSubmitting: boolean; errorMessage: string | null }

type DeleteModalState =
  | { open: false }
  | { open: true; item: Department; isDeleting: boolean; errorMessage: string | null }

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

export default function DepartmentsPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [createModal, setCreateModal] = useState<CreateModalState>({ open: false })
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({ open: false })

  // Fetch the list whenever `reloadToken` changes (bumped by "Retry" and by
  // a successful delete). See the module doc comment above for why this is
  // a Promise chain rather than an async function.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.listDepartments())
      .then((items) => {
        if (!cancelled) setState({ status: 'loaded', items })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: errorMessageFor(error, 'Could not load departments.') })
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => setReloadToken((t) => t + 1), [])

  const handleOpen = useCallback(
    (id: string) => navigate({ to: '/departments/$id', params: { id } }),
    [navigate],
  )

  const openCreateModal = useCallback(
    () => setCreateModal({ open: true, isSubmitting: false, errorMessage: null }),
    [],
  )
  const closeCreateModal = useCallback(() => setCreateModal({ open: false }), [])

  const handleCreateSubmit = useCallback(
    async (input: { name: string; description?: string }) => {
      setCreateModal({ open: true, isSubmitting: true, errorMessage: null })
      try {
        const created = await adminApi.createDepartment(input)
        setCreateModal({ open: false })
        navigate({ to: '/departments/$id', params: { id: created.id } })
      } catch (error) {
        const message =
          error instanceof ApiError && error.status === 409
            ? (error.detail ?? 'A department with this name already exists.')
            : errorMessageFor(error, 'Could not create the department.')
        setCreateModal({ open: true, isSubmitting: false, errorMessage: message })
      }
    },
    [navigate],
  )

  const handleDeleteRequest = useCallback(
    (item: Department) => setDeleteModal({ open: true, item, isDeleting: false, errorMessage: null }),
    [],
  )
  const handleDeleteCancel = useCallback(() => setDeleteModal({ open: false }), [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModal.open) return
    const { item } = deleteModal
    setDeleteModal({ open: true, item, isDeleting: true, errorMessage: null })
    try {
      await adminApi.deleteDepartment(item.id)
      setDeleteModal({ open: false })
      setReloadToken((t) => t + 1)
    } catch (error) {
      setDeleteModal({
        open: true,
        item,
        isDeleting: false,
        errorMessage: errorMessageFor(error, 'Delete failed. Try again.'),
      })
    }
  }, [deleteModal])

  return (
    <section aria-labelledby="admin-departments-heading" data-testid="admin-departments-page">
      {createModal.open && (
        <CreateDepartmentModal
          isSubmitting={createModal.isSubmitting}
          errorMessage={createModal.errorMessage}
          onSubmit={(input) => void handleCreateSubmit(input)}
          onCancel={closeCreateModal}
        />
      )}

      {deleteModal.open && (
        <ConfirmDeleteModal
          entityLabel="department"
          itemName={deleteModal.item.name}
          isDeleting={deleteModal.isDeleting}
          errorMessage={deleteModal.errorMessage}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={handleDeleteCancel}
        />
      )}

      <div className="flex items-center justify-between">
        <h2 id="admin-departments-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          Departments
        </h2>
        <button
          type="button"
          onClick={openCreateModal}
          data-testid="new-department-button"
          className="text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80"
          style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
        >
          + New department
        </button>
      </div>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={4} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && state.items.length === 0 && (
          <p
            className="text-sm py-6 text-center"
            style={{ color: 'var(--soft)' }}
            data-testid="departments-empty-state"
          >
            No departments yet.
          </p>
        )}

        {state.status === 'loaded' && state.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" data-testid="departments-table">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                  <th
                    scope="col"
                    className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                    style={{ color: 'var(--soft)' }}
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                    style={{ color: 'var(--soft)' }}
                  >
                    Description
                  </th>
                  <th scope="col" className="text-right py-1.5 px-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((dept) => (
                  <tr
                    key={dept.id}
                    className="border-b"
                    style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                  >
                    <td className="py-1.5 px-2">
                      <button
                        type="button"
                        onClick={() => handleOpen(dept.id)}
                        className="font-medium text-left hover:underline"
                        style={{ color: 'var(--text)' }}
                        data-testid={`department-open-${dept.id}`}
                      >
                        {dept.name}
                      </button>
                    </td>
                    <td className="py-1.5 px-2" style={{ color: 'var(--soft)' }}>
                      {dept.description || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteRequest(dept)}
                        aria-label={`Delete "${dept.name}"`}
                        title="Delete"
                        className="text-[11px] font-medium border px-2 py-1 hover:opacity-80"
                        style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
                        data-testid={`department-delete-${dept.id}`}
                      >
                        ×
                      </button>
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
