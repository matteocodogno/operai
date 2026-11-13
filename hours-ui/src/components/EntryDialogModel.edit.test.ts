/**
 * What an edit opens with and what it sends (specs/029-time-tracking T28; plan § Entries "Change an entry",
 * "A blank note", amendment 4 / D50; design F2, S2 "Note — when it is required"; AC-1.5, AC-2.12, AC-3.4,
 * AC-3.6). The dialog's own tests prove what the person sees; this pins the decisions on values a browser
 * control would never hand over.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import {
  EDIT_DEAL,
  EDIT_DEAL_WITH_ACTIVITY,
  EDIT_HIDDEN_PROJECT,
  EDIT_MEETING,
  EDIT_OTHER_NO_NOTE,
  EDIT_OTHER_WITH_NOTE,
  EDIT_PROJECT,
  EDIT_RETIRED_CATEGORY,
  EDIT_RETIRED_WORK_TYPE,
  EDIT_TRAINING,
  ENTRY_LISTS,
} from '../test-support/fixtures/entry'
import type { CategoryView, WorkTypeView } from '../lib/hoursApi.types'
import { HoursApiError } from '../lib/errors'
import {
  entryIsGone,
  failureOf,
  noteRequired,
  offeredCategories,
  offeredWorkTypes,
  ownWorkTypeOf,
  ruleError,
  toPatch,
  valuesOf,
} from './EntryDialogModel'
import type { EntryFormValues, RuleContext } from './EntryDialogModel'

const TODAY = '2026-11-13'
const PROJECT_TYPES: WorkTypeView[] = ENTRY_LISTS.workTypes.project
const DEAL_TYPES: WorkTypeView[] = ENTRY_LISTS.workTypes.deal

/** The values of an entry, then a change of the person's. */
const edited = (values: EntryFormValues, change: Partial<EntryFormValues>): EntryFormValues => ({
  ...values,
  ...change,
})

describe('valuesOf: what an edit opens with', () => {
  it('a project entry holds its day, duration, project, work type, activity and note', () => {
    expect(valuesOf(EDIT_PROJECT)).toEqual({
      day: '2026-11-12',
      minutes: '150',
      kind: 'project',
      project: { id: 'p1', name: 'Project Alpha', companyName: null },
      deal: null,
      meeting: null,
      categoryId: '',
      workTypeId: 'wt-p-dev',
      activityId: 'a-offer',
      note: 'Prepared the workshop',
    })
  })

  it('a deal, a meeting and other work each fill only their own member', () => {
    expect(valuesOf(EDIT_DEAL)).toMatchObject({
      kind: 'deal',
      deal: { id: 'd1', title: 'Acme renewal', companyName: null },
      project: null,
      workTypeId: 'wt-d-demo',
      activityId: null,
      note: '',
    })
    expect(valuesOf(EDIT_MEETING)).toMatchObject({
      kind: 'meeting',
      meeting: { id: 'm1', title: 'Kick-off with Acme', startsAt: null },
      workTypeId: '',
    })
    expect(valuesOf(EDIT_OTHER_WITH_NOTE)).toMatchObject({ kind: 'none', categoryId: 'tc-other', project: null })
  })

  it('a target the person may not read holds the placeholder, never a name, and keeps its id', () => {
    const values = valuesOf(EDIT_HIDDEN_PROJECT)
    expect(values.project).toEqual({ id: 'p-secret', name: strings.names.hidden, companyName: null })
    expect(values.activityId).toBe('a-secret')
  })
})

describe('toPatch: only the members the person changed (AC-1.5, AC-2.12, D46)', () => {
  const stored = valuesOf(EDIT_PROJECT)

  it('nothing changed sends nothing', () => {
    expect(toPatch(stored, stored, PROJECT_TYPES)).toEqual({})
  })

  it('a new day alone is `{ day }`, and a new duration alone is `{ minutes }`', () => {
    expect(toPatch(edited(stored, { day: '2026-11-10' }), stored, PROJECT_TYPES)).toEqual({ day: '2026-11-10' })
    expect(toPatch(edited(stored, { minutes: '60' }), stored, PROJECT_TYPES)).toEqual({ minutes: 60 })
  })

  it('a new work type alone is `{ workTypeId }`, and "No work type" clears it with `null`', () => {
    expect(toPatch(edited(stored, { workTypeId: 'wt-p-analysis' }), stored, PROJECT_TYPES)).toEqual({
      workTypeId: 'wt-p-analysis',
    })
    expect(toPatch(edited(stored, { workTypeId: '' }), stored, PROJECT_TYPES)).toEqual({ workTypeId: null })
  })

  it('a new activity alone is `{ activityId }`, and "No activity" clears it with `null`', () => {
    expect(toPatch(edited(stored, { activityId: 'a-other' }), stored, PROJECT_TYPES)).toEqual({
      activityId: 'a-other',
    })
    expect(toPatch(edited(stored, { activityId: null }), stored, PROJECT_TYPES)).toEqual({ activityId: null })
  })

  it('the same project picked again is no move: `on` is sent only when another target was picked', () => {
    const again = edited(stored, { project: { id: 'p1', name: 'Project Alpha', companyName: 'Acme' } })
    expect(toPatch(again, stored, PROJECT_TYPES)).toEqual({})
    const other = edited(stored, { project: { id: 'p2', name: 'Project Beta', companyName: null }, activityId: null })
    expect(toPatch(other, stored, PROJECT_TYPES)).toEqual({ on: { type: 'project', id: 'p2' }, activityId: null })
  })

  it('moving to a project keeps the work type and, with no activity before, sends no activity', () => {
    const noActivity = valuesOf({ ...EDIT_PROJECT, activity: null })
    const moved = edited(noActivity, { project: { id: 'p2', name: 'Project Beta', companyName: null } })
    expect(toPatch(moved, noActivity, PROJECT_TYPES)).toEqual({ on: { type: 'project', id: 'p2' } })
  })

  it('moving to another KIND sends the new target and clears what belonged to the old one', () => {
    const toMeeting = edited(stored, {
      kind: 'meeting',
      project: null,
      meeting: { id: 'm1', title: 'Kick-off', startsAt: null },
      workTypeId: '',
      activityId: null,
    })
    expect(toPatch(toMeeting, stored, [])).toEqual({
      on: { type: 'meeting', id: 'm1' },
      workTypeId: null,
      activityId: null,
    })
    const toOtherWork = edited(stored, {
      kind: 'none',
      project: null,
      categoryId: 'tc-formazione',
      workTypeId: '',
      activityId: null,
    })
    expect(toPatch(toOtherWork, stored, [])).toEqual({
      on: { type: 'none', categoryId: 'tc-formazione' },
      workTypeId: null,
      activityId: null,
    })
  })

  it('moving from a project to a deal drops the project work type, whose list the deal does not have', () => {
    const toDeal = edited(stored, {
      kind: 'deal',
      project: null,
      deal: { id: 'd1', title: 'Acme renewal', companyName: null },
      workTypeId: 'wt-d-demo',
      activityId: null,
    })
    expect(toPatch(toDeal, stored, DEAL_TYPES)).toEqual({
      on: { type: 'deal', id: 'd1' },
      workTypeId: 'wt-d-demo',
      activityId: null,
    })
  })

  it('a work type that the lists no longer offer reads as unchosen and is cleared, not sent', () => {
    expect(toPatch(edited(stored, { workTypeId: 'wt-gone' }), stored, PROJECT_TYPES)).toEqual({ workTypeId: null })
  })

  it('a note-only edit of an entry on a RETIRED work type is exactly `{ note }`: the work type it never touched stays (plan "A change and a move")', () => {
    const stored = valuesOf(EDIT_RETIRED_WORK_TYPE)
    expect(stored.workTypeId).toBe('wt-p-legacy')
    // The work types the dialog offers for the project list: the live ones and the entry's own retired one.
    const offered = offeredWorkTypes(PROJECT_TYPES, ownWorkTypeOf(EDIT_RETIRED_WORK_TYPE))
    expect(toPatch(edited(stored, { note: 'Handed over' }), stored, offered)).toEqual({ note: 'Handed over' })
    expect(toPatch(edited(stored, { minutes: '60' }), stored, offered)).toEqual({ minutes: 60 })
  })

  it('the same holds when the lists have not been read: the entry’s own work type is all there is, and it is not cleared', () => {
    const stored = valuesOf(EDIT_RETIRED_WORK_TYPE)
    const offered = offeredWorkTypes([], ownWorkTypeOf(EDIT_RETIRED_WORK_TYPE))
    expect(toPatch(edited(stored, { note: 'Handed over' }), stored, offered)).toEqual({ note: 'Handed over' })
  })

  it('a work type that is not offered at all would read as unchosen and be cleared — which is why the entry’s own is always offered', () => {
    const stored = valuesOf(EDIT_RETIRED_WORK_TYPE)
    // The mistake this guards against: comparing against a list that dropped the retired work type.
    expect(toPatch(edited(stored, { note: 'Handed over' }), stored, [])).toEqual({
      note: 'Handed over',
      workTypeId: null,
    })
  })

  it('a deal-to-deal move carries the work type (not sent) and clears the activity with `null`', () => {
    const stored = valuesOf(EDIT_DEAL_WITH_ACTIVITY)
    const moved = edited(stored, { deal: { id: 'd2', title: 'Globex pilot', companyName: null }, activityId: null })
    expect(toPatch(moved, stored, DEAL_TYPES)).toEqual({ on: { type: 'deal', id: 'd2' }, activityId: null })
  })

  it('an entry on a retired category: a note alone is `{ note }` and the category is not sent (AC-3.4)', () => {
    const retired = valuesOf(EDIT_RETIRED_CATEGORY)
    expect(retired.categoryId).toBe('tc-seminars')
    expect(toPatch(edited(retired, { note: 'Conference day' }), retired, [])).toEqual({ note: 'Conference day' })
  })

  it('another category is `on`, and the original one chosen again is no move', () => {
    const retired = valuesOf(EDIT_RETIRED_CATEGORY)
    expect(toPatch(edited(retired, { categoryId: 'tc-formazione' }), retired, [])).toEqual({
      on: { type: 'none', categoryId: 'tc-formazione' },
    })
    expect(toPatch(edited(retired, { categoryId: 'tc-seminars' }), retired, [])).toEqual({})
  })

  it('the entry on a target nobody may read: the placeholder is no move, and a new day saves', () => {
    const hidden = valuesOf(EDIT_HIDDEN_PROJECT)
    expect(toPatch(edited(hidden, { day: '2026-11-09' }), hidden, PROJECT_TYPES)).toEqual({ day: '2026-11-09' })
  })
})

describe('toPatch: the note (plan § Entries "A blank note"; D50)', () => {
  const withNote = valuesOf(EDIT_PROJECT)
  const noNote = valuesOf({ ...EDIT_PROJECT, note: null })

  it('a note typed and erased again is the stored value again: no `note` is sent', () => {
    expect(toPatch(edited(noNote, { note: '' }), noNote, PROJECT_TYPES)).toEqual({})
  })

  it('spaces typed into an empty note change nothing', () => {
    expect(toPatch(edited(noNote, { note: ' \t\n ' }), noNote, PROJECT_TYPES)).toEqual({})
  })

  it('a new note is sent exactly as typed, not trimmed', () => {
    expect(toPatch(edited(noNote, { note: '  two  lines\nof text ' }), noNote, PROJECT_TYPES)).toEqual({
      note: '  two  lines\nof text ',
    })
    expect(toPatch(edited(withNote, { note: 'Prepared the workshop ' }), withNote, PROJECT_TYPES)).toEqual({
      note: 'Prepared the workshop ',
    })
  })

  it('clearing a note, or leaving only spaces, sends `null` (a blank note is no note)', () => {
    expect(toPatch(edited(withNote, { note: '' }), withNote, PROJECT_TYPES)).toEqual({ note: null })
    expect(toPatch(edited(withNote, { note: '   ' }), withNote, PROJECT_TYPES)).toEqual({ note: null })
  })

  it('the untouched note is not sent whatever else changed', () => {
    expect(toPatch(edited(withNote, { minutes: '60' }), withNote, PROJECT_TYPES)).toEqual({ minutes: 60 })
  })
})

describe('what an edit offers: retired items never for a new choice, except the entry’s own (AC-3.4)', () => {
  it('categories: a retired one is dropped, unless it is the entry’s own, which keeps its place in the list', () => {
    const names = (own: Parameters<typeof offeredCategories>[1]) =>
      offeredCategories(ENTRY_LISTS.categories, own).map((category) => category.name)
    expect(names(null)).toEqual(['Formazione', 'Administration', 'Other'])
    expect(names({ id: 'tc-seminars', name: 'Seminars', retired: true })).toEqual([
      'Formazione',
      'Administration',
      'Seminars',
      'Other',
    ])
  })

  it('categories: one the lists do not hold (not read yet) is appended from the entry’s view', () => {
    expect(offeredCategories([], { id: 'tc-seminars', name: 'Seminars', retired: true })).toEqual([
      { id: 'tc-seminars', name: 'Seminars', requiresNote: false, retired: true },
    ])
  })

  it('categories: the lists’ own `requiresNote` is kept for the entry’s category', () => {
    const own = { id: 'tc-other', name: 'Other', retired: false }
    expect(offeredCategories(ENTRY_LISTS.categories, own).find((category) => category.id === 'tc-other')).toMatchObject(
      {
        requiresNote: true,
      },
    )
  })

  it('work types: a retired one is dropped unless it is the entry’s own', () => {
    const own = ownWorkTypeOf(EDIT_RETIRED_WORK_TYPE)
    expect(own).toEqual({ id: 'wt-p-legacy', list: 'project', name: 'Legacy support', retired: true })
    expect(offeredWorkTypes(PROJECT_TYPES, null).map((workType) => workType.name)).toEqual(['Development', 'Analysis'])
    expect(offeredWorkTypes(PROJECT_TYPES, own).map((workType) => workType.name)).toEqual([
      'Development',
      'Analysis',
      'Legacy support',
    ])
  })

  it('work types: the entry’s own is appended when the list does not hold it, and none is invented without one', () => {
    expect(offeredWorkTypes([], ownWorkTypeOf(EDIT_RETIRED_WORK_TYPE))).toHaveLength(1)
    expect(offeredWorkTypes([], null)).toEqual([])
    expect(ownWorkTypeOf(EDIT_PROJECT)?.list).toBe('project')
    expect(ownWorkTypeOf(EDIT_DEAL)?.list).toBe('deal')
    expect(ownWorkTypeOf(EDIT_MEETING)).toBeNull()
    expect(ownWorkTypeOf({ ...EDIT_PROJECT, workType: null })).toBeNull()
  })
})

describe('entryIsGone: the two 404s of a PATCH (design F2 step 3; hours-api T14/T15)', () => {
  // hours-api answers (1) the ENTRY is not the caller's or no longer exists: 404 with NO `code`; (2) the TARGET of
  // a move is missing or unreadable: 404 with `code: "not_found"`.
  const noCode = () => new HoursApiError({ status: 404, title: 'Problem 404' })
  const notFound = () => new HoursApiError({ status: 404, title: 'Problem 404', rawCode: 'not_found' })

  it('a 404 with no code is the entry itself, whether the save kept the target or moved it', () => {
    expect(entryIsGone(noCode(), false)).toBe(true)
    expect(entryIsGone(noCode(), true)).toBe(true)
  })

  it('`not_found` on a save that MOVED the entry is the new target’s, not the entry', () => {
    expect(entryIsGone(notFound(), true)).toBe(false)
  })

  it('`not_found` on a save that kept the target can only be about the entry (the target was not asked about)', () => {
    expect(entryIsGone(notFound(), false)).toBe(true)
  })

  it('a 404 with a code this build does not know is not mistaken for a target’s: it is the entry', () => {
    expect(entryIsGone(new HoursApiError({ status: 404, title: 'x', rawCode: 'something_new' }), true)).toBe(true)
  })

  it('nothing else is: another status, a network failure, or not an error at all', () => {
    expect(entryIsGone(new HoursApiError({ status: 403, title: 'x', rawCode: 'not_on_project' }), true)).toBe(false)
    expect(entryIsGone(new HoursApiError({ status: 503, title: 'x', rawCode: 'host_unavailable' }), false)).toBe(false)
    expect(entryIsGone(new HoursApiError({ status: 400, title: 'x' }), false)).toBe(false)
    expect(entryIsGone(new TypeError('Failed to fetch'), false)).toBe(false)
    expect(entryIsGone(undefined, false)).toBe(false)
  })
})

describe('failureOf when editing (design F2 step 3, S2 "Error surfaces"; AC-2.10, AC-2.12)', () => {
  const refused = (status: number, rawCode?: string) =>
    new HoursApiError({ status, title: `Problem ${status}`, rawCode })
  const entryGone = { fields: {}, form: strings.entry.errors.entryGone, reloadLists: false }

  it('a 404 WITHOUT a code is the entry itself gone: the dialog’s alert, for a save that kept the target', () => {
    expect(failureOf(refused(404), 'project', { moved: false })).toEqual(entryGone)
  })

  it('a 404 WITHOUT a code after a MOVE is still the entry itself, never the picker’s', () => {
    expect(failureOf(refused(404), 'project', { moved: true })).toEqual(entryGone)
    expect(failureOf(refused(404), 'meeting', { moved: true })).toEqual(entryGone)
    expect(failureOf(refused(404), 'none', { moved: true })).toEqual(entryGone)
  })

  it('a coded 404 on a save that KEPT the target is the entry too: the alert, not a picker', () => {
    expect(failureOf(refused(404, 'not_found'), 'project', { moved: false })).toEqual(entryGone)
  })

  it('a codeless 404 when RECORDING is not the entry’s: a create has no entry, so it is the generic alert', () => {
    expect(failureOf(refused(404), 'project').form).toBe(strings.entry.errors.generic)
  })

  it('the entry-gone words offer Delete and say the list reloads on close, and never tell missing from unreadable', () => {
    expect(strings.entry.errors.entryGone).toMatch(/entry, or what it is on, can no longer be found/)
    expect(strings.entry.errors.entryGone).toMatch(/delete it/)
    expect(strings.entry.errors.entryGone).toMatch(/list will reload/)
  })

  it('a 404 on a save that MOVED the entry is the new target’s: on the picker, as when recording', () => {
    expect(failureOf(refused(404, 'not_found'), 'deal', { moved: true })).toEqual({
      fields: { entity: strings.entry.errors.targetGone.deal },
      form: null,
      reloadLists: false,
    })
  })

  it('recording keeps its answer: a 404 is the picker’s', () => {
    expect(failureOf(refused(404, 'not_found'), 'meeting').fields).toEqual({
      entity: strings.entry.errors.targetGone.meeting,
    })
  })

  it('not_on_project after picking another project is the picker’s, in the same words as when recording', () => {
    expect(failureOf(refused(403, 'not_on_project'), 'project', { moved: true }).fields).toEqual({
      entity: strings.entry.errors.notOnProject,
    })
  })
})

describe('noteRequired when editing (design S2 "Note — when it is required"; D50, AC-3.6)', () => {
  const categories: CategoryView[] = ENTRY_LISTS.categories.filter((category) => !category.retired)
  const contextFor = (stored: EntryFormValues): RuleContext => ({ today: TODAY, categories, stored })

  it('recording: required whenever the chosen category requires a note', () => {
    const values: EntryFormValues = { ...valuesOf(EDIT_OTHER_NO_NOTE) }
    expect(noteRequired(values, { today: TODAY, categories })).toBe(true)
  })

  it('a note-less entry that stays on a category since marked as requiring a note: optional', () => {
    const stored = valuesOf(EDIT_OTHER_NO_NOTE)
    expect(noteRequired(stored, contextFor(stored))).toBe(false)
    expect(noteRequired(edited(stored, { minutes: '60' }), contextFor(stored))).toBe(false)
    expect(ruleError('note', edited(stored, { minutes: '60' }), contextFor(stored))).toBeUndefined()
  })

  it('an entry that has a note on such a category: required, so clearing it is the required-note error', () => {
    const stored = valuesOf(EDIT_OTHER_WITH_NOTE)
    expect(noteRequired(stored, contextFor(stored))).toBe(true)
    expect(ruleError('note', stored, contextFor(stored))).toBeUndefined()
    expect(ruleError('note', edited(stored, { note: '' }), contextFor(stored))).toBe(strings.entry.errors.noteRequired)
    expect(ruleError('note', edited(stored, { note: '  ' }), contextFor(stored))).toBe(
      strings.entry.errors.noteRequired,
    )
  })

  it('moving a note-less entry to a category that requires one is the required-note error', () => {
    const stored = valuesOf(EDIT_TRAINING)
    const moved = edited(stored, { categoryId: 'tc-other' })
    expect(noteRequired(moved, contextFor(stored))).toBe(true)
    expect(ruleError('note', moved, contextFor(stored))).toBe(strings.entry.errors.noteRequired)
  })

  it('moving a note-less project entry to Other work is a move to that category too', () => {
    const stored = valuesOf({ ...EDIT_PROJECT, note: null })
    const moved = edited(stored, { kind: 'none', project: null, categoryId: 'tc-other', workTypeId: '' })
    expect(noteRequired(moved, contextFor(stored))).toBe(true)
  })

  it('moving an entry that HAS a note saves: the note it has satisfies the category', () => {
    const stored = valuesOf({ ...EDIT_TRAINING, note: 'Kept' })
    const moved = edited(stored, { categoryId: 'tc-other' })
    expect(noteRequired(moved, contextFor(stored))).toBe(true)
    expect(ruleError('note', moved, contextFor(stored))).toBeUndefined()
  })

  it('choosing another category and then the original back is no move', () => {
    const stored = valuesOf(EDIT_OTHER_NO_NOTE)
    const away = edited(stored, { categoryId: 'tc-formazione' })
    expect(noteRequired(away, contextFor(stored))).toBe(false)
    const back = edited(away, { categoryId: 'tc-other' })
    expect(noteRequired(back, contextFor(stored))).toBe(false)
  })
})
