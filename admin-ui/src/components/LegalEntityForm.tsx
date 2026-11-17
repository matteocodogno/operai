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
 *   409 version_conflict  the typed values stay and Save waits. The newer version is read (`getVersion`, DR-3) and the
 *                         `ConflictBanner` offers the two ways on (design S2, owner decision Q3=B, AC-2.6):
 *                         "Reapply my changes" merges per value onto the newer version (`mergeOnConflict`): what only
 *                         the person changed is kept, what only the other changed is taken, and a value both changed
 *                         to different things keeps the person's and says what the other saved, with "Use theirs".
 *                         Focus goes to the first such value (to Save when there is none) and Save then makes version
 *                         n+1. "Discard my changes" drops the draft and shows version n. Either way only THIS entity's
 *                         draft is touched; the page keeps one per entity.
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
import { Banner, Button, Card, ErrorSummary, Field, Icon } from '@operai/ui'
import AddressLinesField from './AddressLinesField'
import ConflictBanner from './ConflictBanner'
import type { ConflictRead } from './ConflictBanner'
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
import { LegalEntityApiError, getLegalEntity, getVersion, saveLegalEntity } from '../lib/legalEntitiesApi'
import { mergeOnConflict, takeTheirs } from '../lib/legalEntityMerge'
import type { FlaggedValue } from '../lib/legalEntityMerge'
import { valueNameList } from '../lib/legalEntityMappings'
import {
  changedFieldsBetween,
  cleanText,
  detailsOf,
  getFieldValue,
  isAddressField,
  addressLanguage,
  normalizeLines,
  sameFieldValue,
  setFieldValue,
} from '../lib/legalEntityModel'
import type {
  FieldValue,
  LegalEntity,
  LegalEntityDetails,
  LegalEntityField,
  LegalEntityProblem,
  LegalEntityVersion,
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

/**
 * What "Reapply my changes" left to look at, for the version it was applied to: the values both people changed (the
 * person's kept, the other's offered) and the values taken from the newer version because the person had not changed
 * them. It is about version `version` only; once the entity moves on (a save, a newer read) it no longer shows.
 */
type Review = {
  version: number
  who: string
  /** The newer version's values as the form shows them (IBAN in groups). */
  theirs: LegalEntityDetails
  flagged: FlaggedValue[]
  taken: LegalEntityField[]
}

/** The entity answer inside a version answer. */
const entityOf = (version: LegalEntityVersion): LegalEntity => ({
  ...detailsOf(version),
  entity: version.entity,
  version: version.version,
  updatedAt: version.updatedAt,
  ibanPrint: version.ibanPrint,
  complete: version.complete,
  missing: [...version.missing],
  invalid: [...version.invalid],
})

/** The control that takes focus for a value: its input, or the first line of an address. */
const firstControlOf = (field: LegalEntityField): ControlKey =>
  isAddressField(field) ? lineKey(addressLanguage(field), 0) : field

/** A value in one line of a sentence: an address's lines joined, "Empty" for nothing. */
const spoken = (value: FieldValue): string => {
  const text = Array.isArray(value) ? normalizeLines(value).join(' / ') : cleanText(value)
  return text === '' ? t.value.empty : text
}

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
  const [conflict, setConflict] = useState<ConflictRead | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ seq: number; target: string } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const reapplyRef = useRef<HTMLButtonElement>(null)

  // A newer read of the entity (a save, a restore, T38's reload) ends what was said about the version before it.
  const [versionSeen, setVersionSeen] = useState(entity.version)
  if (versionSeen !== entity.version) {
    setVersionSeen(entity.version)
    setRefusal(null)
    setConflict(null)
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

  // The newer version, read for the banner and for Reapply. Stale answers (the entity moved on meanwhile) are dropped.
  const conflictTarget = useRef<number | undefined>(undefined)
  const readNewer = useCallback((currentVersion: number | undefined) => {
    const { entity: read } = latest.current
    conflictTarget.current = currentVersion
    setConflict({ kind: 'loading' })
    const request =
      currentVersion !== undefined
        ? getVersion(read.entity, currentVersion)
        : getLegalEntity(read.entity).then((newest) => getVersion(read.entity, newest.version))
    request.then(
      (version) => {
        if (!alive.current || latest.current.entity.version !== read.version) return
        setConflict(
          version.version > read.version
            ? { kind: 'ready', version, changed: changedFieldsBetween(read, version) }
            : { kind: 'failed' },
        )
      },
      () => {
        if (!alive.current || latest.current.entity.version !== read.version) return
        setConflict({ kind: 'failed' })
      },
    )
  }, [])

  const save = useCallback(() => {
    if (inFlight.current) return
    const current = latest.current
    if (saveBlockedReason(current.dirty, current.conflict !== null) !== null) return
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
            readNewer(error.currentVersion)
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
  }, [readNewer])

  // After a refusal: the summary is already on screen (it mounted with the refusal); focus goes to the first refused
  // control in page order, the exact address line included. Once per refusal, not again when a fix removes a problem.
  const focusedSeq = useRef(0)
  useEffect(() => {
    if (refusal === null || focusedSeq.current === refusal.seq) return
    focusedSeq.current = refusal.seq
    const first = refusalItems(entity.entity, refusal.problems, refusal.submitted)[0]
    if (first !== undefined) formRef.current?.querySelector<HTMLElement>(`[id="${first.id}"]`)?.focus()
  }, [refusal, entity.entity])

  // Focus the banner's primary action when the newer version has been read, once per conflict: Save has just refused,
  // and the choice is above the fields (the person would otherwise tab back through all of them).
  const readyVersion = conflict?.kind === 'ready' ? conflict.version.version : null
  useEffect(() => {
    if (readyVersion !== null) reapplyRef.current?.focus()
  }, [readyVersion])

  // A focus the handlers asked for after their change has rendered: a control id, or `save`.
  const focusSeq = useRef(0)
  useEffect(() => {
    if (focusRequest === null || focusSeq.current === focusRequest.seq) return
    focusSeq.current = focusRequest.seq
    if (focusRequest.target === 'save') saveRef.current?.focus()
    else formRef.current?.querySelector<HTMLElement>(`[id="${focusRequest.target}"]`)?.focus()
  }, [focusRequest])
  const requestFocus = (target: string) => setFocusRequest((previous) => ({ seq: (previous?.seq ?? 0) + 1, target }))

  /** "Reapply my changes to version n": the merge puts the person's values on the newer version (AC-2.6). */
  const reapply = () => {
    const now = latest.current
    if (now.conflict?.kind !== 'ready') return
    const { version } = now.conflict
    const theirs = formBase(entityOf(version))
    const merged = mergeOnConflict({ base: formBase(now.entity), mine: now.shown, theirs })
    const taken = (Object.keys(merged.outcomes) as LegalEntityField[]).filter(
      (field) => merged.outcomes[field] === 'theirs',
    )
    setReview({
      version: version.version,
      who: version.createdBy?.name ?? t.history.system,
      theirs,
      flagged: merged.flagged,
      taken,
    })
    now.onEntityChange(entityOf(version))
    // Nothing of the person's left to save (they only changed what the other also changed to): no draft.
    now.onDraftChange(changedFieldsBetween(merged.details, version).length > 0 ? merged.details : undefined)
    const first = merged.flagged[0]
    requestFocus(first === undefined ? 'save' : controlDomId(now.entity.entity, firstControlOf(first.field)))
  }

  /** "Discard my changes and load version n". */
  const discard = () => {
    const now = latest.current
    if (now.conflict?.kind !== 'ready') return
    setReview(null)
    now.onEntityChange(entityOf(now.conflict.version))
    now.onDraftChange(undefined)
    requestFocus('save')
  }

  const takeFromTheirs = (flagged: FlaggedValue) => {
    onDraftChange(takeTheirs(shown, flagged))
    requestFocus(idOf(firstControlOf(flagged.field)))
  }

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

  // What Reapply left to look at: flagged values still holding the person's own, and values taken from the other.
  const reviewing = review !== null && review.version === entity.version ? review : null
  const flaggedNow = (reviewing?.flagged ?? []).filter(
    (item) => !sameFieldValue(item.field, getFieldValue(shown, item.field), item.theirs),
  )
  const flaggedFor = (field: LegalEntityField) => flaggedNow.find((item) => item.field === field)
  const takenNow = (field: LegalEntityField) =>
    reviewing !== null &&
    reviewing.taken.includes(field) &&
    sameFieldValue(field, getFieldValue(shown, field), getFieldValue(reviewing.theirs, field))

  /** The sentence under a value Reapply touched: the other's value and "Use theirs", or where it was taken from. */
  const reviewNote = (field: LegalEntityField): ReactNode => {
    if (reviewing === null) return null
    const flagged = flaggedFor(field)
    if (flagged !== undefined) {
      const noteId = `${idOf(firstControlOf(field))}-also`
      return (
        <>
          <span id={noteId}>{t.conflict.alsoChanged(reviewing.version, reviewing.who, spoken(flagged.theirs))}</span>{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-describedby={noteId}
            onClick={() => takeFromTheirs(flagged)}
            data-testid={`admin-legal-use-theirs-${field}`}
          >
            {t.conflict.useTheirs}
          </Button>
        </>
      )
    }
    return takenNow(field) ? t.conflict.takenFromTheirs(reviewing.version) : null
  }
  const flagClass = (field: LegalEntityField) =>
    flaggedFor(field) !== undefined ? 'border-l-[3px] border-org pl-3' : undefined

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
    <Field
      id={idOf(field)}
      label={label}
      required={options.required}
      hint={reviewNote(field)}
      error={errorList(errorsOf(field))}
      className={flagClass(field)}
    >
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
      {conflict !== null && (
        <ConflictBanner
          read={conflict}
          onReapply={reapply}
          onDiscard={discard}
          onRetry={() => readNewer(conflictTarget.current)}
          reapplyRef={reapplyRef}
        />
      )}
      {reviewing !== null && flaggedNow.length > 0 && (
        <Banner tone="success" data-testid="admin-legal-applied">
          {t.conflict.applied(
            reviewing.version,
            valueNameList(flaggedNow.map((item) => item.field)),
            entity.version + 1,
          )}
        </Banner>
      )}

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
        <Field
          id={idOf('iban')}
          label={t.value.iban}
          hint={
            reviewNote('iban') === null ? (
              t.form.ibanHint
            ) : (
              <>
                {t.form.ibanHint}
                <br />
                {reviewNote('iban')}
              </>
            )
          }
          error={errorList(errorsOf('iban'))}
          className={flagClass('iban')}
        >
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
          {(['it', 'en'] as const).map((language) => {
            const field = language === 'it' ? 'address.it' : 'address.en'
            const note = reviewNote(field)
            return (
              <div key={language} className={flagClass(field)}>
                <AddressLinesField
                  language={language}
                  legend={language === 'it' ? t.value.addressIt : t.value.addressEn}
                  lines={shown.address[language]}
                  errors={lineErrors(language)}
                  idFor={(index) => idOf(lineKey(language, index))}
                  onChange={(lines, index) => edit(field, lines, lineKey(language, index))}
                  testIdPrefix="admin-legal-address"
                />
                {note !== null && (
                  <p className="field-hint mt-2" data-testid={`admin-legal-review-${field}`}>
                    {note}
                  </p>
                )}
              </div>
            )
          })}
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
        conflict={conflict !== null}
        notice={notice}
        saveRef={saveRef}
      />
    </form>
  )
}
