/**
 * Fixtures of the entry dialog (specs/029-time-tracking T27): the lists it offers, what the three pickers find,
 * the answers a save can come back with, and the long notes the limit is checked with. Typed with the wire
 * types, so a contract change fails the build. Built on `myHours`'s `LISTS` (a retired category, a retired
 * work type, the same name in both work-type lists) with one more category that REQUIRES a note (AC-3.6).
 */
import {
  dealItem,
  dealOn,
  meetingOn,
  meetingRow,
  otherWorkOn,
  page,
  problem,
  projectItem,
  projectOn,
  timeEntryView,
} from '../fakeApi'
import type { FakeAnswer } from '../fakeApi'
import type { TimeEntryView, TimeListsView } from '../../lib/hoursApi.types'
import { LISTS } from './myHours'

/** Today in the tests: Friday 13 November 2026 (noon UTC is the same calendar day in Zurich). */
export const TODAY = '2026-11-13'

/** The categories of `LISTS` plus "Other", which requires a note; "Seminars" stays retired. */
export const ENTRY_LISTS: TimeListsView = {
  categories: [...LISTS.categories, { id: 'tc-other', name: 'Other', requiresNote: true, retired: false }],
  workTypes: LISTS.workTypes,
}

/** Every category is retired: nothing can be chosen for other work (design S2, "none available"). */
export const RETIRED_ONLY_LISTS: TimeListsView = {
  categories: LISTS.categories.map((category) => ({ ...category, retired: true })),
  workTypes: LISTS.workTypes,
}

/** What projects-api, crm-api and meetings-api find for any text: one each, with a company where there is one. */
export const PROJECT_ROWS = page([
  projectItem({ id: 'p1', name: 'Project Alpha', company: { id: 'c1', name: 'Acme' } }),
  projectItem({ id: 'p2', name: 'Project Beta', company: null }),
])
export const DEAL_ROWS = page([
  dealItem({ id: 'd1', title: 'Acme renewal', company: { id: 'c1', name: 'Acme' } }),
  dealItem({ id: 'd2', title: 'Globex pilot', company: { id: 'c2', name: 'Globex' } }),
])
export const MEETING_ROWS = page([
  meetingRow({ id: 'm1', title: 'Kick-off with Acme', startsAt: '2026-11-03T09:30:00.000Z' }),
  meetingRow({ id: 'm2', title: 'Retro', startsAt: '2026-11-06T15:00:00.000Z' }),
])

/** The view of an entry the server answers a save with. */
export const SAVED: TimeEntryView = timeEntryView({ id: 'e-saved', day: TODAY, minutes: 90 })

/** A refusal, as hours-api answers it: Problem JSON with a `code`. */
export const refusal = (status: number, code?: string): FakeAnswer => ({ status, body: problem(status, code) })

/** `n` emoji: each is TWO UTF-16 code units and ONE code point, which is what the 1000 limit counts (plan § Entries). */
export const emoji = (n: number) => '😀'.repeat(n)

// ─── Editing (T28) ──────────────────────────────────────────────────────────

/**
 * 2 h 30 on Project Alpha with a work type, an activity the person can read and a note: the entry the edit
 * tests start from. `p1`, `a-offer` and `wt-p-dev` are the ids the pickers and the activity read answer with.
 */
export const EDIT_PROJECT: TimeEntryView = timeEntryView({
  id: 'e-edit',
  day: '2026-11-12',
  minutes: 150,
  note: 'Prepared the workshop',
  on: projectOn('p1', 'Project Alpha'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a-offer', subject: 'Write the offer', visibility: 'visible' },
})

/**
 * A project the person can no longer read (AC-4.10 applies to the author too, D43): no name, the activity withheld.
 * The ids stay: the author keeps their own entries' ids, hidden or not (D44), and the edit dialog re-picks them.
 */
export const EDIT_HIDDEN_PROJECT: TimeEntryView = timeEntryView({
  id: 'e-hidden-project',
  day: '2026-11-10',
  minutes: 120,
  note: null,
  on: projectOn('p-secret', 'Secret project', 'hidden'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a-secret', subject: null, visibility: 'hidden' },
})

/** The same project, with no activity pointed at. */
export const EDIT_HIDDEN_PROJECT_NO_ACTIVITY: TimeEntryView = {
  ...EDIT_HIDDEN_PROJECT,
  id: 'e-hidden-no-activity',
  activity: null,
}

/** The same on a deal, with nothing pointed at. */
export const EDIT_HIDDEN_DEAL: TimeEntryView = timeEntryView({
  id: 'e-hidden-deal',
  day: '2026-11-10',
  minutes: 60,
  on: dealOn('d-secret', 'Secret deal', 'hidden'),
  activity: null,
})

export const EDIT_HIDDEN_MEETING: TimeEntryView = timeEntryView({
  id: 'e-hidden-meeting',
  day: '2026-11-10',
  minutes: 60,
  on: meetingOn('m-secret', 'Secret meeting', { state: 'none' }, 'hidden'),
  activity: null,
})

/** Its owner did not answer: the name is unavailable, not withheld, so the dialog opens normally (design S2). */
export const EDIT_UNAVAILABLE_PROJECT: TimeEntryView = timeEntryView({
  id: 'e-unavailable-project',
  on: projectOn('p1', null, 'unavailable'),
  activity: { id: 'a-offer', subject: null, visibility: 'unavailable' },
})

export const EDIT_DEAL: TimeEntryView = timeEntryView({
  id: 'e-edit-deal',
  day: '2026-11-11',
  minutes: 90,
  on: dealOn('d1', 'Acme renewal'),
  workType: { id: 'wt-d-demo', name: 'Demo', retired: false },
})

/** A deal entry with a work type AND an activity of the deal (`dealActivities`' `a-call`): the case of a deal-to-deal move. */
export const EDIT_DEAL_WITH_ACTIVITY: TimeEntryView = timeEntryView({
  id: 'e-edit-deal-activity',
  day: '2026-11-11',
  minutes: 90,
  on: dealOn('d1', 'Acme renewal'),
  workType: { id: 'wt-d-demo', name: 'Demo', retired: false },
  activity: { id: 'a-call', subject: 'Call Acme about the renewal', visibility: 'visible' },
})

export const EDIT_MEETING: TimeEntryView = timeEntryView({
  id: 'e-edit-meeting',
  day: '2026-11-09',
  minutes: 60,
  note: 'Walked through the scope',
  on: meetingOn('m1', 'Kick-off with Acme'),
})

/** Other work on a RETIRED category (AC-3.4): the entry keeps it and shows it, and a note-only edit must not move it. */
export const EDIT_RETIRED_CATEGORY: TimeEntryView = timeEntryView({
  id: 'e-retired-category',
  day: '2026-11-05',
  minutes: 240,
  note: null,
  on: otherWorkOn('Seminars', 'tc-seminars', true),
})

/** A project entry on a RETIRED work type: the entry keeps it and shows it. */
export const EDIT_RETIRED_WORK_TYPE: TimeEntryView = timeEntryView({
  id: 'e-retired-work-type',
  on: projectOn('p1', 'Project Alpha'),
  workType: { id: 'wt-p-legacy', name: 'Legacy support', retired: true },
})

/** Other work on "Other", which REQUIRES a note, recorded WITH one. */
export const EDIT_OTHER_WITH_NOTE: TimeEntryView = timeEntryView({
  id: 'e-other-note',
  day: '2026-11-04',
  minutes: 180,
  note: 'Internal workshop',
  on: otherWorkOn('Other', 'tc-other'),
})

/**
 * Other work on "Other" recorded WITHOUT a note — before the category was marked as requiring one (D50, plan
 * amendment 4): a minutes-only or day-only fix of it is not refused for the missing note.
 */
export const EDIT_OTHER_NO_NOTE: TimeEntryView = timeEntryView({
  id: 'e-other-no-note',
  day: '2026-11-04',
  minutes: 180,
  note: null,
  on: otherWorkOn('Other', 'tc-other'),
})

/** Other work on a category that does NOT require a note, recorded without one. */
export const EDIT_TRAINING: TimeEntryView = timeEntryView({
  id: 'e-training',
  day: '2026-11-03',
  minutes: 60,
  note: null,
  on: otherWorkOn('Formazione', 'tc-formazione'),
})
