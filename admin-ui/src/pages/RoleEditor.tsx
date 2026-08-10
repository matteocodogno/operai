import { useCallback, useEffect, useMemo, useState } from 'react'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type {
  AttributeCondition,
  AttributeConditionKey,
  Catalog,
  CatalogAction,
  CatalogResource,
  ConditionType,
  OwnershipCondition,
  PermissionRule,
  RoleDetail,
  RuleConditions,
} from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import GuardrailDialog from '../components/GuardrailDialog'
import PermissionDenied from '../components/PermissionDenied'
import SystemBadge from '../components/SystemBadge'
import ConditionChip from '../components/ConditionChip'
import type { ConditionChipKind } from '../components/ConditionChip'

/**
 * RoleEditor — Screen A2 (Role editor / rule builder, "the hardest screen"
 * per design.md) — T18, specs/004-auth-roles-permissions/tasks.md, refs
 * AC-2.1–2.4, AC-3.1, AC-3.2.
 *
 * New page at the new `/roles/$id` route (router.tsx, added alongside this
 * task per the prompt's note). Loads the role (`GET /admin/roles/:id`) and
 * the permission catalog (`GET /admin/catalog`) independently; renders:
 *   - Header: inline-editable name/description (PATCH), System badge,
 *     Delete (aria-disabled + tooltip if System — design.md's "not just a
 *     bare CSS disabled state" a11y note, same posture as RolesPage.tsx's
 *     table Delete action and Pagination.tsx's bounds guard).
 *   - Rule list: each rule as "Resource · Action" + condition chips + a
 *     remove "×" — a **client-side draft** (design.md F2 step 4d: "'Add'
 *     appends … to the role's in-progress rule list (client-side draft)").
 *   - Rule composer: catalog-driven Resource→Action cascade (AC-2.1 by
 *     construction — only catalog options are ever renderable) with a
 *     dynamic Conditions fieldset (AC-2.2/2.3) and an `aria-live="polite"`
 *     status line announcing Action-reset / available-conditions changes
 *     (design.md's explicit a11y hotspot for this screen).
 *   - "Save rules" persists the whole draft via `PUT /admin/roles/:id/rules`
 *     (AC-2.1–2.3); a `422` (stale catalog — AC-3.2) surfaces as an inline
 *     banner with a "Reload catalog" action, preserving the draft.
 *
 * Fetch pattern: both the role and catalog effects use the same explicit
 * Promise-chain shape as AuditPage.tsx/RolesPage.tsx (not async/await
 * invoked from the effect) — `eslint-plugin-react-hooks@7.1.1`'s
 * `react-hooks/set-state-in-effect` flags an async function that calls a
 * state setter anywhere in its body, even after an `await`, because the
 * await-continuation stays within the same function body the rule
 * inspects. Routing each transition through its own `.then()`/`.catch()`
 * closure keeps every setState call in its own function boundary. Button
 * click handlers (Save details / Save rules / Delete) are plain
 * async/await, exactly like `EstimatesPage.tsx`'s handlers — the lint rule
 * only polices effects, not event handlers.
 */

const route = getRouteApi('/roles/$id')

const ATTRIBUTE_LABELS: Record<AttributeConditionKey, string> = {
  entity: 'Entity',
  department: 'Department',
  jobTitle: 'Job title',
  'self-approval': 'Self-approval restriction',
}

// The affirmative "scope to the actor's own attribute" group (match:"user").
// Deliberately does NOT include 'self-approval' (specs/010, ADR-0026) — that
// condition is the opposite polarity (match:"deny") and gets its own,
// independent composer toggle (AC-1.1), never folded into this checkbox
// group or its chip presentation (AC-1.4).
const ATTRIBUTE_KEYS: AttributeConditionKey[] = ['entity', 'department', 'jobTitle']

/** The self-approval condition's catalog key (specs/010-self-approval-control, ADR-0026). */
const SELF_APPROVAL_KEY: AttributeConditionKey = 'self-approval'

// Hover/focus help for each attribute condition (native `title` tooltip, the
// same house pattern SystemBadge / disabled buttons use). An attribute
// condition SCOPES the grant to records matching the user's own attribute
// value instead of granting it globally.
const ATTRIBUTE_HELP: Record<AttributeConditionKey, string> = {
  entity:
    "Scope this permission to the user's own entity (e.g. WellD CH or WellD Italia). Checked: they can act only on records matching their entity — for a refund request, one whose lines include their entity. Unchecked: it applies to every entity. A user with no entity set matches nothing.",
  department:
    "Scope this permission to the user's own department. Checked: they can act only on records matching their department. Unchecked: it applies regardless of department. A user with no department set matches nothing.",
  jobTitle:
    "Scope this permission to the user's own job title. Checked: they can act only on records matching their job title. Unchecked: it applies regardless of job title. A user with no job title set matches nothing.",
  'self-approval':
    'Segregation of duties: when checked, a user holding this role cannot approve a refund request they themselves submitted — the attempt is denied even if every other condition on this rule would otherwise allow it. Unchecked: self-approval is permitted, as today.',
}

const humanizeAppId = (appId: string): string =>
  appId.length === 0 ? appId : appId.charAt(0).toUpperCase() + appId.slice(1)

const findResource = (catalog: Catalog, appId: string, resourceKey: string): CatalogResource | undefined =>
  catalog.find((app) => app.appId === appId)?.resources.find((r) => r.key === resourceKey)

/** Best-effort resource/action label lookup for existing rule rows — falls back to the raw key when the catalog hasn't loaded, or no app declares it (a display nicety, not a correctness requirement). */
const labelForResource = (catalog: Catalog | null, resourceKey: string): string => {
  if (!catalog) return resourceKey
  for (const app of catalog) {
    const found = app.resources.find((r) => r.key === resourceKey)
    if (found) return found.label
  }
  return resourceKey
}

const labelForAction = (catalog: Catalog | null, resourceKey: string, actionKey: string): string => {
  if (!catalog) return actionKey
  for (const app of catalog) {
    const action = app.resources.find((r) => r.key === resourceKey)?.actions.find((a) => a.key === actionKey)
    if (action) return action.label
  }
  return actionKey
}

const chipsForConditions = (conditions: RuleConditions | null): ConditionChipKind[] => {
  if (!conditions) return []
  const chips: ConditionChipKind[] = []
  if (conditions.ownership) chips.push(conditions.ownership)
  for (const attr of conditions.attributes ?? []) chips.push(attr.key)
  return chips
}

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

type RoleState =
  | { status: 'loading' }
  | { status: 'loaded'; role: RoleDetail }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

type CatalogState =
  | { status: 'loading' }
  | { status: 'loaded'; catalog: Catalog }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

type ComposerState = {
  open: boolean
  /** `"<appId>::<resourceKey>"` — composite so identically-keyed resources across apps stay distinguishable in the UI; only the bare resourceKey is ever sent to the API. */
  resourceChoice: string | null
  actionKey: string | null
  ownership: OwnershipCondition
  attributes: ReadonlySet<AttributeConditionKey>
  /** The self-approval restriction toggle (specs/010, ADR-0026) — kept as an independent field, never merged into `attributes` (AC-1.1/1.3), since it's a distinct deny-carve-out, not an affirmative scope attribute. */
  selfApproval: boolean
  statusMessage: string
}

const CLOSED_COMPOSER: ComposerState = {
  open: false,
  resourceChoice: null,
  actionKey: null,
  ownership: 'any',
  attributes: new Set(),
  selfApproval: false,
  statusMessage: '',
}

export default function RoleEditor() {
  const { id } = route.useParams()
  const navigate = useNavigate()

  const [roleState, setRoleState] = useState<RoleState>({ status: 'loading' })
  const [roleReloadToken, setRoleReloadToken] = useState(0)
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading' })
  const [catalogReloadToken, setCatalogReloadToken] = useState(0)

  const [draftRules, setDraftRules] = useState<PermissionRule[] | null>(null)

  const [headerEdit, setHeaderEdit] = useState<{ name: string; description: string } | null>(null)
  const [headerSave, setHeaderSave] = useState<{
    saving: boolean
    nameError: string | null
    generalError: string | null
  }>({ saving: false, nameError: null, generalError: null })

  const [composer, setComposer] = useState<ComposerState>(CLOSED_COMPOSER)
  const [saveRulesState, setSaveRulesState] = useState<{ saving: boolean; error: string | null }>({
    saving: false,
    error: null,
  })

  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [guardrail, setGuardrail] = useState<{ title: string; message: string } | null>(null)

  // --- Fetch role ---
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setRoleState({ status: 'loading' })
      })
      .then(() => adminApi.getRole(id))
      .then((role) => {
        if (cancelled) return
        setRoleState({ status: 'loaded', role })
        setDraftRules(role.rules)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setRoleState({ status: 'forbidden' })
        } else {
          setRoleState({ status: 'error', message: errorMessageFor(error, 'Could not load this role.') })
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, roleReloadToken])

  // --- Fetch catalog (independent of the role fetch) ---
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setCatalogState({ status: 'loading' })
      })
      .then(() => adminApi.getCatalog())
      .then((catalog) => {
        if (!cancelled) setCatalogState({ status: 'loaded', catalog })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setCatalogState({ status: 'forbidden' })
        } else {
          setCatalogState({
            status: 'error',
            message: errorMessageFor(error, 'Could not load the permission catalog.'),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [catalogReloadToken])

  const handleRoleRetry = useCallback(() => setRoleReloadToken((t) => t + 1), [])
  const handleCatalogRetry = useCallback(() => setCatalogReloadToken((t) => t + 1), [])

  // --- Header (inline name/description PATCH) ---
  const handleNameInputChange = useCallback((value: string, role: RoleDetail) => {
    setHeaderEdit((prev) => ({ name: value, description: prev?.description ?? role.description ?? '' }))
  }, [])

  const handleDescriptionInputChange = useCallback((value: string, role: RoleDetail) => {
    setHeaderEdit((prev) => ({ name: prev?.name ?? role.name, description: value }))
  }, [])

  const handleSaveHeader = useCallback(async () => {
    if (!headerEdit) return
    setHeaderSave({ saving: true, nameError: null, generalError: null })
    try {
      const updated = await adminApi.patchRole(id, {
        name: headerEdit.name,
        description: headerEdit.description.trim() || null,
      })
      setRoleState((prev) =>
        prev.status === 'loaded' ? { status: 'loaded', role: { ...prev.role, ...updated } } : prev,
      )
      setHeaderEdit({ name: updated.name, description: updated.description ?? '' })
      setHeaderSave({ saving: false, nameError: null, generalError: null })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setHeaderSave({
          saving: false,
          nameError: error.detail ?? 'A role with this name already exists.',
          generalError: null,
        })
      } else {
        setHeaderSave({ saving: false, nameError: null, generalError: 'Could not save changes. Try again.' })
      }
    }
  }, [headerEdit, id])

  // --- Delete ---
  const handleDeleteConfirm = useCallback(async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await adminApi.deleteRole(id)
      navigate({ to: '/roles' })
    } catch (error) {
      setDeleting(false)
      if (error instanceof ApiError && error.status === 422) {
        setDeleteModalOpen(false)
        setGuardrail({ title: "Can't delete a system role", message: error.detail ?? "System roles can't be deleted." })
      } else {
        setDeleteError('Delete failed. Try again.')
      }
    }
  }, [id, navigate])

  // --- Rule composer ---
  const catalog = catalogState.status === 'loaded' ? catalogState.catalog : null

  const selectedResource = useMemo(() => {
    if (!catalog || !composer.resourceChoice) return undefined
    const idx = composer.resourceChoice.indexOf('::')
    if (idx === -1) return undefined
    return findResource(catalog, composer.resourceChoice.slice(0, idx), composer.resourceChoice.slice(idx + 2))
  }, [catalog, composer.resourceChoice])

  const selectedAction: CatalogAction | undefined = useMemo(
    () => selectedResource?.actions.find((a) => a.key === composer.actionKey),
    [selectedResource, composer.actionKey],
  )

  const supportsOwnership = selectedAction?.supportedConditions.includes('ownership') ?? false
  const availableAttributeKeys = useMemo(
    () => ATTRIBUTE_KEYS.filter((key) => selectedAction?.supportedConditions.includes(key)),
    [selectedAction],
  )
  // AC-1.6/US-4/D3: offered only when the selected action's catalog entry
  // declares it (today, `request.approve` only) — never inferred/defaulted.
  const supportsSelfApproval = selectedAction?.supportedConditions.includes(SELF_APPROVAL_KEY) ?? false

  const handleComposerOpen = useCallback(() => setComposer({ ...CLOSED_COMPOSER, open: true }), [])
  const handleComposerCancel = useCallback(() => setComposer(CLOSED_COMPOSER), [])

  const handleResourceChange = useCallback((value: string) => {
    setComposer((prev) => ({
      ...prev,
      resourceChoice: value || null,
      actionKey: null,
      ownership: 'any',
      attributes: new Set(),
      selfApproval: false,
      statusMessage: 'Action reset. Choose an action to see its available conditions.',
    }))
  }, [])

  const handleActionChange = useCallback(
    (value: string) => {
      const supported: ConditionType[] =
        selectedResource?.actions.find((a) => a.key === value)?.supportedConditions ?? []
      const labels = supported.map((c) => (c === 'ownership' ? 'ownership' : ATTRIBUTE_LABELS[c].toLowerCase()))
      setComposer((prev) => ({
        ...prev,
        actionKey: value || null,
        ownership: 'any',
        attributes: new Set(),
        selfApproval: false,
        statusMessage:
          labels.length > 0 ? `Conditions available: ${labels.join(', ')}.` : 'This action has no conditions.',
      }))
    },
    [selectedResource],
  )

  const handleOwnershipChange = useCallback((value: OwnershipCondition) => {
    setComposer((prev) => ({ ...prev, ownership: value }))
  }, [])

  const handleAttributeToggle = useCallback((key: AttributeConditionKey) => {
    setComposer((prev) => {
      const next = new Set(prev.attributes)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return { ...prev, attributes: next }
    })
  }, [])

  // Independent of `handleAttributeToggle`/`attributes` (AC-1.3): toggling
  // the self-approval restriction never touches the entity/department/
  // jobTitle selection, and vice versa.
  const handleSelfApprovalToggle = useCallback(() => {
    setComposer((prev) => ({ ...prev, selfApproval: !prev.selfApproval }))
  }, [])

  const handleAddRule = useCallback(() => {
    if (!selectedResource || !selectedAction) return

    let conditions: RuleConditions | null = null
    if (supportsOwnership || composer.attributes.size > 0 || composer.selfApproval) {
      conditions = {}
      if (supportsOwnership) conditions.ownership = composer.ownership
      const attributeEntries: AttributeCondition[] = availableAttributeKeys
        .filter((key) => composer.attributes.has(key))
        .map((key) => ({ key, match: 'user' as const }))
      // Self-approval composes independently, alongside any entity/department/
      // jobTitle attributes — both persist as separate `attributes[]` entries
      // on the same rule (AC-1.3/AC-2.4, ADR-0026's `match:"deny"` sentinel).
      if (composer.selfApproval) attributeEntries.push({ key: SELF_APPROVAL_KEY, match: 'deny' })
      if (attributeEntries.length > 0) conditions.attributes = attributeEntries
    }

    const rule: PermissionRule = { resource: selectedResource.key, action: selectedAction.key, conditions }
    setDraftRules((prev) => [...(prev ?? []), rule])
    setComposer(CLOSED_COMPOSER)
  }, [
    selectedResource,
    selectedAction,
    supportsOwnership,
    composer.attributes,
    composer.ownership,
    composer.selfApproval,
    availableAttributeKeys,
  ])

  const handleRemoveRule = useCallback((index: number) => {
    setDraftRules((prev) => (prev ? prev.filter((_, i) => i !== index) : prev))
  }, [])

  const handleDiscardRules = useCallback(() => {
    setRoleState((prev) => {
      if (prev.status === 'loaded') setDraftRules(prev.role.rules)
      return prev
    })
  }, [])

  const handleSaveRules = useCallback(async () => {
    if (!draftRules) return
    setSaveRulesState({ saving: true, error: null })
    try {
      const updated = await adminApi.putRoleRules(id, draftRules)
      setRoleState({ status: 'loaded', role: updated })
      setDraftRules(updated.rules)
      setSaveRulesState({ saving: false, error: null })
    } catch (error) {
      setSaveRulesState({
        saving: false,
        error: errorMessageFor(
          error,
          'One or more rules reference a permission that no longer exists — reload the catalog and try again.',
        ),
      })
    }
  }, [draftRules, id])

  const handleReloadCatalogAfterStaleSave = useCallback(() => {
    setSaveRulesState({ saving: false, error: null })
    setCatalogReloadToken((t) => t + 1)
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (roleState.status === 'forbidden' || catalogState.status === 'forbidden') {
    return <PermissionDenied />
  }

  if (roleState.status === 'loading' || catalogState.status === 'loading') {
    return (
      <section aria-labelledby="role-editor-heading" data-testid="role-editor-page">
        <h2 id="role-editor-heading" className="sr-only">
          Role editor
        </h2>
        <SkeletonListRows rows={3} />
      </section>
    )
  }

  if (roleState.status === 'error') {
    return (
      <section aria-labelledby="role-editor-heading" data-testid="role-editor-page">
        <h2 id="role-editor-heading" className="sr-only">
          Role editor
        </h2>
        <ErrorBanner message={roleState.message} onRetry={handleRoleRetry} />
      </section>
    )
  }

  const role = roleState.role
  const rules = draftRules ?? []
  const catalogReady = catalogState.status === 'loaded'

  return (
    <section aria-labelledby="role-editor-heading" data-testid="role-editor-page">
      <h2 id="role-editor-heading" className="sr-only">
        {role.name}
      </h2>

      {deleteModalOpen && (
        <ConfirmDeleteModal
          entityLabel="role"
          itemName={role.name}
          isDeleting={deleting}
          errorMessage={deleteError}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => {
            setDeleteModalOpen(false)
            setDeleteError(null)
          }}
        />
      )}

      {guardrail && (
        <GuardrailDialog title={guardrail.title} message={guardrail.message} onAcknowledge={() => setGuardrail(null)} />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={headerEdit?.name ?? role.name}
              onChange={(e) => handleNameInputChange(e.target.value, role)}
              aria-label="Role name"
              data-testid="role-name-input"
              className="text-lg font-semibold px-2 py-1 border rounded"
              style={{
                fontFamily: 'var(--disp)',
                borderColor: headerSave.nameError ? 'var(--red)' : 'transparent',
                color: 'var(--text)',
                backgroundColor: 'transparent',
              }}
            />
            {role.isSystem && <SystemBadge />}
          </div>
          <textarea
            value={headerEdit?.description ?? role.description ?? ''}
            onChange={(e) => handleDescriptionInputChange(e.target.value, role)}
            aria-label="Role description"
            data-testid="role-description-input"
            rows={2}
            className="text-sm px-2 py-1 border rounded resize-none"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'transparent' }}
          />
          {headerSave.nameError && (
            <p role="alert" data-testid="role-name-error" className="text-xs" style={{ color: 'var(--red)' }}>
              {headerSave.nameError}
            </p>
          )}
          {headerSave.generalError && (
            <p role="alert" className="text-xs" style={{ color: 'var(--red)' }}>
              {headerSave.generalError}
            </p>
          )}
          <div>
            <button
              type="button"
              onClick={() => void handleSaveHeader()}
              disabled={headerSave.saving}
              data-testid="role-header-save"
              className="text-xs font-medium py-1 px-2.5 border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
            >
              {headerSave.saving ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </div>

        <button
          type="button"
          aria-disabled={role.isSystem}
          title={role.isSystem ? "System roles can't be deleted" : undefined}
          onClick={() => {
            if (!role.isSystem) setDeleteModalOpen(true)
          }}
          data-testid="role-delete-button"
          className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
        >
          Delete role
          {role.isSystem && <span className="sr-only"> — System roles can't be deleted</span>}
        </button>
      </div>

      {/* Rule list */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          Rules
        </h3>

        {rules.length === 0 && (
          <p data-testid="rules-empty-state" className="text-sm mt-2" style={{ color: 'var(--soft)' }}>
            No rules yet — every user with this role has no permissions until you add one.
          </p>
        )}

        {rules.length > 0 && (
          <ul data-testid="role-rules-list" className="flex flex-col gap-2 mt-2">
            {rules.map((rule, index) => {
              const label = `${labelForResource(catalog, rule.resource)} · ${labelForAction(catalog, rule.resource, rule.action)}`
              return (
                <li
                  key={`${rule.resource}-${rule.action}-${index}`}
                  data-testid={`role-rule-${index}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 border rounded"
                  style={{ borderColor: 'var(--rule)' }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                      {label}
                    </span>
                    {chipsForConditions(rule.conditions).map((kind, chipIndex) => (
                      <ConditionChip key={`${kind}-${chipIndex}`} kind={kind} />
                    ))}
                  </div>
                  {catalogReady && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRule(index)}
                      data-testid={`role-rule-remove-${index}`}
                      aria-label={`Remove rule ${label}`}
                      className="text-lg leading-none transition-opacity hover:opacity-80"
                      style={{ color: 'var(--muted)' }}
                    >
                      ×
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Rule composer */}
      {catalogState.status === 'error' && (
        <div className="mt-4">
          <ErrorBanner message={catalogState.message} onRetry={handleCatalogRetry} />
        </div>
      )}

      {catalogReady && catalogState.status === 'loaded' && (
        <div className="mt-4">
          {!composer.open && (
            <button
              type="button"
              onClick={handleComposerOpen}
              data-testid="rule-composer-toggle"
              className="text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              + Add rule
            </button>
          )}

          {composer.open && (
            <div className="border rounded p-4 mt-2" style={{ borderColor: 'var(--rule)' }} data-testid="rule-composer">
              <fieldset className="flex flex-col gap-3">
                <legend className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>
                  Resource &amp; action
                </legend>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="rule-composer-resource"
                    className="text-xs font-medium"
                    style={{ color: 'var(--soft)' }}
                  >
                    Resource
                  </label>
                  <select
                    id="rule-composer-resource"
                    data-testid="rule-composer-resource"
                    value={composer.resourceChoice ?? ''}
                    onChange={(e) => handleResourceChange(e.target.value)}
                    className="text-sm px-2.5 py-1.5 border rounded"
                    style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
                  >
                    <option value="" disabled>
                      Select a resource…
                    </option>
                    {catalogState.catalog.map((app) => (
                      <optgroup key={app.appId} label={humanizeAppId(app.appId)}>
                        {app.resources.map((res) => (
                          <option key={`${app.appId}::${res.key}`} value={`${app.appId}::${res.key}`}>
                            {res.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="rule-composer-action"
                    className="text-xs font-medium"
                    style={{ color: 'var(--soft)' }}
                  >
                    Action
                  </label>
                  <select
                    id="rule-composer-action"
                    data-testid="rule-composer-action"
                    value={composer.actionKey ?? ''}
                    onChange={(e) => handleActionChange(e.target.value)}
                    disabled={!selectedResource}
                    className="text-sm px-2.5 py-1.5 border rounded"
                    style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
                  >
                    <option value="" disabled>
                      Select an action…
                    </option>
                    {selectedResource?.actions.map((action) => (
                      <option key={action.key} value={action.key}>
                        {action.label}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>

              {/* AC-2.3 a11y hotspot: announces Action-reset / available-conditions changes */}
              <p aria-live="polite" data-testid="rule-composer-status" className="sr-only">
                {composer.statusMessage}
              </p>

              <fieldset className="mt-4 flex flex-col gap-3">
                <legend className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>
                  Conditions
                </legend>

                {!selectedAction && (
                  <p className="text-xs" style={{ color: 'var(--soft)' }}>
                    Choose a resource and action first.
                  </p>
                )}

                {selectedAction &&
                  !supportsOwnership &&
                  availableAttributeKeys.length === 0 &&
                  !supportsSelfApproval && (
                    <p data-testid="rule-composer-no-conditions" className="text-xs" style={{ color: 'var(--soft)' }}>
                      This action has no conditions.
                    </p>
                  )}

                {selectedAction && supportsOwnership && (
                  <div>
                    <span
                      id="rule-composer-ownership-label"
                      className="text-xs font-medium"
                      style={{ color: 'var(--soft)' }}
                    >
                      Ownership
                    </span>
                    <div
                      role="radiogroup"
                      aria-labelledby="rule-composer-ownership-label"
                      className="flex items-center gap-4 mt-1"
                    >
                      <label className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
                        <input
                          type="radio"
                          name="rule-composer-ownership"
                          checked={composer.ownership === 'any'}
                          onChange={() => handleOwnershipChange('any')}
                          data-testid="rule-composer-ownership-any"
                        />
                        Any records
                      </label>
                      <label className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
                        <input
                          type="radio"
                          name="rule-composer-ownership"
                          checked={composer.ownership === 'own'}
                          onChange={() => handleOwnershipChange('own')}
                          data-testid="rule-composer-ownership-own"
                        />
                        Own records only
                      </label>
                    </div>
                  </div>
                )}

                {selectedAction && availableAttributeKeys.length > 0 && (
                  <fieldset>
                    <legend className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                      Attribute conditions
                    </legend>
                    <div className="flex items-center gap-4 mt-1">
                      {availableAttributeKeys.map((key) => (
                        <div key={key} className="flex items-center gap-1">
                          <label className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
                            <input
                              type="checkbox"
                              checked={composer.attributes.has(key)}
                              onChange={() => handleAttributeToggle(key)}
                              data-testid={`rule-composer-attr-${key}`}
                            />
                            {ATTRIBUTE_LABELS[key]}
                          </label>
                          {/* Help affordance — native `title` tooltip (house pattern); outside the
                              <label> so clicking/focusing it never toggles the checkbox. */}
                          <span
                            role="img"
                            tabIndex={0}
                            aria-label={`${ATTRIBUTE_LABELS[key]} condition — ${ATTRIBUTE_HELP[key]}`}
                            title={ATTRIBUTE_HELP[key]}
                            data-testid={`rule-composer-attr-${key}-help`}
                            className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold cursor-help select-none"
                            style={{ border: '1px solid var(--rule)', color: 'var(--soft)' }}
                          >
                            ?
                          </span>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                )}

                {/*
                 * Self-approval restriction (specs/010-self-approval-control T4,
                 * ADR-0026) — deliberately its OWN fieldset, separate from the
                 * entity/department/jobTitle group above (AC-1.1): opposite
                 * polarity (`match:"deny"` vs `match:"user"`), independently
                 * toggleable, and composes with — never replaces — the entity
                 * condition (AC-1.3/AC-2.4).
                 */}
                {selectedAction && supportsSelfApproval && (
                  <fieldset>
                    <legend className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                      Segregation of duties
                    </legend>
                    <div className="flex items-center gap-1 mt-1">
                      <label className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
                        <input
                          type="checkbox"
                          checked={composer.selfApproval}
                          onChange={handleSelfApprovalToggle}
                          data-testid="rule-composer-self-approval"
                        />
                        Cannot approve own request
                      </label>
                      {/* Help affordance — same house pattern as the attribute-condition tooltips above. */}
                      <span
                        role="img"
                        tabIndex={0}
                        aria-label={`Self-approval restriction condition — ${ATTRIBUTE_HELP['self-approval']}`}
                        title={ATTRIBUTE_HELP['self-approval']}
                        data-testid="rule-composer-self-approval-help"
                        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold cursor-help select-none"
                        style={{ border: '1px solid var(--rule)', color: 'var(--soft)' }}
                      >
                        ?
                      </span>
                    </div>
                  </fieldset>
                )}
              </fieldset>

              <div className="flex items-center justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={handleComposerCancel}
                  data-testid="rule-composer-cancel"
                  className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddRule}
                  disabled={!selectedResource || !selectedAction}
                  data-testid="rule-composer-add"
                  className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
                >
                  Add rule
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer — Save / Discard */}
      <div className="mt-4">
        {saveRulesState.error && (
          <div className="mb-2">
            <ErrorBanner
              message={saveRulesState.error}
              onRetry={handleReloadCatalogAfterStaleSave}
              retryLabel="Reload catalog"
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSaveRules()}
            disabled={saveRulesState.saving || !catalogReady}
            data-testid="role-save-rules"
            className="py-1.5 px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--acc)' }}
          >
            {saveRulesState.saving ? 'Saving…' : 'Save rules'}
          </button>
          <button
            type="button"
            onClick={handleDiscardRules}
            data-testid="role-discard-rules"
            className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
            style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
          >
            Discard changes
          </button>
        </div>
      </div>
    </section>
  )
}
