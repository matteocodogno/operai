/**
 * Fixtures of the entries by day on My hours (specs/029-time-tracking T25). Typed with the wire types, so a
 * contract change fails the build. The two pages are cut so that one DAY (12 November) straddles them: its
 * full total (8 h 30, `ENTRY_DAY_TOTALS` below) must show before "Load more" although only two of its
 * three entries have arrived — the case the `groupBy=day` answer exists for (plan § Totals, AC-4.1).
 */
import { dealOn, entriesPage, meetingOn, otherWorkOn, projectOn, timeEntryView, totalsAnswer } from '../fakeApi'
import type { FakeHandler } from '../fakeApi'
import type { EntriesPage, TimeEntryView } from '../../lib/hoursApi.types'
import { totalsHandler } from './myHours'

/** 4 h on a project the viewer can read, with a work type and an activity they can read. */
export const ALPHA: TimeEntryView = timeEntryView({
  id: 'e-alpha',
  day: '2026-11-12',
  minutes: 240,
  on: projectOn('p1', 'Project Alpha'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a1', subject: 'Write the offer', visibility: 'visible' },
})

/**
 * 2 h on a project the viewer may not read (AC-4.10): no label, no link, the activity withheld too. It is the
 * viewer's OWN entry (My hours lists nobody else's), so it keeps its ids, hidden or not (D44).
 */
export const HIDDEN_PROJECT: TimeEntryView = timeEntryView({
  id: 'e-hidden',
  day: '2026-11-12',
  minutes: 120,
  on: projectOn('p-secret', 'Secret project', 'hidden'),
  workType: { id: 'wt-p-dev', name: 'Development', retired: false },
  activity: { id: 'a-secret', subject: null, visibility: 'hidden' },
})

/** 2 h 30 on a meeting linked to a deal the viewer can read (AC-2.6), with a note. */
export const KICKOFF: TimeEntryView = timeEntryView({
  id: 'e-kickoff',
  day: '2026-11-12',
  minutes: 150,
  note: 'Walked through the scope',
  on: meetingOn('m1', 'Kick-off call', {
    state: 'linked',
    visibility: 'visible',
    id: 'd1',
    label: 'Acme renewal',
    href: '/crm/deals/d1',
  }),
})

/** 4 h of other work on 10 November, in a category a person typed in Italian (AC-3.8). */
export const TRAINING: TimeEntryView = timeEntryView({
  id: 'e-training',
  day: '2026-11-10',
  minutes: 240,
  on: otherWorkOn('Formazione'),
})

/** 1 h 30 on a deal, on 10 November, on a RETIRED work type (AC-3.4). */
export const DEAL_ENTRY: TimeEntryView = timeEntryView({
  id: 'e-deal',
  day: '2026-11-10',
  minutes: 90,
  on: dealOn('d2', 'Globex pilot'),
  workType: { id: 'wt-d-legacy', name: 'Legacy demo', retired: true },
})

export const CURSOR = 'cursor-2'

/** The first page: two of the three entries of the 12th, and a cursor. */
export const PAGE_ONE: EntriesPage = entriesPage([ALPHA, HIDDEN_PROJECT], { nextCursor: CURSOR })

/** The second page: the last entry of the 12th, then the 10th. No cursor: the last page. */
export const PAGE_TWO: EntriesPage = entriesPage([KICKOFF, TRAINING, DEAL_ENTRY])

/** `GET /time-entries` over `PAGE_ONE` / `PAGE_TWO`, by the cursor the request carries. */
export const entriesHandler: FakeHandler = (url) => ({
  status: 200,
  body: url.searchParams.get('cursor') === CURSOR ? PAGE_TWO : PAGE_ONE,
})

/** What `GET /time-entries/totals?groupBy=day` answers for those three entries' days: the server's figures. */
export const ENTRY_DAY_TOTALS = totalsAnswer([
  { kind: 'keyed', key: '2026-11-12', label: null, minutes: 510 },
  { kind: 'keyed', key: '2026-11-10', label: null, minutes: 330 },
])

/** `GET /time-entries/totals`: the day totals of the entries above, every other grouping as `myHours.ts` has it. */
export const totalsWithDays: FakeHandler = (url, init, params) =>
  url.searchParams.get('groupBy') === 'day' ? { status: 200, body: ENTRY_DAY_TOTALS } : totalsHandler(url, init, params)
