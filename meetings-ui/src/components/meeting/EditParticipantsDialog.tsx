import { Badge, Button, Field, FormDialog, Icon, PersonPicker } from '@operai/ui'
import type { PersonChoice, PersonLoadFailure } from '@operai/ui'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { listDirectory, replaceParticipants } from '../../lib/meetingsApi'
import type { ParticipantInput } from '../../lib/meetingsApi'
import type { Meeting, Participant } from '../../lib/types'
import { strings } from '../../strings'

export type EditParticipantsDialogProps = {
  meeting: Meeting
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

const MAX_PARTICIPANTS = 30
const NAME_MAX = 100
const ORGANISATION_MAX = 100
/** What to wait when the directory says "later" without saying how long. */
const DEFAULT_RETRY_SECONDS = 60

type Entry =
  | { key: string; kind: 'operai'; userId: string; name: string | null; deleted: boolean }
  | { key: string; kind: 'external'; name: string; organisation: string | null }

const toEntry = (participant: Participant): Entry =>
  participant.kind === 'operai'
    ? {
        key: participant.id,
        kind: 'operai',
        userId: participant.person.id,
        name: participant.person.name,
        deleted: participant.person.status === 'deleted',
      }
    : { key: participant.id, kind: 'external', name: participant.name, organisation: participant.organisation }

const toInput = (entry: Entry): ParticipantInput =>
  entry.kind === 'operai'
    ? { userId: entry.userId }
    : entry.organisation !== null
      ? { name: entry.name, organisation: entry.organisation }
      : { name: entry.name }

const displayName = (entry: Entry): string => {
  const t = strings.participants.card
  if (entry.kind === 'external') return entry.name
  return entry.name ?? (entry.deleted ? t.deletedUser : t.unknownUser)
}

/** How the picker reads a failed directory call (it knows nothing of our HTTP client). */
const classifyDirectoryError = (error: unknown): PersonLoadFailure => {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: 'forbidden' }
    if (error.status === 429)
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS }
  }
  return { kind: 'failed' }
}

const loadDirectory = async (signal: AbortSignal) => (await listDirectory({ signal })).users

/** Where focus goes once a removed row has gone: the next Remove button, else the Operai picker (S4). */
type FocusTarget = { kind: 'remove'; key: string } | { kind: 'picker' } | null

/**
 * EditParticipantsDialog — who can read this meeting (S4; AC-5.1, AC-5.4). Operai people come from
 * the library `PersonPicker` over the user directory, called WITHOUT `appId` because a participant
 * needs no tool grant (AC-10.4, plan G9); external people have a name (1 to 100 characters) and an
 * optional organisation. At most 30 in all: at the limit both adders step out of reach and the
 * limit is stated. Save is a full replace (`PUT`), and a person without an active account is named
 * on their own row. A deleted user stays in the list, shown as deleted, so they can be removed.
 */
export default function EditParticipantsDialog({ meeting, onClose, onChanged }: EditParticipantsDialogProps) {
  const t = strings.participants.dialog
  const [entries, setEntries] = useState<Entry[]>(() => meeting.participants.map(toEntry))
  const [name, setName] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [externalErrors, setExternalErrors] = useState<{ name?: string; organisation?: string }>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nextKey = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const focusAfter = useRef<FocusTarget>(null)

  const atLimit = entries.length >= MAX_PARTICIPANTS

  useEffect(() => {
    const target = focusAfter.current
    if (target === null) return
    focusAfter.current = null
    const root = rootRef.current
    if (root === null) return
    if (target.kind === 'remove') {
      const wanted = target.key
      Array.from(root.querySelectorAll<HTMLElement>('[data-remove-key]'))
        .find((button) => button.getAttribute('data-remove-key') === wanted)
        ?.focus()
    } else {
      root.querySelector<HTMLElement>('[role="combobox"]')?.focus()
    }
  }, [entries])

  const freshKey = () => `new-${nextKey.current++}`

  const pick = (choice: PersonChoice | null) => {
    if (choice === null || atLimit) return
    if (entries.some((entry) => entry.kind === 'operai' && entry.userId === choice.id)) return
    setEntries((current) => [
      ...current,
      { key: freshKey(), kind: 'operai', userId: choice.id, name: choice.label, deleted: false },
    ])
  }

  const addExternal = () => {
    if (atLimit) return
    const trimmedName = name.trim()
    const trimmedOrganisation = organisation.trim()
    const errors: { name?: string; organisation?: string } = {}
    if (trimmedName === '') errors.name = t.errors.nameRequired
    else if (trimmedName.length > NAME_MAX) errors.name = t.errors.nameTooLong
    if (trimmedOrganisation.length > ORGANISATION_MAX) errors.organisation = t.errors.organisationTooLong
    setExternalErrors(errors)
    if (errors.name !== undefined || errors.organisation !== undefined) {
      if (errors.name !== undefined) nameRef.current?.focus()
      return
    }
    setEntries((current) => [
      ...current,
      {
        key: freshKey(),
        kind: 'external',
        name: trimmedName,
        organisation: trimmedOrganisation === '' ? null : trimmedOrganisation,
      },
    ])
    setName('')
    setOrganisation('')
    nameRef.current?.focus()
  }

  const remove = (index: number) => {
    const following = entries[index + 1]
    focusAfter.current = following !== undefined ? { kind: 'remove', key: following.key } : { kind: 'picker' }
    setEntries((current) => current.filter((_, position) => position !== index))
    setRowErrors({})
  }

  const save = async () => {
    const payload = entries.map(toInput)
    if (JSON.stringify(payload) === JSON.stringify(meeting.participants.map(toEntry).map(toInput))) {
      onClose()
      return
    }
    setBusy(true)
    setFormError(null)
    setRowErrors({})
    try {
      onChanged(await replaceParticipants(meeting.id, payload))
      onClose()
    } catch (failure) {
      const index =
        failure instanceof ApiError && failure.code === 'participant_not_active' ? failure.extras['index'] : undefined
      const entry = typeof index === 'number' ? entries[index] : undefined
      if (entry !== undefined) setRowErrors({ [entry.key]: t.notActive })
      else setFormError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={t.title}
      description={t.description}
      size="lg"
      submitLabel={t.save}
      busyLabel={t.saving}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onClose}
      testIdPrefix="meetings-participants-dialog"
    >
      <div ref={rootRef} className="flex flex-col gap-4">
        <fieldset disabled={atLimit} className="m-0 min-w-0 border-0 p-0">
          <PersonPicker
            label={t.addOperai}
            load={loadDirectory}
            classifyError={classifyDirectoryError}
            value={null}
            onChange={pick}
            exclude={entries.flatMap((entry) => (entry.kind === 'operai' ? [entry.userId] : []))}
            clearOnSelect
            testId="meetings-participants-picker"
            copy={t.picker}
          />
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className="field-label">{t.addExternal}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.name} error={externalErrors.name}>
              {(control) => (
                <input
                  {...control}
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addExternal()
                    }
                  }}
                />
              )}
            </Field>
            <Field label={t.organisation} error={externalErrors.organisation}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  value={organisation}
                  onChange={(event) => setOrganisation(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addExternal()
                    }
                  }}
                />
              )}
            </Field>
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              aria-disabled={atLimit || undefined}
              aria-describedby={atLimit ? 'meetings-participants-limit' : undefined}
              onClick={addExternal}
            >
              {t.add}
            </Button>
          </div>
        </div>

        <div>
          <p className="text-sm text-soft" aria-live="polite">
            {t.count(entries.length, MAX_PARTICIPANTS)}
          </p>
          {atLimit && (
            <p id="meetings-participants-limit" className="field-hint">
              {t.limit}
            </p>
          )}
          {entries.length === 0 ? (
            <p className="mt-2 text-sm text-soft">{t.empty}</p>
          ) : (
            <ul aria-label={t.listLabel} className="mt-2 flex flex-col divide-y divide-rule">
              {entries.map((entry, index) => {
                const label = displayName(entry)
                const muted = entry.kind === 'operai' && (entry.deleted || entry.name === null)
                return (
                  <li key={entry.key} className="flex flex-wrap items-center gap-2 py-2">
                    <span className={muted ? 'text-sm text-soft' : 'text-sm'}>{label}</span>
                    {entry.kind === 'external' && (
                      <>
                        {entry.organisation !== null && <span className="text-xs text-soft">{entry.organisation}</span>}
                        <Badge>{t.external}</Badge>
                      </>
                    )}
                    {rowErrors[entry.key] !== undefined && (
                      <span role="alert" className="field-error">
                        {rowErrors[entry.key]}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      iconOnly
                      className="ml-auto"
                      aria-label={t.remove(label)}
                      data-remove-key={entry.key}
                      onClick={() => remove(index)}
                    >
                      <Icon name="close" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </FormDialog>
  )
}
