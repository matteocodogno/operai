/**
 * LegalEntityForm — the form of one legal entity the person may change (T37, specs/20261117-legal-entities, design
 * S2/S3, flows F3–F5 and F11; AC-1.1 to 1.5, 2.1, 7.3, 8.1).
 *
 * It is a CONTROLLED view of the page's per-entity draft: what is shown is `draft`, or the entity as last read when
 * there is none, and every change goes up through `onDraftChange` (so typing survives a switch of entity, view or
 * version, T36). Three groups of `Field`s: Company (legal name, VAT number, IBAN), Address (one `AddressLinesField`
 * per language) and the contacts lines; then the sticky save bar.
 *
 * The browser judges nothing (plan decision 10): it trims to tell whether anything changed, counts for the line
 * counters and groups the IBAN on blur. Everything else is auth's answer to a save:
 *
 *   201 `created: true`   the entity answer replaces what was read (so the values come back normalised: blank
 *                         lines closed up, IBAN in groups), the draft is dropped, a compact polite "Version n saved"
 *                         shows over the bar, focus stays on Save.
 *   200 `created: false`  the same without a new version: the polite "Nothing changed" note.
 *   422 problems[]        nothing was saved: the library `ErrorSummary` (assertive) lists every problem in page order,
 *                         each control is `aria-invalid` and described by the same sentence, and focus goes to the
 *                         first refused control, down to the exact address line. The typed values stay.
 *   403                   `onLost()`: the panel turns read-only and drops the draft (the panel says so).
 *   409 version_conflict  the typed values stay and Save waits (T38 mounts the choice to reapply or discard here).
 *   anything else         a warning with Retry; the values and the base version are kept.
 *
 * A save sends what the form holds when it is clicked, blank address lines included and in input order (E5: a
 * problem's `line` is the position in what was submitted). Edits made while the request runs are not in it and stay
 * as an unsaved draft. Controls are never disabled while saving, so focus is not lost.
 *
 * S3: a moved value the rules refuse, and a required value still empty, carry a static `aria-invalid` mark and
 * sentence on their own control (`movedMarks`), not announced; they go the moment the person changes the control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Banner, Card, ErrorSummary, Field, Icon } from '@operai/ui'
import AddressLinesField from './AddressLinesField'
import LegalEntityFormBar from './LegalEntityFormBar'
import {
  addressInputCount,
  controlDomId,
  formBase,
  groupIban,
  inputCountsOf,
  lineKey,
  movedMarks,
  problemsAfterEdit,
  refusalErrors,
  refusalItems,
  saveBlockedReason,
  submissionOf,
} from './LegalEntityFormModel'
import type { ControlKey } from './LegalEntityFormModel'
import { LegalEntityApiError, saveLegalEntity } from '../lib/legalEntitiesApi'
import { changedFieldsBetween, setFieldValue } from '../lib/legalEntityModel'
import type {
  FieldValue,
  LegalEntity,
  LegalEntityDetails,
  LegalEntityField,
  LegalEntityProblem,
} from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type LegalEntityFormProps = {
  /** The entity as last read. */
  entity: LegalEntity
  /** The page's unsaved draft of this entity, when there is one (address lines as typed, blanks included). */
  draft: LegalEntityDetails | undefined
  /** `undefined` drops the draft. */
  onDraftChange: (draft: LegalEntityDetails | undefined) => void
  /** The entity answer of a save: the page keeps it as the entity as last read. */
  onEntityChange: (entity: LegalEntity) => void
  /** A 403 on the save: the person can no longer change this entity. */
  onLost: () => void
}

type Outcome =
  { kind: 'idle' } | { kind: 'saved'; version: number } | { kind: 'noop'; version: number } | { kind: 'failed' }

/** A refused save: the problems still standing, the details that were submitted, and a counter for the focus. */
type Refusal = { problems: LegalEntityProblem[]; submitted: LegalEntityDetails; seq: number }

const errorList = (sentences: readonly string[]): ReactNode =>
  sentences.length > 0 && (
    <>
      {sentences.map((sentence) => (
        <span key={sentence} className="flex items-start gap-1">
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          {sentence}
        </span>
      ))}
    </>
  )

export default function LegalEntityForm({
  entity,
  draft,
  onDraftChange,
  onEntityChange,
  onLost,
}: LegalEntityFormProps) {
  const base = useMemo(() => formBase(entity), [entity])
  const shown = draft ?? base
  const dirty = changedFieldsBetween(shown, entity).length > 0

  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [conflict, setConflict] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // A newer read of the entity (a save, a restore, T38's reload) ends what was said about the version before it.
  const [versionSeen, setVersionSeen] = useState(entity.version)
  if (versionSeen !== entity.version) {
    setVersionSeen(entity.version)
    setRefusal(null)
    setConflict(false)
  }

  // What a click reads: the form as it is NOW, not as it was when the callback was made.
  const latest = useRef({ entity, shown, draft, dirty, conflict, onDraftChange, onEntityChange, onLost })
  useEffect(() => {
    latest.current = { entity, shown, draft, dirty, conflict, onDraftChange, onEntityChange, onLost }
  })
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const refusalSeq = useRef(0)

  const save = useCallback(() => {
    if (inFlight.current) return
    const current = latest.current
    if (saveBlockedReason(current.dirty, current.conflict) !== null) return
    inFlight.current = true
    // What is sent is what the form holds now, its address lines as its inputs hold them (E5).
    const sent = submissionOf(current.shown)
    setSaving(true)
    setOutcome({ kind: 'idle' })
    setRefusal(null)

    saveLegalEntity(current.entity.entity, { baseVersion: current.entity.version, details: sent }).then(
      (result) => {
        inFlight.current = false
        const now = latest.current
        // The version exists whether or not the person is still here: the page keeps the entity either way.
        now.onEntityChange(result.entity)
        if (!alive.current) return
        // Typing made while the request ran is not in what was saved: it stays, as a draft against the new version.
        if (now.draft === undefined || changedFieldsBetween(now.draft, sent).length === 0) now.onDraftChange(undefined)
        setSaving(false)
        setOutcome(
          result.created ? { kind: 'saved', version: result.version } : { kind: 'noop', version: result.version },
        )
      },
      (error: unknown) => {
        inFlight.current = false
        if (!alive.current) return
        setSaving(false)
        if (error instanceof LegalEntityApiError) {
          if (error.status === 403) {
            latest.current.onLost()
            return
          }
          if (error.status === 409 && error.code === 'version_conflict') {
            setConflict(true)
            return
          }
          if (
            error.status === 422 &&
            error.code === 'invalid_legal_entity' &&
            error.problems &&
            error.problems.length > 0
          ) {
            refusalSeq.current += 1
            setRefusal({ problems: error.problems, submitted: sent, seq: refusalSeq.current })
            return
          }
        }
        setOutcome({ kind: 'failed' })
      },
    )
  }, [])

  // After a refusal: the summary is already on screen (it mounted with the refusal); focus goes to the first refused
  // control in page order, the exact address line included. Once per refusal, not again when a fix removes a problem.
  const focusedSeq = useRef(0)
  useEffect(() => {
    if (refusal === null || focusedSeq.current === refusal.seq) return
    focusedSeq.current = refusal.seq
    const first = refusalItems(entity.entity, refusal.problems, refusal.submitted)[0]
    if (first !== undefined) formRef.current?.querySelector<HTMLElement>(`[id="${first.id}"]`)?.focus()
  }, [refusal, entity.entity])

  const focusControl = (id: string) => {
    formRef.current?.querySelector<HTMLElement>(`[id="${id}"]`)?.focus()
  }

  const edit = (field: LegalEntityField, value: FieldValue, key: ControlKey) => {
    onDraftChange(setFieldValue(shown, field, value))
    setRefusal((previous) => {
      if (previous === null) return previous
      const problems = problemsAfterEdit(previous.problems, key, inputCountsOf(previous.submitted))
      return problems.length === 0 ? null : { ...previous, problems }
    })
  }

  const refused = useMemo(
    () => (refusal === null ? new Map<ControlKey, string[]>() : refusalErrors(refusal.problems, refusal.submitted)),
    [refusal],
  )
  const moved = useMemo(() => movedMarks(entity, shown), [entity, shown])
  const errorsOf = (key: ControlKey): readonly string[] => refused.get(key) ?? moved.get(key) ?? []
  const idOf = (key: ControlKey) => controlDomId(entity.entity, key)

  const lineErrors = (language: 'it' | 'en') => {
    const errors = new Map<number, readonly string[]>()
    const count = addressInputCount(shown.address[language])
    for (let index = 0; index < count; index += 1) {
      const own = errorsOf(lineKey(language, index))
      if (own.length > 0) errors.set(index, own)
    }
    return errors
  }

  const summary = refusal === null ? [] : refusalItems(entity.entity, refusal.problems, refusal.submitted)

  const text = (
    field: 'legalName' | 'vatNumber' | 'contacts.it' | 'contacts.en',
    label: string,
    value: string,
    options: { required?: boolean; lang?: 'it' | 'en'; describedBy?: string } = {},
  ) => (
    <Field id={idOf(field)} label={label} required={options.required} error={errorList(errorsOf(field))}>
      {(control) => (
        <input
          {...control}
          type="text"
          lang={options.lang}
          spellCheck={options.lang !== undefined}
          autoComplete="off"
          aria-describedby={[control['aria-describedby'], options.describedBy].filter(Boolean).join(' ') || undefined}
          className="scroll-mb-28"
          value={value}
          onChange={(event) => edit(field, event.target.value, field)}
          data-testid={`admin-legal-input-${field}`}
        />
      )}
    </Field>
  )

  const notice: ReactNode =
    outcome.kind === 'saved' ? (
      <Banner
        tone="success"
        compact
        autoDismiss
        dismissible={false}
        onDismiss={() => setOutcome({ kind: 'idle' })}
        data-testid="admin-legal-saved"
      >
        {t.saved(outcome.version)}
      </Banner>
    ) : outcome.kind === 'noop' ? (
      <Banner
        tone="info"
        compact
        onDismiss={() => setOutcome({ kind: 'idle' })}
        dismissLabel={strings.common.actions.dismiss}
        data-testid="admin-legal-noop"
      >
        {t.noop(outcome.version)}
      </Banner>
    ) : outcome.kind === 'failed' ? (
      <Banner
        tone="warning"
        title={t.saveFailed.title}
        onRetry={save}
        retryLabel={strings.common.actions.retry}
        data-testid="admin-legal-save-failed"
      >
        {t.saveFailed.body}
      </Banner>
    ) : conflict ? (
      // T38 replaces this with the conflict banner and its two actions.
      <Banner tone="warning" title={t.conflict.title} data-testid="admin-legal-conflict">
        {t.bar.reloadFirst}
      </Banner>
    ) : null

  const contactsHintId = `${idOf('contacts')}-hint`

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
      data-testid="admin-legal-form"
    >
      {summary.length > 0 && (
        <ErrorSummary
          title={t.refused.title(summary.length)}
          hint={t.refused.hint}
          items={summary}
          onGo={focusControl}
          testId="admin-legal-summary"
        />
      )}

      <Card title={t.form.group.company} headingLevel={4}>
        <div className="grid gap-4 md:grid-cols-2">
          {text('legalName', t.value.legalName, shown.legalName, { required: true })}
          {text('vatNumber', t.value.vat, shown.vatNumber, { required: true })}
        </div>
        <Field id={idOf('iban')} label={t.value.iban} hint={t.form.ibanHint} error={errorList(errorsOf('iban'))}>
          {(control) => (
            <input
              {...control}
              type="text"
              spellCheck={false}
              autoComplete="off"
              className="scroll-mb-28 font-mono"
              value={shown.iban}
              onChange={(event) => edit('iban', event.target.value, 'iban')}
              // Grouped on blur only, never while typing (the caret and a screen reader's echo would jump), and
              // only when something was typed: an untouched form makes no draft.
              onBlur={() => {
                if (draft === undefined) return
                const grouped = groupIban(draft.iban)
                if (grouped !== draft.iban) onDraftChange(setFieldValue(draft, 'iban', grouped))
              }}
              data-testid="admin-legal-input-iban"
            />
          )}
        </Field>
      </Card>

      <Card title={t.form.group.address} headingLevel={4}>
        <div className="grid gap-6 md:grid-cols-2">
          {(['it', 'en'] as const).map((language) => (
            <AddressLinesField
              key={language}
              language={language}
              legend={language === 'it' ? t.value.addressIt : t.value.addressEn}
              lines={shown.address[language]}
              errors={lineErrors(language)}
              idFor={(index) => idOf(lineKey(language, index))}
              onChange={(lines, index) =>
                edit(language === 'it' ? 'address.it' : 'address.en', lines, lineKey(language, index))
              }
              testIdPrefix="admin-legal-address"
            />
          ))}
        </div>
      </Card>

      <Card title={t.form.group.contacts} headingLevel={4}>
        <p id={contactsHintId} className="field-hint m-0">
          {t.form.contactsHint}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {text('contacts.it', t.value.contactsIt, shown.contacts.it, { lang: 'it', describedBy: contactsHintId })}
          {text('contacts.en', t.value.contactsEn, shown.contacts.en, { lang: 'en', describedBy: contactsHintId })}
        </div>
      </Card>

      <LegalEntityFormBar
        dirty={dirty}
        nextVersion={entity.version + 1}
        saving={saving}
        conflict={conflict}
        notice={notice}
      />
    </form>
  )
}
