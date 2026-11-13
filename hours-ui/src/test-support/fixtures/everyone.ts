/**
 * Fixtures of Everyone's hours (specs/029-time-tracking T29). Typed with the wire types, so a contract change
 * fails the build. The person totals are in the order the SERVER sends them (plan § Totals: by name, an
 * unresolved name last, then by id) so that a client that re-sorted them would visibly change it, and they
 * hold the three kinds of person a holder meets: one with a name, one deactivated (auth keeps no name for it)
 * and one whose name could not be read.
 */
import {
  dealOn,
  entriesPage,
  meetingOn,
  otherWorkOn,
  projectOn,
  timeEntryView,
  totalsAnswer,
  ADA,
  GRACE,
  GONE,
} from '../fakeApi'
import type { FakeHandler } from '../fakeApi'
import type { EntriesPage, Person, TimeEntryView, TotalsAnswer } from '../../lib/hoursApi.types'
import { totalsHandler } from './myHours'

export { ADA, GRACE, GONE }

/** A person whose name `auth` could not resolve this time. */
export const UNKNOWN: Person = { id: 'u-who', name: null, status: 'unknown' }

/** By person: Ada (12 h), Grace (10 h 30), then the two without a name, by id. 22 h 30 + 4 h + 1 h = 27 h 30. */
export const PERSON_TOTALS: TotalsAnswer = totalsAnswer([
  { kind: 'keyed', key: ADA.id, label: ADA.name, minutes: 720, status: 'active' },
  { kind: 'keyed', key: GRACE.id, label: GRACE.name, minutes: 630, status: 'active' },
  { kind: 'keyed', key: GONE.id, label: null, minutes: 240, status: 'deleted' },
  { kind: 'keyed', key: UNKNOWN.id, label: null, minutes: 60, status: 'unknown' },
])

/** The same answer after Ada was renamed in `auth` (AC-4.8): the same keys, the new name. */
export const PERSON_TOTALS_RENAMED: TotalsAnswer = totalsAnswer(
  PERSON_TOTALS.groups.map((group) =>
    group.kind === 'keyed' && group.key === ADA.id ? { ...group, label: 'Ada King' } : group,
  ),
)

/** 4 h by Ada on a project the viewer can read, with a work type and an activity. */
export const ADA_PROJECT: TimeEntryView = timeEntryView({
  id: 'e-ada-alpha',
  day: '2026-11-12',
  minutes: 240,
  person: ADA,
  on: projectOn('p1', 'Project Alpha'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a1', subject: 'Write the offer', visibility: 'visible' },
})

/** 2 h by Grace on a project the holder may not read (AC-4.10): no label, no link, the activity withheld too. */
export const GRACE_HIDDEN: TimeEntryView = timeEntryView({
  id: 'e-grace-hidden',
  day: '2026-11-12',
  minutes: 120,
  person: GRACE,
  on: projectOn('p-secret', 'Secret project', 'hidden'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a-secret', subject: null, visibility: 'hidden' },
  note: 'Line one\nline two',
})

/** 2 h 30 by a deactivated account on a meeting linked to a deal the holder can read (AC-2.6). */
export const GONE_MEETING: TimeEntryView = timeEntryView({
  id: 'e-gone-kickoff',
  day: '2026-11-10',
  minutes: 150,
  person: GONE,
  on: meetingOn('m1', 'Kick-off call', {
    state: 'linked',
    visibility: 'visible',
    id: 'd1',
    label: 'Acme renewal',
    href: '/crm/deals/d1',
  }),
})

/** 1 h of other work by a person whose name could not be read, in a category typed in Italian (AC-3.8). */
export const UNKNOWN_TRAINING: TimeEntryView = timeEntryView({
  id: 'e-who-training',
  day: '2026-11-10',
  minutes: 60,
  person: UNKNOWN,
  on: otherWorkOn('Formazione'),
  note: 'Corso interno',
})

/** 1 h 30 by Ada on a deal, on a RETIRED work type (AC-3.4), whose name did not come (AC-4.7). */
export const ADA_DEAL: TimeEntryView = timeEntryView({
  id: 'e-ada-deal',
  day: '2026-11-09',
  minutes: 90,
  person: ADA,
  on: dealOn('d2', null, 'unavailable'),
  workType: { id: 'wt-d-legacy', name: 'Legacy demo', retired: true },
  activity: { id: 'a-x', subject: null, visibility: 'unavailable' },
})

export const CURSOR = 'cursor-2'

/** The first page: two entries of the 12th, and a cursor. */
export const PAGE_ONE: EntriesPage = entriesPage([ADA_PROJECT, GRACE_HIDDEN], { nextCursor: CURSOR })

/** The second page: the 10th, then the 9th. No cursor: the last page. */
export const PAGE_TWO: EntriesPage = entriesPage([GONE_MEETING, UNKNOWN_TRAINING, ADA_DEAL])

/** `GET /time-entries` over `PAGE_ONE` / `PAGE_TWO`, by the cursor the request carries. */
export const entriesHandler: FakeHandler = (url) => ({
  status: 200,
  body: url.searchParams.get('cursor') === CURSOR ? PAGE_TWO : PAGE_ONE,
})

/** `GET /time-entries/totals`: the person grouping as above, every other grouping as `myHours.ts` has it. */
export const totalsWithPeople: FakeHandler = (url, init, params) =>
  url.searchParams.get('groupBy') === 'person' ? { status: 200, body: PERSON_TOTALS } : totalsHandler(url, init, params)
