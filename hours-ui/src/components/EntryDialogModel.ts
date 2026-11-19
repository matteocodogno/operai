/**
 * EntryDialogModel — what the entry dialog holds and decides, apart from how it looks (specs/20261112-time-tracking
 * T27; design S2). The values the person types and picks, the durations on offer, the client rules, the body
 * a save sends and where each refusal of hours-api lands. A component file may export only components
 * (`react-refresh`), so this is its sibling.
 */
import { formatDate, formatDuration } from '@operai/ui'
import { readDuration } from '../lib/duration'
import { codeOf, statusOf } from '../lib/errors'
import type {
  CategoryView,
  EntryInput,
  EntryOnInput,
  EntryPatch,
  TimeEntryView,
  WorkTypeView,
} from '../lib/hoursApi.types'
import { rowName } from '../lib/names'
import type { DealChoice, MeetingChoice, ProjectChoice } from '../lib/searchers'
import { strings } from '../strings'

/** The note's limit, in Unicode code points (AC-1.7; plan § Entries "Counting a note and a name"). */
export const NOTE_LIMIT = 1000

/** What the hours were on (AC-2.1): a project, a deal or a meeting, or no entity at all. */
export type EntryKind = 'project' | 'deal' | 'meeting' | 'none'

export const ENTRY_KINDS: readonly EntryKind[] = ['project', 'deal', 'meeting', 'none']

/** The kinds that are an entity the person picks from a search. */
export type PickedKind = Exclude<EntryKind, 'none'>

export type EntryFormValues = {
  day: string
  /**
   * The duration as the person typed it, `''` until typed (D53). An edit opens with the app's own short display
   * of the entry's (`2 h 30`), which reads back. What it means is `readDuration`'s, never a number parsed here.
   */
  minutes: string
  /** `null` until chosen: nothing is preselected (D18). */
  kind: EntryKind | null
  project: ProjectChoice | null
  deal: DealChoice | null
  meeting: MeetingChoice | null
  categoryId: string
  workTypeId: string
  activityId: string | null
  note: string
}

export const emptyValues = (today: string): EntryFormValues => ({
  day: today,
  minutes: '',
  kind: null,
  project: null,
  deal: null,
  meeting: null,
  categoryId: '',
  workTypeId: '',
  activityId: null,
  note: '',
})

/**
 * What a recording dialog opens with when it was opened from somewhere that already knows the day, the target or the
 * task (specs/20261116-record-hours-in-place, plan § API contracts "`EntryDialog` (recording mode only)"): a project,
 * deal or task row on another tool's page, or a cell of My hours' Week view. Nothing but these members is preset:
 * the duration, the work type and the note always start empty.
 */
export type EntryPreset = {
  /** `YYYY-MM-DD`; absent means today. A day after today is a host bug, which Save refuses with the usual words. */
  day?: string
  on:
    | { kind: 'project'; project: ProjectChoice }
    | { kind: 'deal'; deal: DealChoice }
    | { kind: 'meeting'; meeting: MeetingChoice }
    /** `null`: no category chosen (A3): the person picks one, as in My hours. */
    | { kind: 'none'; categoryId: string | null }
  /** The task the hours point at: a project's or a deal's only (time-tracking AC-2.7); ignored on anything else. */
  activity?: { id: string; subject: string | null }
}

/** The values a dialog with a `preset` opens with: the day, the target and (on a project or a deal) the task. */
export const presetValues = (today: string, preset: EntryPreset): EntryFormValues => {
  const values: EntryFormValues = { ...emptyValues(preset.day ?? today), kind: preset.on.kind }
  const activityId = preset.activity?.id ?? null
  switch (preset.on.kind) {
    case 'project':
      return { ...values, project: preset.on.project, activityId }
    case 'deal':
      return { ...values, deal: preset.on.deal, activityId }
    case 'meeting':
      return { ...values, meeting: preset.on.meeting }
    case 'none':
      return { ...values, categoryId: preset.on.categoryId ?? '' }
  }
}

/** The radio changed: the entity, category, work type and activity no longer apply; day, duration and note stay. */
export const withKind = (values: EntryFormValues, kind: EntryKind): EntryFormValues => ({
  ...values,
  kind,
  project: null,
  deal: null,
  meeting: null,
  categoryId: '',
  workTypeId: '',
  activityId: null,
})

// ─── The client rules ───────────────────────────────────────────────────────

/** The fields that can carry an error, in the order the dialog shows them. */
export const FIELD_NAMES = ['day', 'minutes', 'kind', 'entity', 'category', 'workType', 'activity', 'note'] as const
export type FieldName = (typeof FIELD_NAMES)[number]
export type FieldErrors = Partial<Record<FieldName, string>>

/** Whether a field is in the dialog for what the hours were on (the matrix of design S2). */
export const applies = (field: FieldName, kind: EntryKind | null): boolean => {
  switch (field) {
    case 'entity':
      return kind === 'project' || kind === 'deal' || kind === 'meeting'
    case 'category':
      return kind === 'none'
    case 'workType':
    case 'activity':
      return kind === 'project' || kind === 'deal'
    default:
      return true
  }
}

/** The earliest day an entry can be on (plan § Entries "A day"): the product's floor, not the database's. */
export const EARLIEST_DAY = '2000-01-01'

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A real calendar day: exactly `YYYY-MM-DD` in ASCII digits that comes back unchanged through `Date.UTC`
 * (plan § Entries "A day"). The round trip refuses what a parser would quietly make another day (30 February
 * is 2 March) and the years 0–99, which `Date.UTC` reads as 1900–1999. The same rule as the server's, so the
 * 400 it would answer is reached only through a client bug. (`lib/period.ts` holds the same check, private.)
 */
export const isRealDay = (text: string): boolean => {
  const parts = ISO_DAY.exec(text)
  if (!parts) return false
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return new Date(ms).toISOString().slice(0, 10) === text
}

/**
 * What the rules need beyond the values: today, the categories the dialog offers (never a retired one, except
 * the edited entry's own), and, when editing, the values the entry is stored with.
 */
export type RuleContext = {
  today: string
  categories: readonly CategoryView[]
  stored?: EntryFormValues
}

const categoryOf = (values: EntryFormValues, context: RuleContext) =>
  context.categories.find((category) => category.id === values.categoryId)

/**
 * Whether the note is required for this save (AC-3.6; design S2 "Note — when it is required", D50): the chosen
 * category asks for one AND this save would check it. Recording, it always would. Editing, the server checks
 * the note only when a `PATCH` sends `note` or moves the entry, so a note-less entry that stays on its
 * category — one recorded before the category was marked as requiring a note — is not asked for one; the note
 * is required once the category differs from the stored one (another category, or Other work from a project,
 * deal or meeting) or the entry has a note that could be cleared.
 */
export const noteRequired = (values: EntryFormValues, context: RuleContext): boolean => {
  if (values.kind !== 'none' || !(categoryOf(values, context)?.requiresNote ?? false)) return false
  const { stored } = context
  if (stored === undefined) return true
  const storedCategoryId = stored.kind === 'none' ? stored.categoryId : ''
  return values.categoryId !== storedCategoryId || !isBlankNote(stored.note)
}

/** A note's length in Unicode code points, as the server's limit counts it (plan § Entries). */
export const noteLength = (note: string): number => [...note].length

/** A blank note — empty, or only whitespace — is no note (plan § Entries "A blank note"). */
export const isBlankNote = (note: string): boolean => note.trim() === ''

/** The project, deal or meeting that was picked for the kind chosen, if any. */
export const pickedEntity = (values: EntryFormValues): { id: string } | null =>
  values.kind === 'project'
    ? values.project
    : values.kind === 'deal'
      ? values.deal
      : values.kind === 'meeting'
        ? values.meeting
        : null

/** A number of minutes as the app shows a duration (`2 h 30`, `30 min`): what the field reads back and opens with. */
export const durationText = (minutes: number): string => formatDuration(minutes * 60_000, { style: 'short' })

/** The duration's error — what is wrong with the text, in the person's words — or `undefined` when it reads (AC-1.2). */
const durationError = (text: string): string | undefined => {
  const read = readDuration(text)
  if (read.ok) return undefined
  const t = strings.entry.errors
  return read.problem === 'range' ? t.durationRange : read.problem === 'steps' ? t.durationSteps : t.durationUnreadable
}

/** The minutes the typed text means, or `null` when it does not read. */
const readMinutes = (text: string): number | null => {
  const read = readDuration(text)
  return read.ok ? read.minutes : null
}

/** The error of one field for these values, or `undefined` when the field is fine. */
export const ruleError = (field: FieldName, values: EntryFormValues, context: RuleContext): string | undefined => {
  const t = strings.entry.errors
  switch (field) {
    case 'day':
      // In the server's order: the rule on the string first (400 there), then the future (422 `future_day`).
      if (values.day === '') return t.dayRequired
      if (!isRealDay(values.day)) return t.dayInvalid
      if (values.day < EARLIEST_DAY) return t.dayTooEarly(formatDate(EARLIEST_DAY))
      return values.day > context.today ? t.dayFuture : undefined
    case 'minutes':
      return durationError(values.minutes)
    case 'kind':
      return values.kind === null ? t.onRequired : undefined
    case 'entity':
      if (!applies('entity', values.kind) || pickedEntity(values) !== null) return undefined
      return values.kind === 'project' ? t.projectRequired : values.kind === 'deal' ? t.dealRequired : t.meetingRequired
    case 'category':
      return applies('category', values.kind) && categoryOf(values, context) === undefined
        ? t.categoryRequired
        : undefined
    case 'note':
      if (noteLength(values.note) > NOTE_LIMIT) return t.noteTooLong
      return noteRequired(values, context) && isBlankNote(values.note) ? t.noteRequired : undefined
    default:
      // Work type and activity are optional: what their lists showed never decides a save.
      return undefined
  }
}

/** Every broken rule, by field. */
export const validate = (values: EntryFormValues, context: RuleContext): FieldErrors =>
  Object.fromEntries(
    FIELD_NAMES.flatMap((field) => {
      const message = ruleError(field, values, context)
      return message === undefined ? [] : [[field, message] as const]
    }),
  )

// ─── What is sent ───────────────────────────────────────────────────────────

/**
 * The `POST /time-entries` body for values that passed `validate`: only the members that apply and were
 * chosen. A work type that the lists no longer offer is left out (the person sees it as unchosen); a blank
 * note is not sent; any other note is sent exactly as typed (plan § Entries).
 */
export const toInput = (values: EntryFormValues, workTypes: readonly WorkTypeView[]): EntryInput => {
  const entity = pickedEntity(values)
  const on: EntryOnInput =
    entity === null
      ? { type: 'none', categoryId: values.categoryId }
      : { type: values.kind as PickedKind, id: entity.id }
  const takesDetails = values.kind === 'project' || values.kind === 'deal'
  const workTypeId =
    takesDetails && workTypes.some((workType) => workType.id === values.workTypeId) ? values.workTypeId : null
  const minutes = readMinutes(values.minutes)
  if (minutes === null) throw new Error('toInput: the duration does not read; `validate` comes first')
  return {
    day: values.day,
    minutes,
    on,
    ...(workTypeId !== null ? { workTypeId } : {}),
    ...(takesDetails && values.activityId !== null ? { activityId: values.activityId } : {}),
    ...(isBlankNote(values.note) ? {} : { note: values.note }),
  }
}

// ─── Editing ────────────────────────────────────────────────────────────────

/**
 * The values an edit opens with, from the entry's view (design F2: "the same dialog, every value filled").
 * The project, deal or meeting is held as the choice a picker would have made, but its name is only ever the
 * one the viewer may read: the placeholder for a withheld or unanswered name (AC-4.10), never the server's
 * label for it. The ids are the entry's own: the author's edit dialog is the one place the UI uses them (D44).
 * hours-api sends the author both ids, always, so a `null` one (a server that broke that) is nothing to
 * re-pick: no choice is made up for it, the target is left empty and the person chooses it again.
 */
export const valuesOf = (entry: TimeEntryView): EntryFormValues => {
  const base: EntryFormValues = {
    ...emptyValues(entry.day),
    minutes: durationText(entry.minutes),
    kind: entry.on.type,
    workTypeId: entry.workType?.id ?? '',
    activityId: entry.activity?.id ?? null,
    note: entry.note ?? '',
  }
  const on = entry.on
  if (on.type === 'none') return { ...base, categoryId: on.category.id }
  if (on.id === null) return base
  const name = rowName(on)?.text ?? strings.names.unavailable
  switch (on.type) {
    case 'project':
      return { ...base, project: { id: on.id, name, companyName: null } }
    case 'deal':
      return { ...base, deal: { id: on.id, title: name, companyName: null } }
    case 'meeting':
      return { ...base, meeting: { id: on.id, title: name, startsAt: null } }
  }
}

/**
 * The edited entry's own activity as the Activity field can keep it: the pointer when the view carries its id,
 * else nothing (D44; as `valuesOf`, a `null` id is nothing to re-pick). The id is what the field's option holds.
 */
export const keptActivity = (
  activity: TimeEntryView['activity'],
): (Omit<NonNullable<TimeEntryView['activity']>, 'id'> & { id: string }) | null =>
  activity === null || activity.id === null ? null : { ...activity, id: activity.id }

const takesDetails = (kind: EntryKind | null): boolean => kind === 'project' || kind === 'deal'

/**
 * The categories the dialog offers: the live ones, and the edited entry's OWN category even when it is retired or
 * the lists do not hold it (AC-3.4: an entry keeps a retired category and shows it, but it is never offered for
 * another). Kept in the lists' order; one the lists do not hold (not loaded, or gone) is appended from the entry's
 * view, whose `requiresNote` is not known and so reads as false: the server decides.
 */
export const offeredCategories = (
  all: readonly CategoryView[],
  own: { id: string; name: string; retired: boolean } | null,
): CategoryView[] => {
  const kept = all.filter((category) => !category.retired || category.id === own?.id)
  if (own === null || kept.some((category) => category.id === own.id)) return kept
  return [...kept, { id: own.id, name: own.name, requiresNote: false, retired: own.retired }]
}

/** The same for the work types of ONE list: the live ones, and the entry's own, which belongs to that list. */
export const offeredWorkTypes = (all: readonly WorkTypeView[], own: WorkTypeView | null): WorkTypeView[] => {
  const kept = all.filter((workType) => !workType.retired || workType.id === own?.id)
  return own === null || kept.some((workType) => workType.id === own.id) ? kept : [...kept, own]
}

/** The edited entry's own work type, as a member of the list it was chosen from (the entry's kind). */
export const ownWorkTypeOf = (entry: TimeEntryView): WorkTypeView | null =>
  entry.workType === null || (entry.on.type !== 'project' && entry.on.type !== 'deal')
    ? null
    : { id: entry.workType.id, list: entry.on.type, name: entry.workType.name, retired: entry.workType.retired }

/**
 * Whether the values are on the target the entry is stored on: the same kind and the same project, deal or
 * meeting — or, for other work, the same category. An `on` equal to the stored target counts as unchanged
 * (plan § Entries, D46), so picking the original again is no move.
 */
export const sameTarget = (values: EntryFormValues, stored: EntryFormValues): boolean => {
  if (values.kind === null || values.kind !== stored.kind) return false
  if (values.kind === 'none') return values.categoryId === stored.categoryId
  const picked = pickedEntity(values)
  const storedPicked = pickedEntity(stored)
  // A stored target that holds nothing (its id was not carried) is never the one picked.
  return picked !== null && storedPicked !== null && picked.id === storedPicked.id
}

/** The `on` of a request for values that passed `validate`. */
const onOf = (values: EntryFormValues): EntryOnInput => {
  const entity = pickedEntity(values)
  return entity === null
    ? { type: 'none', categoryId: values.categoryId }
    : { type: values.kind as PickedKind, id: entity.id }
}

/**
 * What changing the note means (plan § Entries "A blank note", D50): a blank note and no note are the same
 * state, so spaces typed into an empty note, or a note typed and erased again, change nothing and send
 * nothing. A note emptied is cleared with `null`; any other change is sent exactly as typed.
 */
const noteChange = (note: string, stored: string): string | null | undefined => {
  const blank = isBlankNote(note)
  if (blank) return isBlankNote(stored) ? undefined : null
  return note === stored ? undefined : note
}

/**
 * The `PATCH /time-entries/{id}` body: only the members that differ from what the entry holds (AC-2.12).
 * The server checks bookability only when `on` moves the entry, so `on` is sent only when another target was
 * picked; a work type or an activity that belonged to the old target and no longer applies is cleared with
 * `null`; an untouched member is not sent. `workTypes` are the ones the dialog offers: a work type it does
 * not offer reads as unchosen. `{}` means nothing changed.
 */
export const toPatch = (
  values: EntryFormValues,
  stored: EntryFormValues,
  workTypes: readonly WorkTypeView[],
): EntryPatch => {
  const patch: EntryPatch = {}
  if (values.day !== stored.day) patch.day = values.day
  // The duration is typed text: what changed is what it means, not how it is written (`2,5` for the stored `2 h 30`).
  const minutes = readMinutes(values.minutes)
  if (minutes !== null && minutes !== readMinutes(stored.minutes)) patch.minutes = minutes
  if (!sameTarget(values, stored)) patch.on = onOf(values)

  const workTypeId =
    takesDetails(values.kind) && workTypes.some((workType) => workType.id === values.workTypeId)
      ? values.workTypeId
      : null
  const storedWorkTypeId = takesDetails(stored.kind) && stored.workTypeId !== '' ? stored.workTypeId : null
  if (workTypeId !== storedWorkTypeId) patch.workTypeId = workTypeId

  const activityId = takesDetails(values.kind) ? values.activityId : null
  const storedActivityId = takesDetails(stored.kind) ? stored.activityId : null
  if (activityId !== storedActivityId) patch.activityId = activityId

  const note = noteChange(values.note, stored.note)
  if (note !== undefined) patch.note = note
  return patch
}

// ─── What hours-api refuses ─────────────────────────────────────────────────

/**
 * Whether a failed EDIT says the entry itself is gone (design F2 step 3). hours-api answers two different 404s
 * on a `PATCH`: the entry is not the caller's or no longer exists (deleted in another tab) — a 404 with NO
 * `code` — and the new target of a move is missing or unreadable — a 404 with `code: "not_found"`, which only
 * a save that MOVED the entry can get (a save that kept the target never asks about it). So a 404 is the
 * target's only when the entry moved and the answer carries that code; every other 404 is about the entry,
 * and the dialog and the page (which must read the list again when the dialog closes) share this one reading.
 */
export const entryIsGone = (error: unknown, moved: boolean): boolean =>
  statusOf(error) === 404 && !(moved && codeOf(error) === 'not_found')

/** Where a refusal lands: on fields (in their own words), or as the dialog's one alert; and whether the lists are stale. */
export type Failure = { fields: FieldErrors; form: string | null; reloadLists: boolean }

/**
 * Maps what a save came back with to where the dialog says it (design S2 "Error surfaces"). A code whose
 * field is not in the dialog for this choice (it cannot happen, but a server one step ahead could) is the
 * generic alert, never an error nobody can see. A 404 reads the same whether the record is missing or the
 * person may not read it (AC-2.10), and nothing is ever called "saved". When editing (`edit`), a 404 that is
 * about the entry itself (`entryIsGone`) is the dialog's alert, not a picker's.
 *
 * `fixed`: the dialog was opened from a page with its target fixed. `taskFixed` (implies `fixed`): it also holds the
 * task the page chose, shown as a fact, so the Activity has no field to carry an error either (QE D1). A refusal
 * about something the dialog shows as text is the dialog's one alert, in the same words (AC-4.2, D13).
 */
export const failureOf = (
  error: unknown,
  kind: EntryKind | null,
  edit?: { moved: boolean },
  fixed = false,
  taskFixed = false,
): Failure => {
  const t = strings.entry.errors
  const generic: Failure = { fields: {}, form: t.generic, reloadLists: false }
  const on = (field: FieldName, message: string, reloadLists = false): Failure =>
    applies(field, kind) ? { fields: { [field]: message }, form: null, reloadLists } : generic
  // A fixed dialog (specs/20261116-record-hours-in-place AC-4.2, D13) has no picker to carry what My hours puts on
  // it: the same sentence is the dialog's one alert, every value kept.
  const onTarget = (message: string): Failure =>
    fixed ? { fields: {}, form: message, reloadLists: false } : on('entity', message)
  if (edit !== undefined && entryIsGone(error, edit.moved)) return { fields: {}, form: t.entryGone, reloadLists: false }
  switch (codeOf(error)) {
    case 'invalid_minutes':
      return on('minutes', t.durationUnreadable)
    case 'future_day':
      return on('day', t.dayFuture)
    case 'note_too_long':
      return on('note', t.noteTooLong)
    case 'note_required':
      return on('note', t.noteRequired)
    case 'category_not_found':
    case 'category_retired':
      return on('category', t.noLongerAvailable, true)
    case 'work_type_not_found':
    case 'work_type_retired':
    case 'work_type_not_allowed':
      return on('workType', t.noLongerAvailable, true)
    case 'activity_not_allowed':
      if (kind !== 'project' && kind !== 'deal') return generic
      return taskFixed
        ? { fields: {}, form: t.activityNotAllowed[kind], reloadLists: false }
        : on('activity', t.activityNotAllowed[kind])
    case 'not_on_project':
      return kind === 'project' ? onTarget(t.notOnProject) : generic
    case 'not_involved_in_deal':
      return kind === 'deal' ? onTarget(t.notInvolvedInDeal) : generic
    case 'not_found':
      // "Choose another" cannot be done in a fixed dialog: its sentence stops before the invitation (D13).
      return kind === 'project' || kind === 'deal' || kind === 'meeting'
        ? onTarget(fixed ? t.targetGoneFixed[kind] : t.targetGone[kind])
        : generic
    case 'host_unavailable':
      return kind === 'project' || kind === 'deal' || kind === 'meeting'
        ? { fields: {}, form: t.hostUnavailable[kind], reloadLists: false }
        : generic
    default:
      return generic
  }
}
