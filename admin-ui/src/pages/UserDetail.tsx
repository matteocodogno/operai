/**
 * UserDetail — Screen C2 (design.md "User detail — attributes + role/department
 * assignment + the AC-6.4 last-admin GuardrailDialog D2", T20,
 * specs/004-auth-roles-permissions/tasks.md). Mounted at `/users/$id`
 * (../router.tsx).
 *
 * Three independently-saved sections, matching design.md's F4/Screen C2 split
 * (each a distinct API call, plan.md's contract):
 *   - Identity — name/email, read-only.
 *   - Attributes — `entity` select + `jobTitle` text → `PATCH /admin/users/:id`.
 *   - Direct roles — a checkbox fieldset (every catalog role) → `PUT
 *     /admin/users/:id/roles` `{ roleIds }`.
 *   - Departments — a checkbox fieldset (every department) → `PUT
 *     /admin/users/:id/departments` `{ departmentIds }`.
 * Roles/departments render as a native checkbox `<fieldset>` rather than a
 * `<select multiple>` — this repo's a11y posture is "every new interactive
 * element is a native `<button>/<select>/<input>/<a>`" (design.md
 * "Accessibility — Keyboard operation"), and a checkbox-per-option list reads
 * and operates far better than a multi-select listbox for this size of set.
 *
 * A short "Effective immediately" hint sits near the roles/departments Save
 * buttons (design.md F4 step 4: "no separate 'publish' step").
 *
 * **Guardrail (AC-6.4):** if a roles/departments save returns `422` (the
 * server's last-admin guard — plan.md), GuardrailDialog (D2, T15) surfaces
 * the fixed message design.md prescribes verbatim. Critically, the pending
 * edit (the checkbox selection the admin was about to save) is NOT reset
 * when the dialog is dismissed — it lives in its own `selectedRoleIds` /
 * `selectedDepartmentIds` state, untouched by the failed save, so the admin
 * can immediately adjust (e.g. re-check `admin`) and retry (design.md: "the
 * in-progress edit is preserved so the admin can adjust and retry").
 *
 * States mirror every other admin-ui screen (design.md "L/E/P/Err"):
 *   L — SkeletonListRows while `GET /admin/users/:id` + the roles/departments
 *       catalogs resolve.
 *   Err — ErrorBanner + Retry (re-fetches everything).
 *   P — the three sections described above.
 *
 * Built as explicit Promise chains in effects/handlers, not async/await — see
 * ../pages/AuditPage.tsx's doc comment for the full rationale
 * (`react-hooks/set-state-in-effect` false positive on an async function that
 * calls a state setter after an `await`).
 */

import { useCallback, useEffect, useState } from 'react'
import { getRouteApi, Link } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type { Department, Role, UserDetail as UserDetailData, UserEntity } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import GuardrailDialog from '../components/GuardrailDialog'

const route = getRouteApi('/users/$id')

const ENTITY_OPTIONS: { value: UserEntity; label: string }[] = [
  { value: 'welld_ch', label: 'WellD CH' },
  { value: 'welld_it', label: 'WellD Italia' },
]

/** design.md F4 / Dialog D2 — fixed acknowledgement copy, verbatim. */
const LAST_ADMIN_MESSAGE =
  'This is the last administrator — removing this role would leave nobody able to manage access. Assign another admin first.'

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; user: UserDetailData; roles: Role[]; departments: Department[] }
  | { status: 'error'; message: string }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load this user.'
}

const toggleInSet = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

export default function UserDetail() {
  const { id } = route.useParams()

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  // Pending-edit state, seeded once from the loaded user by the fetch effect
  // below (and re-seeded if the id changes / a Retry re-fetches from
  // scratch).
  const [entity, setEntity] = useState<UserEntity | ''>('')
  const [jobTitle, setJobTitle] = useState('')
  const [selectedRoleIds, setSelectedRoleIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<ReadonlySet<string>>(new Set())

  const [attributesSaving, setAttributesSaving] = useState(false)
  const [attributesError, setAttributesError] = useState<string | null>(null)
  const [rolesSaving, setRolesSaving] = useState(false)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [departmentsSaving, setDepartmentsSaving] = useState(false)
  const [departmentsError, setDepartmentsError] = useState<string | null>(null)
  const [guardrailMessage, setGuardrailMessage] = useState<string | null>(null)

  // Fetch the user + the full role/department catalogs (needed to render
  // every option in the two checkbox fieldsets, not just the assigned ones).
  // The pending-edit state (entity/jobTitle/selectedRoleIds/
  // selectedDepartmentIds) is seeded right here, in this `.then()` closure,
  // rather than in a second effect that watches `state` — that would fire
  // (and re-seed) on every `state.status === 'loaded'` transition, including
  // the ones a *successful* roles/departments save produces via its own
  // `setState` call below, and would need its own tracking flag to avoid
  // re-seeding over a save that's still pending after a 422 (design.md's
  // guardrail requirement: "the in-progress edit is preserved so the admin
  // can adjust and retry"). Seeding only here — only reachable from a fresh
  // `GET /admin/users/:id` — sidesteps that entirely: a save's own
  // `setState` never touches `entity`/`jobTitle`/`selectedRoleIds`/
  // `selectedDepartmentIds`, so a 422 (or any save) simply leaves them as the
  // admin last edited them.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => Promise.all([adminApi.getUser(id), adminApi.listRoles(), adminApi.listDepartments()]))
      .then(([user, roles, departments]) => {
        if (cancelled) return
        setState({ status: 'loaded', user, roles, departments })
        setEntity(user.entity ?? '')
        setJobTitle(user.jobTitle ?? '')
        setSelectedRoleIds(new Set(user.roles.map((r) => r.id)))
        setSelectedDepartmentIds(new Set(user.departments.map((d) => d.id)))
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageFor(error) })
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const toggleRole = useCallback((roleId: string) => {
    setSelectedRoleIds((prev) => toggleInSet(prev, roleId))
  }, [])

  const toggleDepartment = useCallback((departmentId: string) => {
    setSelectedDepartmentIds((prev) => toggleInSet(prev, departmentId))
  }, [])

  const handleSaveAttributes = useCallback(() => {
    setAttributesSaving(true)
    setAttributesError(null)
    adminApi
      .patchUser(id, { entity: entity === '' ? null : entity, jobTitle: jobTitle.trim() === '' ? null : jobTitle })
      .then((updated) => {
        setAttributesSaving(false)
        setState((prev) => (prev.status === 'loaded' ? { ...prev, user: updated } : prev))
      })
      .catch((error: unknown) => {
        setAttributesSaving(false)
        setAttributesError(errorMessageFor(error))
      })
  }, [id, entity, jobTitle])

  const handleSaveRoles = useCallback(() => {
    setRolesSaving(true)
    setRolesError(null)
    adminApi
      .putUserRoles(id, Array.from(selectedRoleIds))
      .then((updated) => {
        setRolesSaving(false)
        setState((prev) => (prev.status === 'loaded' ? { ...prev, user: updated } : prev))
      })
      .catch((error: unknown) => {
        setRolesSaving(false)
        if (error instanceof ApiError && error.status === 422) {
          // AC-6.4 — pending selection (selectedRoleIds) is intentionally left
          // as-is so the admin can adjust and retry.
          setGuardrailMessage(LAST_ADMIN_MESSAGE)
          return
        }
        setRolesError(errorMessageFor(error))
      })
  }, [id, selectedRoleIds])

  const handleSaveDepartments = useCallback(() => {
    setDepartmentsSaving(true)
    setDepartmentsError(null)
    adminApi
      .putUserDepartments(id, Array.from(selectedDepartmentIds))
      .then((updated) => {
        setDepartmentsSaving(false)
        setState((prev) => (prev.status === 'loaded' ? { ...prev, user: updated } : prev))
      })
      .catch((error: unknown) => {
        setDepartmentsSaving(false)
        if (error instanceof ApiError && error.status === 422) {
          // AC-6.4 — pending selection (selectedDepartmentIds) is intentionally
          // left as-is so the admin can adjust and retry.
          setGuardrailMessage(LAST_ADMIN_MESSAGE)
          return
        }
        setDepartmentsError(errorMessageFor(error))
      })
  }, [id, selectedDepartmentIds])

  const handleAcknowledgeGuardrail = useCallback(() => {
    setGuardrailMessage(null)
  }, [])

  return (
    <section aria-labelledby="admin-user-detail-heading" data-testid="admin-user-detail-page">
      <Link
        to="/users"
        data-testid="back-to-users-link"
        className="text-xs font-medium transition-opacity hover:opacity-80"
        style={{ color: 'var(--soft)' }}
      >
        ← Back to Users
      </Link>

      <h2
        id="admin-user-detail-heading"
        className="mt-2 text-lg font-semibold"
        style={{ fontFamily: 'var(--disp)' }}
      >
        User detail
      </h2>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={4} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && (
          <div className="flex flex-col gap-6">
            {/* Identity — read-only */}
            <div>
              <p className="text-base font-semibold" style={{ color: 'var(--text)' }} data-testid="user-detail-name">
                {state.user.name ?? state.user.email}
              </p>
              <p className="text-sm" style={{ color: 'var(--soft)' }} data-testid="user-detail-email">
                {state.user.email}
              </p>
            </div>

            {/* Attributes */}
            <div className="border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
                Attributes
              </h3>

              <div className="flex flex-col gap-3 max-w-sm">
                <div>
                  <label htmlFor="user-entity-select" className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
                    Entity
                  </label>
                  <select
                    id="user-entity-select"
                    data-testid="entity-select"
                    value={entity}
                    onChange={(e) => setEntity(e.target.value as UserEntity | '')}
                    className="w-full border rounded-md px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
                  >
                    <option value="">— none —</option>
                    {ENTITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="user-jobtitle-input" className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
                    Job title
                  </label>
                  <input
                    id="user-jobtitle-input"
                    type="text"
                    data-testid="jobtitle-input"
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                    className="w-full border rounded-md px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSaveAttributes}
                    disabled={attributesSaving}
                    data-testid="save-attributes-button"
                    className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                  >
                    {attributesSaving ? 'Saving…' : 'Save attributes'}
                  </button>
                </div>

                {attributesError && (
                  <p role="alert" data-testid="attributes-error" className="text-sm" style={{ color: 'var(--org)' }}>
                    {attributesError}
                  </p>
                )}
              </div>
            </div>

            {/* Direct roles */}
            <div className="border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
              <fieldset>
                <legend className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
                  Direct roles
                </legend>

                {state.roles.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--soft)' }}>
                    No roles defined yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {state.roles.map((role) => (
                      <label key={role.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                        <input
                          type="checkbox"
                          data-testid={`role-checkbox-${role.id}`}
                          checked={selectedRoleIds.has(role.id)}
                          onChange={() => toggleRole(role.id)}
                        />
                        {role.name}
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-3 mt-3">
                  <button
                    type="button"
                    onClick={handleSaveRoles}
                    disabled={rolesSaving}
                    data-testid="save-roles-button"
                    className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                  >
                    {rolesSaving ? 'Saving…' : 'Save roles'}
                  </button>
                  <span className="text-xs" style={{ color: 'var(--soft)' }} data-testid="roles-effective-immediately-hint">
                    Effective immediately — no separate publish step.
                  </span>
                </div>

                {rolesError && (
                  <p role="alert" data-testid="roles-error" className="text-sm mt-2" style={{ color: 'var(--org)' }}>
                    {rolesError}
                  </p>
                )}
              </fieldset>
            </div>

            {/* Departments */}
            <div className="border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
              <fieldset>
                <legend className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
                  Departments
                </legend>

                {state.departments.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--soft)' }}>
                    No departments defined yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {state.departments.map((department) => (
                      <label
                        key={department.id}
                        className="flex items-center gap-2 text-sm"
                        style={{ color: 'var(--text)' }}
                      >
                        <input
                          type="checkbox"
                          data-testid={`department-checkbox-${department.id}`}
                          checked={selectedDepartmentIds.has(department.id)}
                          onChange={() => toggleDepartment(department.id)}
                        />
                        {department.name}
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-3 mt-3">
                  <button
                    type="button"
                    onClick={handleSaveDepartments}
                    disabled={departmentsSaving}
                    data-testid="save-departments-button"
                    className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                  >
                    {departmentsSaving ? 'Saving…' : 'Save departments'}
                  </button>
                  <span
                    className="text-xs"
                    style={{ color: 'var(--soft)' }}
                    data-testid="departments-effective-immediately-hint"
                  >
                    Effective immediately — no separate publish step.
                  </span>
                </div>

                {departmentsError && (
                  <p role="alert" data-testid="departments-error" className="text-sm mt-2" style={{ color: 'var(--org)' }}>
                    {departmentsError}
                  </p>
                )}
              </fieldset>
            </div>
          </div>
        )}
      </div>

      {guardrailMessage && (
        <GuardrailDialog
          title="Can't remove the last administrator"
          message={guardrailMessage}
          onAcknowledge={handleAcknowledgeGuardrail}
        />
      )}
    </section>
  )
}
