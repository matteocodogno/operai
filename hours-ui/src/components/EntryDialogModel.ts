/**
 * EntryDialogModel — what the entry dialog holds and decides, apart from how it looks (specs/029-time-tracking
 * T27; design S2). The values the person types and picks, the durations on offer, the client rules, the body
 * a save sends and where each refusal of hours-api lands. A component file may export only components
 * (`react-refresh`), so this is its sibling.
 */
import { formatDate } from '@operai/ui'
import { codeOf } from '../lib/errors'
import type { CategoryView, EntryInput, EntryOnInput, WorkTypeView } from '../lib/hoursApi.types'
import type { DealChoice, MeetingChoice, ProjectChoice } from '../lib/searchers'
import { strings } from '../strings'

/** The note's limit, in Unicode code points (AC-1.7; plan § Entries "Counting a note and a name"). */
export const NOTE_LIMIT = 1000

/** 30 min … 24 h in steps of 30 (AC-1.2): 48 durations, the only values the control can hold. */
export const DURATION_MINUTES: readonly number[] = Array.from({ length: 48 }, (_, index) => (index + 1) * 30)

/** What the hours were on (AC-2.1): a project, a deal or a meeting, or no entity at all. */
export type EntryKind = 'project' | 'deal' | 'meeting' | 'none'

export const ENTRY_KINDS: readonly EntryKind[] = ['project', 'deal', 'meeting', 'none']

/** The kinds that are an entity the person picks from a search. */
export type PickedKind = Exclude<EntryKind, 'none'>

export type EntryFormValues = {
  day: string
  /** The chosen duration in minutes as text, `''` until chosen. */
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

/** What the rules need beyond the values: today, and the categories the dialog offers (never a retired one). */
export type RuleContext = { today: string; categories: readonly CategoryView[] }

const categoryOf = (values: EntryFormValues, context: RuleContext) =>
  context.categories.find((category) => category.id === values.categoryId)

/** Whether the note is required: the chosen category asks for one (AC-3.6). */
export const noteRequired = (values: EntryFormValues, context: RuleContext): boolean =>
  values.kind === 'none' && (categoryOf(values, context)?.requiresNote ?? false)

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
      return DURATION_MINUTES.some((minutes) => String(minutes) === values.minutes) ? undefined : t.durationRequired
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
  return {
    day: values.day,
    minutes: Number(values.minutes),
    on,
    ...(workTypeId !== null ? { workTypeId } : {}),
    ...(takesDetails && values.activityId !== null ? { activityId: values.activityId } : {}),
    ...(isBlankNote(values.note) ? {} : { note: values.note }),
  }
}

// ─── What hours-api refuses ─────────────────────────────────────────────────

/** Where a refusal lands: on fields (in their own words), or as the dialog's one alert; and whether the lists are stale. */
export type Failure = { fields: FieldErrors; form: string | null; reloadLists: boolean }

/**
 * Maps what a save came back with to where the dialog says it (design S2 "Error surfaces"). A code whose
 * field is not in the dialog for this choice (it cannot happen, but a server one step ahead could) is the
 * generic alert, never an error nobody can see. A 404 reads the same whether the record is missing or the
 * person may not read it (AC-2.10), and nothing is ever called "saved".
 */
export const failureOf = (error: unknown, kind: EntryKind | null): Failure => {
  const t = strings.entry.errors
  const generic: Failure = { fields: {}, form: t.generic, reloadLists: false }
  const on = (field: FieldName, message: string, reloadLists = false): Failure =>
    applies(field, kind) ? { fields: { [field]: message }, form: null, reloadLists } : generic
  switch (codeOf(error)) {
    case 'invalid_minutes':
      return on('minutes', t.durationRequired)
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
      return kind === 'project' || kind === 'deal' ? on('activity', t.activityNotAllowed[kind]) : generic
    case 'not_on_project':
      return kind === 'project' ? on('entity', t.notOnProject) : generic
    case 'not_involved_in_deal':
      return kind === 'deal' ? on('entity', t.notInvolvedInDeal) : generic
    case 'not_found':
      return kind === 'project' || kind === 'deal' || kind === 'meeting' ? on('entity', t.targetGone[kind]) : generic
    case 'host_unavailable':
      return kind === 'project' || kind === 'deal' || kind === 'meeting'
        ? { fields: {}, form: t.hostUnavailable[kind], reloadLists: false }
        : generic
    default:
      return generic
  }
}
