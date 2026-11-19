import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  DateInput,
  Field,
  FormDialog,
  RadioGroupField,
  SearchPicker,
  focusFirstInvalid,
  formatDate,
} from '@operai/ui'
import type { ComboboxOption } from '@operai/ui'
import { readDuration } from '../lib/duration'
import type { EntryInput, EntryPatch, TimeEntryView, TimeListsView } from '../lib/hoursApi.types'
import { searchDeals, searchMeetings, searchProjects } from '../lib/searchers'
import type { DealChoice, MeetingChoice, ProjectChoice } from '../lib/searchers'
import { todayZurich } from '../lib/todayZurich'
import { strings } from '../strings'
import ActivityField from './ActivityField'
import {
  EARLIEST_DAY,
  ENTRY_KINDS,
  NOTE_LIMIT,
  durationText,
  emptyValues,
  failureOf,
  keptActivity,
  noteLength,
  noteRequired,
  offeredCategories,
  offeredWorkTypes,
  ownWorkTypeOf,
  presetValues,
  ruleError,
  sameTarget,
  toInput,
  toPatch,
  validate,
  valuesOf,
  withKind,
} from './EntryDialogModel'
import type { EntryFormValues, EntryKind, EntryPreset, FieldErrors, FieldName, RuleContext } from './EntryDialogModel'

export type { EntryPreset } from './EntryDialogModel'

/** The categories and work types, as the page read them (`includeRetired=true`): retired ones are never offered. */
export type EntryDialogLists = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; lists: TimeListsView }

type EntryDialogShared = {
  lists: EntryDialogLists
  /** Asks the page to read the lists again (they failed, or a save found them out of date). */
  onReloadLists: () => void
  onCancel: () => void
}

/**
 * Recording (no `entry`): `onSubmit` records the entry. Editing (`entry`, the view of the entry being changed):
 * the dialog opens filled and `onSubmit` takes only the members the person changed (`PATCH`, never empty: with
 * nothing changed Save just closes). Either resolves when saved (the page then closes the dialog) and rejects
 * with what hours-api answered.
 *
 * Recording only (specs/20261116-record-hours-in-place; plan § API contracts "`EntryDialog` (recording mode only)"):
 * `preset` opens it on a day, a target and, on a project or a deal, a task; with `fixed` the kind, the target and
 * the task are shown as text and cannot be changed (a page's Record hours), without it they are only the starting
 * point (a Week cell). `fixed` without `preset` is a type error. `focus` says where the keyboard starts: `day`
 * (the default, My hours' own Record hours) or `duration` (the day and the target are already known).
 */
export type EntryDialogProps = EntryDialogShared &
  (
    | ({
        entry?: undefined
        onSubmit: (input: EntryInput) => Promise<void>
        focus?: 'day' | 'duration'
      } & ({ preset?: undefined; fixed?: undefined } | { preset: EntryPreset; fixed?: boolean }))
    | { entry: TimeEntryView; onSubmit: (patch: EntryPatch) => Promise<void> }
  )

const projectOption = (project: ProjectChoice): ComboboxOption => ({
  id: project.id,
  label: project.name,
  secondaryLabel: project.companyName ?? undefined,
})
const dealOption = (deal: DealChoice): ComboboxOption => ({
  id: deal.id,
  label: deal.title,
  secondaryLabel: deal.companyName ?? undefined,
})
const meetingOption = (meeting: MeetingChoice): ComboboxOption => ({
  id: meeting.id,
  label: meeting.title,
  secondaryLabel: meeting.startsAt === null ? undefined : formatDate(meeting.startsAt),
})

/** The fields whose error is judged again as the person edits them; an edit clears the error of every other. */
const LIVE_FIELDS: readonly FieldName[] = ['day', 'minutes', 'kind', 'category', 'note']

const without = (errors: FieldErrors, field: FieldName): FieldErrors => {
  const { [field]: _removed, ...rest } = errors
  void _removed
  return rest
}

/** A select that cannot be used yet looks inert but stays reachable, so a person who tabs to it learns why. */
const INERT = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'

/**
 * The sentence under the title of a dialog whose target is fixed (design S4): what the hours are being recorded on,
 * the name set apart. A name the host could not give reads "this project" / "this deal"; other work is the task
 * about no deal (A3). It is the dialog's accessible description, so it is read as the dialog opens. The name is the
 * record's owner's, up to 200 characters with no break in it: it wraps inside the dialog (QE pass 4 D1).
 */
const fixedDescription = (on: EntryPreset['on']): ReactNode => {
  const t = strings.entry.fixed
  const named = (name: string, sentence: { lead: string; trail: string }, unnamed: string): ReactNode =>
    name.trim() === '' ? (
      unnamed
    ) : (
      <>
        {sentence.lead}
        <span className="font-medium break-words text-text">{name}</span>
        {sentence.trail}
      </>
    )
  switch (on.kind) {
    case 'project':
      return named(on.project.name, t.onProject, t.onThisProject)
    case 'deal':
      return named(on.deal.title, t.onDeal, t.onThisDeal)
    case 'meeting':
      return named(on.meeting.title, t.onMeeting, t.onThisMeeting)
    case 'none':
      return t.onOtherWork
  }
}

/**
 * EntryDialog — record hours (specs/20261112-time-tracking T27; design S2, F1; AC-1.1–1.3, 1.7, 1.8, 2.1–2.3, 2.5,
 * 2.7, 2.10, 2.11, 3.4–3.6). A `FormDialog` over My hours: Day (today, never after it), Duration (typed and read
 * by `lib/duration`: 30 minutes to 24 hours in steps of 30, shown back as "= 2 h 30"; T45, D53), What was it on
 * (nothing chosen), then only the fields that apply to the choice — a project, deal or meeting picker, or a
 * category; the work type and activity for a project or a deal — and the note.
 *
 * It is prop-driven: the lists in, one `onSubmit` out, no router and no knowledge of the page, so the project
 * and deal pages (specs/20261112-project-hours, specs/20261112-meeting-hours) can reuse it. The dialog owns the form, the client rules and the words for
 * every refusal; the page owns the request.
 *
 * Editing (T28; design F2, S2 "Edit entry"; AC-1.5, AC-2.12, AC-3.4, AC-4.10; plan § Entries "Change an entry",
 * "A change and a move", "A blank note", D46, D50): with an `entry` the dialog opens filled from its view and
 * `onSubmit` gets only the members the person changed — `on` only when another target was picked, a member that
 * no longer fits the new target (the activity, or a work type of the other list) as an explicit `null`, an
 * untouched note never. With nothing changed Save just closes (`PATCH {}` is a 400). The entry's own retired
 * category or work type stays on offer and is never read as unchosen. An entry whose project, deal or meeting
 * the author can no longer read opens the "not visible" variant: the target is the placeholder "Not visible to
 * you" and the Activity is not editable until another target is picked. The ids it works with are the author's
 * own, and hours-api always sends the author theirs (D44); a view that lacks one is nothing to re-pick
 * (`valuesOf`, `keptActivity`): the target opens empty and Save asks for it, the Activity shows no pointer it
 * cannot name.
 *
 * Validation runs on Save (focus then goes to the first invalid field) and, for Day, Duration and the note, on
 * leaving the field; an error that is showing is judged again as the field is edited, so it goes the moment the
 * value is right. A refusal from hours-api lands where design S2 puts it and every value stays.
 */
export default function EntryDialog(props: EntryDialogProps) {
  const { lists, onReloadLists, onCancel, entry } = props
  const t = strings.entry
  const baseId = useId()
  const [today] = useState(() => todayZurich())
  // Recording from a page or a Week cell: where the dialog starts (`preset`), and whether the target is only shown.
  const preset = props.entry === undefined ? props.preset : undefined
  const fixed = props.entry === undefined && props.preset !== undefined && props.fixed === true
  const focusDuration = props.entry === undefined && props.focus === 'duration'
  // Editing: what the entry is stored with, which the form is judged against and `PATCH` is the difference from.
  const [stored] = useState<EntryFormValues | null>(() => (entry === undefined ? null : valuesOf(entry)))
  // What the form opens with: the entry's values, the preset's, or nothing chosen.
  const [start] = useState<EntryFormValues>(
    () => stored ?? (preset === undefined ? emptyValues(today) : presetValues(today, preset)),
  )
  const [values, setValues] = useState<EntryFormValues>(start)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const body = useRef<HTMLDivElement>(null)

  const loaded = lists.status === 'loaded' ? lists.lists : null
  const listsReady = loaded !== null
  // A retired item is never offered for a new choice (AC-3.4), except the edited entry's own, which it keeps.
  const categories = offeredCategories(loaded?.categories ?? [], entry?.on.type === 'none' ? entry.on.category : null)
  const ownWorkType = entry === undefined ? null : ownWorkTypeOf(entry)
  const workTypes =
    values.kind === 'project' || values.kind === 'deal'
      ? offeredWorkTypes(loaded?.workTypes[values.kind] ?? [], ownWorkType?.list === values.kind ? ownWorkType : null)
      : []
  const context: RuleContext = { today, categories, stored: stored ?? undefined }

  // A category or work type the lists no longer offer (retired since) reads as unchosen, and is not sent.
  const effective = (current: EntryFormValues): EntryFormValues => ({
    ...current,
    categoryId: categories.some((category) => category.id === current.categoryId) ? current.categoryId : '',
    workTypeId: workTypes.some((workType) => workType.id === current.workTypeId) ? current.workTypeId : '',
  })
  const shown = effective(values)
  const needsNote = noteRequired(shown, context)
  const duration = readDuration(values.minutes)
  const count = noteLength(values.note)

  // The "not visible" variant (design S2, AC-4.10, D43): the author can no longer read the project, deal or
  // meeting the entry is on. While the entry stays on it the picker holds the placeholder and the Activity is
  // not editable; the first other pick makes both ordinary again.
  const atStoredTarget = stored !== null && sameTarget(shown, stored)
  // The task a preset points at belongs to the preset's target, like an entry's pointer to its own: it is the
  // field's one known option (shown as a fact when `fixed`) until another target is picked.
  const presetTask =
    preset?.activity !== undefined && sameTarget(shown, start)
      ? { id: preset.activity.id, subject: preset.activity.subject, visibility: 'visible' as const }
      : null
  const taskFixed = fixed && presetTask !== null
  const withheld = entry !== undefined && entry.on.type !== 'none' && entry.on.visibility === 'hidden'
  const placeholderShown = withheld && atStoredTarget
  const targetHint = (kind: 'project' | 'deal' | 'meeting') =>
    placeholderShown ? t.fields[kind].hiddenHint : t.fields[kind].hint

  /** Moves to `next` and judges again the errors of the fields that changed, clearing the ones that cannot be. */
  const edit = (next: EntryFormValues, ...changed: FieldName[]) => {
    setValues(next)
    setErrors((previous) =>
      changed.reduce((errorsNow, field) => {
        if (errorsNow[field] === undefined) return errorsNow
        const again = LIVE_FIELDS.includes(field) ? ruleError(field, effective(next), context) : undefined
        return again === undefined ? without(errorsNow, field) : { ...errorsNow, [field]: again }
      }, previous),
    )
  }
  /** The entity changed (picked, or typed away from): the activity belongs to the old one. */
  const editEntity = (patch: Partial<EntryFormValues>) =>
    edit({ ...values, ...patch, activityId: null }, 'entity', 'activity')
  const onBlur = (field: FieldName) => {
    const message = ruleError(field, shown, context)
    setErrors((previous) => (message === undefined ? without(previous, field) : { ...previous, [field]: message }))
  }

  // A failed Save moves focus to the first invalid field, once the errors have rendered. A picker opens its
  // list when it gets focus, and the list would cover the error written under it: so for the moment focus
  // is given, the pickers are `quiet` (they ignore it, like a disabled field that can still be focused),
  // and they are live again at the next frame. Typing or the arrow keys open the list as always.
  //
  // A refusal with no field to blame (the dialog's one alert: a fixed dialog's `not_on_project`, `host_unavailable`,
  // "Something went wrong") puts focus back on Save instead. Save, and every field with it, is disabled while the
  // save runs, and a browser takes focus off a control that stops being focusable: with nothing to give it to, the
  // keyboard would be left on <body> and the next Tab would land on ×. Save is where the person pressed, and
  // pressing it again is the retry (design S4 "Errors", QE D2).
  const [quiet, setQuiet] = useState(false)
  const askFocus = (onField = true) => {
    if (onField) setQuiet(true)
    setFocusRequest((request) => request + 1)
  }
  useEffect(() => {
    if (focusRequest === 0) return
    if (!focusFirstInvalid(body.current)) {
      // The library's `FormDialog` owns the button and gives no ref to it: it is the form's submit button.
      body.current?.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()
    }
    const frame = requestAnimationFrame(() => setQuiet(false))
    return () => cancelAnimationFrame(frame)
  }, [focusRequest])

  const submit = async () => {
    if (busy) return
    const found = validate(shown, context)
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) {
      askFocus()
      return
    }
    // Editing sends only what changed; with nothing changed there is nothing to save, and `PATCH {}` is a 400.
    const editing =
      props.entry !== undefined && stored !== null
        ? { save: props.onSubmit, patch: toPatch(shown, stored, workTypes) }
        : null
    if (editing !== null && Object.keys(editing.patch).length === 0) {
      onCancel()
      return
    }
    setBusy(true)
    try {
      if (editing !== null) await editing.save(editing.patch)
      else if (props.entry === undefined) await props.onSubmit(toInput(shown, workTypes))
    } catch (error) {
      const failure = failureOf(
        error,
        values.kind,
        editing === null ? undefined : { moved: editing.patch.on !== undefined },
        fixed,
        taskFixed,
      )
      setErrors(failure.fields)
      setFormError(failure.form)
      setBusy(false)
      if (failure.reloadLists) onReloadLists()
      askFocus(Object.keys(failure.fields).length > 0)
    }
  }

  const retry = (
    <Button
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={onReloadLists}
      data-testid="hours-entry-lists-retry"
    >
      {t.listsRetry}
    </Button>
  )
  /** The Activity field of a project or a deal: a select, a fact when the page chose the task, a note when withheld. */
  const activityField = (kind: 'project' | 'deal') => (
    <ActivityField
      targetType={kind}
      targetId={(kind === 'project' ? values.project?.id : values.deal?.id) ?? null}
      value={values.activityId}
      onChange={(activityId) => edit({ ...values, activityId }, 'activity')}
      // The entry's own pointer belongs to the target it was saved on, so only while it is still there.
      current={atStoredTarget && entry !== undefined ? keptActivity(entry.activity) : presetTask}
      lock={taskFixed ? 'fixed' : placeholderShown ? 'hidden' : undefined}
      error={errors.activity ?? null}
      disabled={busy}
    />
  )
  const listHint = (what: 'category' | 'workType') =>
    lists.status === 'loading'
      ? t.fields[what].loading
      : lists.status === 'error'
        ? t.fields[what].loadFailed
        : undefined

  return (
    <FormDialog
      title={entry === undefined ? t.dialog.recordTitle : t.dialog.editTitle}
      description={fixed && preset !== undefined ? fixedDescription(preset.on) : undefined}
      submitLabel={t.dialog.save}
      busyLabel={t.dialog.saving}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      size="lg"
      busy={busy}
      // Other work needs a category: with none to choose from, Save has nothing to send (the field says so).
      canSubmit={!(values.kind === 'none' && listsReady && categories.length === 0)}
      error={formError}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      testIdPrefix="hours-entry-dialog"
    >
      <div ref={body} className="contents">
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label={t.fields.day} required error={errors.day} errorRole="alert">
            {(control) => (
              <DateInput
                {...control}
                value={values.day}
                min={EARLIEST_DAY}
                max={today}
                data-autofocus={focusDuration ? undefined : ''}
                onChange={(event) => edit({ ...values, day: event.target.value }, 'day')}
                onBlur={() => onBlur('day')}
                data-testid="hours-entry-day"
              />
            )}
          </Field>

          <Field
            label={t.fields.duration.label}
            hint={
              <>
                {/* How the text was read, announced as it changes (D53). Always in the DOM, so the change is heard. */}
                <span aria-live="polite" className="block font-mono" data-testid="hours-entry-duration-reads">
                  {duration.ok ? t.fields.duration.reads(durationText(duration.minutes)) : ''}
                </span>
                {t.fields.duration.hint}
              </>
            }
            required
            error={errors.minutes}
            errorRole="alert"
          >
            {(control) => (
              <input
                {...control}
                type="text"
                inputMode="text"
                autoComplete="off"
                className="input-figure"
                data-autofocus={focusDuration ? '' : undefined}
                value={values.minutes}
                onChange={(event) => edit({ ...values, minutes: event.target.value }, 'minutes')}
                onBlur={() => onBlur('minutes')}
                data-testid="hours-entry-duration"
              />
            )}
          </Field>
        </div>

        {!fixed && (
          <RadioGroupField label={t.fields.on.label} required error={errors.kind} testId="hours-entry-on">
            {ENTRY_KINDS.map((kind: EntryKind) => (
              <label key={kind}>
                <input
                  type="radio"
                  name={`${baseId}-on`}
                  value={kind}
                  checked={values.kind === kind}
                  onChange={() =>
                    edit(withKind(values, kind), 'kind', 'entity', 'category', 'workType', 'activity', 'note')
                  }
                  data-testid={`hours-entry-on-${kind}`}
                />
                {t.fields.on.options[kind]}
              </label>
            ))}
          </RadioGroupField>
        )}

        {!fixed && values.kind === 'project' && (
          <SearchPicker<ProjectChoice>
            key="project"
            label={t.fields.project.label}
            hint={targetHint('project')}
            required
            error={errors.entity}
            disabled={busy || quiet}
            value={values.project}
            onChange={(project) => editEntity({ project })}
            search={searchProjects}
            toOption={projectOption}
            messages={t.fields.project.messages}
            testId="hours-entry-project"
          />
        )}
        {!fixed && values.kind === 'deal' && (
          <SearchPicker<DealChoice>
            key="deal"
            label={t.fields.deal.label}
            hint={targetHint('deal')}
            required
            error={errors.entity}
            disabled={busy || quiet}
            value={values.deal}
            onChange={(deal) => editEntity({ deal })}
            search={searchDeals}
            toOption={dealOption}
            messages={t.fields.deal.messages}
            testId="hours-entry-deal"
          />
        )}
        {!fixed && values.kind === 'meeting' && (
          <SearchPicker<MeetingChoice>
            key="meeting"
            label={t.fields.meeting.label}
            hint={targetHint('meeting')}
            required
            error={errors.entity}
            disabled={busy || quiet}
            value={values.meeting}
            onChange={(meeting) => editEntity({ meeting })}
            search={searchMeetings}
            toOption={meetingOption}
            messages={t.fields.meeting.messages}
            testId="hours-entry-meeting"
          />
        )}

        {values.kind === 'none' && (
          <div className="flex flex-col gap-1">
            <Field
              label={t.fields.category.label}
              required
              hint={listHint('category') ?? (categories.length === 0 ? t.fields.category.noneAvailable : undefined)}
              error={errors.category}
              errorRole="alert"
            >
              {(control) => (
                <select
                  {...control}
                  value={shown.categoryId}
                  aria-disabled={categories.length > 0 ? undefined : true}
                  className={INERT}
                  onChange={(event) => {
                    if (categories.length > 0) edit({ ...values, categoryId: event.target.value }, 'category', 'note')
                  }}
                  data-testid="hours-entry-category"
                >
                  <option value="" disabled hidden>
                    {t.fields.category.placeholder}
                  </option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.retired ? strings.entries.retired(category.name) : category.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {lists.status === 'error' && retry}
          </div>
        )}

        {(values.kind === 'project' || values.kind === 'deal') && (
          <>
            {/* The task the page chose reads with the other fixed things, ahead of what is still to fill in. */}
            {taskFixed && activityField(values.kind)}
            <div className="flex flex-col gap-1">
              <Field
                label={t.fields.workType.label}
                hint={listHint('workType')}
                error={errors.workType}
                errorRole="alert"
              >
                {(control) => (
                  <select
                    {...control}
                    value={shown.workTypeId}
                    aria-disabled={listsReady ? undefined : true}
                    className={INERT}
                    onChange={(event) => {
                      if (listsReady) edit({ ...values, workTypeId: event.target.value }, 'workType')
                    }}
                    data-testid="hours-entry-work-type"
                  >
                    <option value="">{t.fields.workType.none}</option>
                    {workTypes.map((workType) => (
                      <option key={workType.id} value={workType.id}>
                        {workType.retired ? strings.entries.retired(workType.name) : workType.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {lists.status === 'error' && retry}
            </div>
            {!taskFixed && activityField(values.kind)}
          </>
        )}

        <Field
          label={t.fields.note.label}
          required={needsNote}
          hint={
            <>
              {needsNote && <span>{t.fields.note.needed} </span>}
              <span data-testid="hours-entry-note-counter">{t.fields.note.counter(count, NOTE_LIMIT)}</span>
            </>
          }
          error={errors.note}
          errorRole="alert"
        >
          {(control) => (
            <textarea
              {...control}
              rows={3}
              value={values.note}
              onChange={(event) => edit({ ...values, note: event.target.value }, 'note')}
              onBlur={() => onBlur('note')}
              data-testid="hours-entry-note"
            />
          )}
        </Field>
      </div>
    </FormDialog>
  )
}
