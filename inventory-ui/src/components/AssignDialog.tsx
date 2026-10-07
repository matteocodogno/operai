import { useEffect, useState } from 'react'
import Combobox from './Combobox'
import type { ComboboxOption } from './Combobox'
import FormModal from './FormModal'
import { ApiError } from '../lib/api'
import { createAssignment } from '../lib/assignmentsApi'
import { listDirectory } from '../lib/directoryApi'
import { toInventoryError } from '../lib/types'
import type { AssetView, DirectoryUser, Entity } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * AssignDialog — "Assign..." (T33, specs/015-hardware-inventory; design.md F3,
 * § Dialogs, § Accessibility "Holder picker"; AC-2.1, AC-2.2, AC-2.10): a
 * `dialog` with one field, the holder picker, a `Combobox` over `auth`'s active
 * user directory (`directoryApi`). The directory is fetched once when the dialog
 * opens and filtered client-side by name or email.
 *
 * The picker's states render INSIDE the listbox and are announced through the
 * combobox's live region: loading, "No active users match", and a failed lookup
 * (the 429 with its `Retry-After` wait, or any other failure) — each failure
 * with a Retry button under the field.
 *
 * Errors of the assignment itself: `unknown_user` stays in the dialog so another
 * person can be picked; a stale asset (`invalid_transition`, `assignment_pending`,
 * `asset_disposed`, or a 404) is handed to the page with `onConflict` — it owns
 * the guardrail and the refetch; anything else (503, network) is an inline alert
 * that keeps the choice.
 */

export type AssignDialogProps = {
  asset: AssetView
  /** The updated asset, carrying the new `pendingAssignment`. The caller closes the dialog. */
  onAssigned: (updated: AssetView) => void
  onCancel: () => void
  /** The assignment met a stale asset; `error` is the thrown `ApiError`. */
  onConflict: (error: unknown) => void
}

type DirectoryOutcome =
  { attempt: number; ok: true; users: DirectoryUser[] } | { attempt: number; ok: false; error: unknown }

const lookupMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 429) {
    return error.retryAfterSeconds !== null
      ? fillTemplate(strings.errors.tooManyLookups, { n: error.retryAfterSeconds })
      : strings.errors.tooManyLookupsNoDelay
  }
  return error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network
}

const entityLabel = (entity: string | null): string | null =>
  entity === null ? null : (strings.common.entity[entity as Entity] ?? entity)

const toOption = (user: DirectoryUser): ComboboxOption => ({
  id: user.id,
  label: user.name ?? strings.actions.assignDialog.optionNoName,
  secondaryLabel: strings.actions.assignDialog.optionDetail(user.email, entityLabel(user.entity)),
})

export default function AssignDialog({ asset, onAssigned, onCancel, onConflict }: AssignDialogProps) {
  const t = strings.actions.assignDialog
  const [attempt, setAttempt] = useState(0)
  const [directory, setDirectory] = useState<DirectoryOutcome | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ComboboxOption | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [generalError, setGeneralError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listDirectory({ signal: controller.signal }).then(
      ({ users }) => {
        if (!controller.signal.aborted) setDirectory({ attempt, ok: true, users })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDirectory({ attempt, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [attempt])

  const current = directory?.attempt === attempt ? directory : null
  const loading = current === null
  const failure = current !== null && !current.ok ? lookupMessage(current.error) : null
  const users = current?.ok ? current.users : []

  const needle = query.trim().toLowerCase()
  const options = users
    .filter((user) => needle === '' || `${user.name ?? ''} ${user.email}`.toLowerCase().includes(needle))
    .map(toOption)

  const emptyMessage = loading ? t.loading : (failure ?? t.empty)
  const liveText = loading ? t.loading : failure !== null ? failure : options.length === 0 ? t.empty : ''

  const submit = async () => {
    if (selected === null) return
    setGeneralError(null)
    setSubmitting(true)
    try {
      onAssigned(await createAssignment(asset.id, selected.id))
    } catch (error) {
      const known = toInventoryError(error)
      if (known?.code === 'unknown_user') {
        setGeneralError(strings.errors.unknown_user)
      } else if (
        known?.code === 'invalid_transition' ||
        known?.code === 'assignment_pending' ||
        known?.code === 'asset_disposed' ||
        (error instanceof ApiError && error.status === 404)
      ) {
        onConflict(error)
      } else if (error instanceof ApiError && error.status === 503) {
        setGeneralError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      } else {
        setGeneralError(error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormModal
      title={t.title}
      description={t.description(asset.description)}
      submitLabel={t.submit}
      submittingLabel={t.submitting}
      submitting={submitting}
      canSubmit={selected !== null}
      generalError={generalError}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      testIdPrefix="assign-asset"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="assign-holder" className="text-xs" style={{ color: 'var(--soft)' }}>
          {t.holder}
        </label>
        <Combobox
          id="assign-holder"
          testId="assign-holder"
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            setSelected(null)
            setOpen(true)
          }}
          options={options}
          onSelect={(option) => {
            setSelected(option)
            setQuery(option.label)
          }}
          isOpen={open}
          onOpenChange={setOpen}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={t.holderPlaceholder}
          emptyState={emptyMessage}
          liveRegionText={liveText}
        />
        {failure !== null && (
          <button
            type="button"
            onClick={() => {
              setAttempt((n) => n + 1)
            }}
            className="self-start border px-2.5 py-1 text-xs font-medium"
            style={{ borderColor: 'var(--org)', color: 'var(--org)' }}
          >
            {t.retry}
          </button>
        )}
      </div>
    </FormModal>
  )
}
