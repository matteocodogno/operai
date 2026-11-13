/**
 * Fixtures of the entry dialog (specs/029-time-tracking T27): the lists it offers, what the three pickers find,
 * the answers a save can come back with, and the long notes the limit is checked with. Typed with the wire
 * types, so a contract change fails the build. Built on `myHours`'s `LISTS` (a retired category, a retired
 * work type, the same name in both work-type lists) with one more category that REQUIRES a note (AC-3.6).
 */
import { dealItem, meetingRow, page, problem, projectItem, timeEntryView } from '../fakeApi'
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
