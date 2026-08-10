import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getRouteApi, Link } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type { DepartmentDetail as DepartmentDetailData, Role, UserSummary } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'

/**
 * DepartmentDetail — Screen B2 (design.md "Department detail", T19,
 * specs/004-auth-roles-permissions/tasks.md). New page, route `/departments/$id`
 * (../router.tsx).
 *
 * Three independently-saved sections (AC-1.2):
 *   1. Name/description — inline-editable, `PATCH /admin/departments/:id`.
 *   2. "Roles conferred" — a multi-select (checkbox list) of every existing
 *      role, saved as a whole set via `PUT /admin/departments/:id/roles`
 *      (`{ roleIds }`) — members of this department inherit these roles
 *      (T2's resolver). A `422` (stale multi-select referencing a role that
 *      no longer exists) surfaces as an inline banner and re-fetches the
 *      roles catalog, per design.md: "422 unknown role (stale multi-select)
 *      → inline banner, re-fetch roles."
 *   3. "Members" panel — lists `GET /admin/departments/:id`'s embedded
 *      `members` (design drift fix, T9/T16), with per-member Remove and an
 *      "Add member" user-search picker (composed from a `?q=` search against
 *      `GET /admin/users` + a row-select, per design.md: "reuses the
 *      Users-list search pattern, not a new pattern" — Screen C1 itself
 *      isn't built yet (T20), so this composes directly from adminApi
 *      rather than importing a page that doesn't exist). Both add and
 *      remove persist via `PUT /admin/departments/:id/members` (`{ userIds }`,
 *      whole-set semantics) — never a partial-update endpoint, because none
 *      exists (T9's drift fix note).
 *
 * Async pattern: exactly like DepartmentsPage.tsx / AuditPage.tsx — the two
 * `useEffect`-driven fetches (department detail, roles catalog) are
 * `.then()/.catch()` Promise chains, never an async function invoked
 * directly from the effect (admin-ui's `eslint-plugin-react-hooks@7.1.1`
 * `react-hooks/set-state-in-effect` rule). Every other async call here
 * (save details, save roles, add/remove member, user search) happens inside
 * an event handler, not an effect, so async/await is used freely there.
 *
 * ---------------------------------------------------------------------
 * KNOWN BACKEND DRIFT (flagged, not silently adapted to — see this task's
 * completion report): `auth/src/admin/departments.routes.ts` (T9) does NOT
 * actually match plan.md's own "Wire-shape conventions" section, which the
 * plan says is "fixed by the admin-ui client T16; backend T8–T10 MUST
 * match": the real `GET /admin/departments` returns `{ items: [...] }`,
 * not a bare array, and department responses carry `roles: {id,name}[]`,
 * not `roleIds: string[]`. This page (and DepartmentsPage.tsx) is written
 * against `adminApi.ts`'s already-fixed types (bare array, `roleIds`) per
 * "consume the API exactly as plan.md defines it" — the backend, not this
 * frontend task, is what's out of contract, so it is not adapted to here.
 * ---------------------------------------------------------------------
 */

const route = getRouteApi('/departments/$id')

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

type LoadState =
  { status: 'loading' } | { status: 'loaded'; department: DepartmentDetailData } | { status: 'error'; message: string }

type RolesCatalogState =
  { status: 'loading' } | { status: 'loaded'; roles: Role[] } | { status: 'error'; message: string }

export default function DepartmentDetail() {
  const { id } = route.useParams()

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const [rolesCatalog, setRolesCatalog] = useState<RolesCatalogState>({ status: 'loading' })

  // --- Name/description ---
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [detailsSaving, setDetailsSaving] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)

  // --- Roles conferred ---
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([])
  const [rolesSaving, setRolesSaving] = useState(false)
  const [rolesError, setRolesError] = useState<string | null>(null)

  // --- Members ---
  const [membersError, setMembersError] = useState<string | null>(null)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)

  // --- Add-member user-search picker ---
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerStatus, setPickerStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [pickerResults, setPickerResults] = useState<UserSummary[]>([])
  const [pickerMessage, setPickerMessage] = useState<string | null>(null)
  const [addingUserId, setAddingUserId] = useState<string | null>(null)

  // Load the department detail whenever `id` or `reloadToken` changes.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.getDepartment(id))
      .then((department) => {
        if (cancelled) return
        setState({ status: 'loaded', department })
        setNameDraft(department.name)
        setDescriptionDraft(department.description ?? '')
        setSelectedRoleIds(department.roleIds)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: errorMessageFor(error, 'Could not load this department.') })
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken])

  // Load the roles catalog (for the "Roles conferred" multi-select).
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setRolesCatalog({ status: 'loading' })
      })
      .then(() => adminApi.listRoles())
      .then((roles) => {
        if (!cancelled) setRolesCatalog({ status: 'loaded', roles })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRolesCatalog({ status: 'error', message: errorMessageFor(error, 'Could not load roles.') })
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => setReloadToken((t) => t + 1), [])

  // --- Save name/description ---
  const handleSaveDetails = useCallback(async () => {
    setDetailsSaving(true)
    setDetailsError(null)
    try {
      const updated = await adminApi.patchDepartment(id, {
        name: nameDraft.trim(),
        description: descriptionDraft.trim() || null,
      })
      setState((prev) =>
        prev.status === 'loaded' ? { status: 'loaded', department: { ...prev.department, ...updated } } : prev,
      )
      setNameDraft(updated.name)
      setDescriptionDraft(updated.description ?? '')
    } catch (error) {
      setDetailsError(
        error instanceof ApiError && error.status === 409
          ? (error.detail ?? 'A department with this name already exists.')
          : errorMessageFor(error, 'Could not save changes.'),
      )
    } finally {
      setDetailsSaving(false)
    }
  }, [id, nameDraft, descriptionDraft])

  // --- Roles conferred ---
  const toggleRole = useCallback((roleId: string) => {
    setSelectedRoleIds((prev) => (prev.includes(roleId) ? prev.filter((r) => r !== roleId) : [...prev, roleId]))
  }, [])

  const handleSaveRoles = useCallback(async () => {
    setRolesSaving(true)
    setRolesError(null)
    try {
      const updated = await adminApi.putDepartmentRoles(id, selectedRoleIds)
      setState({ status: 'loaded', department: updated })
      setSelectedRoleIds(updated.roleIds)
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        setRolesError(error.detail ?? 'One or more selected roles no longer exist. Reloading roles…')
        try {
          const roles = await adminApi.listRoles()
          setRolesCatalog({ status: 'loaded', roles })
        } catch (reloadError) {
          setRolesCatalog({ status: 'error', message: errorMessageFor(reloadError, 'Could not reload roles.') })
        }
      } else {
        setRolesError(errorMessageFor(error, 'Could not save roles.'))
      }
    } finally {
      setRolesSaving(false)
    }
  }, [id, selectedRoleIds])

  // --- Members: remove ---
  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (state.status !== 'loaded') return
      const remaining = state.department.members.filter((m) => m.id !== userId).map((m) => m.id)
      setRemovingMemberId(userId)
      setMembersError(null)
      try {
        const updated = await adminApi.putDepartmentMembers(id, remaining)
        setState({ status: 'loaded', department: updated })
      } catch (error) {
        setMembersError(errorMessageFor(error, 'Could not remove this member.'))
      } finally {
        setRemovingMemberId(null)
      }
    },
    [id, state],
  )

  // --- Members: add via user-search picker ---
  const openPicker = useCallback(() => {
    setPickerOpen(true)
    setPickerQuery('')
    setPickerStatus('idle')
    setPickerResults([])
    setPickerMessage(null)
  }, [])

  const closePicker = useCallback(() => setPickerOpen(false), [])

  const handlePickerSearch = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setPickerStatus('loading')
      setPickerMessage(null)
      try {
        const result = await adminApi.listUsers({ q: pickerQuery, pageSize: 10 })
        setPickerResults(result.items)
        setPickerStatus('loaded')
      } catch (error) {
        setPickerStatus('error')
        setPickerMessage(errorMessageFor(error, 'Could not search users.'))
      }
    },
    [pickerQuery],
  )

  const handleAddMember = useCallback(
    async (user: UserSummary) => {
      if (state.status !== 'loaded') return
      const currentIds = state.department.members.map((m) => m.id)
      if (currentIds.includes(user.id)) return
      setAddingUserId(user.id)
      setMembersError(null)
      try {
        const updated = await adminApi.putDepartmentMembers(id, [...currentIds, user.id])
        setState({ status: 'loaded', department: updated })
        setPickerOpen(false)
      } catch (error) {
        setMembersError(errorMessageFor(error, 'Could not add this member.'))
      } finally {
        setAddingUserId(null)
      }
    },
    [id, state],
  )

  return (
    <section aria-labelledby="department-detail-heading" data-testid="department-detail-page">
      <Link
        to="/departments"
        className="text-xs font-medium hover:underline"
        style={{ color: 'var(--soft)' }}
        data-testid="department-detail-back-link"
      >
        ← Back to Departments
      </Link>

      {state.status === 'loading' && (
        <div className="mt-4">
          <SkeletonListRows rows={3} />
        </div>
      )}

      {state.status === 'error' && (
        <div className="mt-4">
          <ErrorBanner message={state.message} onRetry={handleRetry} />
        </div>
      )}

      {state.status === 'loaded' && (
        <>
          <h2
            id="department-detail-heading"
            className="text-lg font-semibold mt-2"
            style={{ fontFamily: 'var(--disp)' }}
          >
            {state.department.name}
          </h2>

          {/* --- Name / description --- */}
          <div
            className="mt-4 p-4 border rounded-md"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
            data-testid="department-details-section"
          >
            <div className="mb-3">
              <label
                htmlFor="department-name-input"
                className="block text-xs font-medium mb-1"
                style={{ color: 'var(--soft)' }}
              >
                Name
              </label>
              <input
                id="department-name-input"
                type="text"
                value={nameDraft}
                disabled={detailsSaving}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full text-sm px-3 py-2 border rounded disabled:opacity-60"
                style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }}
                data-testid="department-name-input"
              />
            </div>
            <div className="mb-3">
              <label
                htmlFor="department-description-input"
                className="block text-xs font-medium mb-1"
                style={{ color: 'var(--soft)' }}
              >
                Description
              </label>
              <textarea
                id="department-description-input"
                value={descriptionDraft}
                disabled={detailsSaving}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                rows={2}
                className="w-full text-sm px-3 py-2 border rounded disabled:opacity-60"
                style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }}
                data-testid="department-description-input"
              />
            </div>
            {detailsError && (
              <p
                role="alert"
                className="text-sm mb-3"
                style={{ color: 'var(--org)' }}
                data-testid="department-details-error"
              >
                {detailsError}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleSaveDetails()}
              disabled={detailsSaving || nameDraft.trim().length === 0}
              data-testid="department-save-details"
              className="text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {detailsSaving ? 'Saving…' : 'Save details'}
            </button>
          </div>

          {/* --- Roles conferred --- */}
          <div
            className="mt-4 p-4 border rounded-md"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
            data-testid="department-roles-section"
          >
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>
              Roles conferred
            </h3>
            <p className="text-xs mb-3" style={{ color: 'var(--soft)' }}>
              Members of this department inherit every role selected below.
            </p>

            {rolesCatalog.status === 'loading' && <SkeletonListRows rows={2} />}

            {rolesCatalog.status === 'error' && <ErrorBanner message={rolesCatalog.message} onRetry={handleRetry} />}

            {rolesCatalog.status === 'loaded' && rolesCatalog.roles.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--soft)' }} data-testid="department-roles-empty">
                No roles exist yet — create one in the Roles section.
              </p>
            )}

            {rolesCatalog.status === 'loaded' && rolesCatalog.roles.length > 0 && (
              <fieldset data-testid="department-roles-list">
                <legend className="sr-only">Roles conferred by this department</legend>
                <div className="flex flex-col gap-1.5">
                  {rolesCatalog.roles.map((role) => (
                    <label key={role.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                      <input
                        type="checkbox"
                        checked={selectedRoleIds.includes(role.id)}
                        disabled={rolesSaving}
                        onChange={() => toggleRole(role.id)}
                        data-testid={`role-checkbox-${role.id}`}
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {rolesError && (
              <p
                role="alert"
                className="text-sm mt-3"
                style={{ color: 'var(--org)' }}
                data-testid="department-roles-error"
              >
                {rolesError}
              </p>
            )}

            {rolesCatalog.status === 'loaded' && rolesCatalog.roles.length > 0 && (
              <button
                type="button"
                onClick={() => void handleSaveRoles()}
                disabled={rolesSaving}
                data-testid="department-save-roles"
                className="mt-3 text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                {rolesSaving ? 'Saving…' : 'Save roles'}
              </button>
            )}
          </div>

          {/* --- Members --- */}
          <div
            className="mt-4 p-4 border rounded-md"
            style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
            data-testid="department-members-section"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                Members
              </h3>
              <button
                type="button"
                onClick={openPicker}
                data-testid="department-add-member-button"
                className="text-xs font-medium py-1 px-2 border transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                + Add member
              </button>
            </div>

            {membersError && (
              <p
                role="alert"
                className="text-sm mb-2"
                style={{ color: 'var(--org)' }}
                data-testid="department-members-error"
              >
                {membersError}
              </p>
            )}

            {state.department.members.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--soft)' }} data-testid="department-members-empty">
                No members yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5" data-testid="department-members-list">
                {state.department.members.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-3 text-sm"
                    data-testid={`department-member-${member.id}`}
                  >
                    <span style={{ color: 'var(--text)' }}>
                      {member.name ?? member.email} <span style={{ color: 'var(--soft)' }}>({member.email})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveMember(member.id)}
                      disabled={removingMemberId === member.id}
                      aria-label={`Remove ${member.name ?? member.email} from this department`}
                      data-testid={`department-remove-member-${member.id}`}
                      className="text-xs font-medium py-1 px-2 border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
                    >
                      {removingMemberId === member.id ? 'Removing…' : 'Remove'}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* --- Add-member user-search picker (inline, per design.md: "reuses
                the Users-list search pattern, not a new pattern" — not a modal) --- */}
            {pickerOpen && (
              <div
                className="mt-3 p-3 border rounded-md"
                style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)' }}
                data-testid="department-member-picker"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                    Search users by name or email
                  </p>
                  <button
                    type="button"
                    onClick={closePicker}
                    aria-label="Close user search"
                    data-testid="department-picker-close"
                    className="text-base leading-none hover:opacity-80"
                    style={{ color: 'var(--muted)' }}
                  >
                    ×
                  </button>
                </div>

                <form onSubmit={(e) => void handlePickerSearch(e)} className="flex items-center gap-2 mb-2">
                  <label htmlFor="department-picker-query" className="sr-only">
                    Search users
                  </label>
                  <input
                    id="department-picker-query"
                    type="text"
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    className="flex-1 text-sm px-3 py-1.5 border rounded"
                    style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)', color: 'var(--text)' }}
                    data-testid="department-picker-query-input"
                  />
                  <button
                    type="submit"
                    disabled={pickerStatus === 'loading'}
                    data-testid="department-picker-search-button"
                    className="text-xs font-medium py-1.5 px-2.5 border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                  >
                    {pickerStatus === 'loading' ? 'Searching…' : 'Search'}
                  </button>
                </form>

                {pickerStatus === 'error' && pickerMessage && (
                  <p
                    role="alert"
                    className="text-sm"
                    style={{ color: 'var(--org)' }}
                    data-testid="department-picker-message"
                  >
                    {pickerMessage}
                  </p>
                )}

                {pickerStatus === 'loaded' && pickerResults.length === 0 && (
                  <p className="text-sm" style={{ color: 'var(--soft)' }} data-testid="department-picker-empty">
                    No users match your search.
                  </p>
                )}

                {pickerStatus === 'loaded' && pickerResults.length > 0 && (
                  <ul className="flex flex-col gap-1.5" data-testid="department-picker-results">
                    {pickerResults.map((user) => {
                      const alreadyMember = state.department.members.some((m) => m.id === user.id)
                      return (
                        <li
                          key={user.id}
                          className="flex items-center justify-between gap-3 text-sm"
                          data-testid={`department-picker-result-${user.id}`}
                        >
                          <span style={{ color: 'var(--text)' }}>
                            {user.name ?? user.email} <span style={{ color: 'var(--soft)' }}>({user.email})</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleAddMember(user)}
                            disabled={alreadyMember || addingUserId === user.id}
                            data-testid={`department-picker-add-${user.id}`}
                            className="text-xs font-medium py-1 px-2 border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                          >
                            {alreadyMember ? 'Already a member' : addingUserId === user.id ? 'Adding…' : 'Add'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
