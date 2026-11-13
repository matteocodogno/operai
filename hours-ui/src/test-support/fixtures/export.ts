/**
 * Fixtures of the export (specs/029-time-tracking T30; plan § Export file; AC-4.6, AC-4.10). Typed with the
 * wire types, so a contract change fails the build.
 *
 * `EXPORT_ENTRIES` holds sixteen entries that between them meet every case the file has a cell for: each of
 * the four kinds of target, a name the viewer can read, may not read and could not be loaded, a meeting
 * linked to a deal in each of the five states of `MeetingDeal`, an activity of each visibility, an account
 * that was deactivated and one whose name could not be read, and the shortest and the longest duration.
 *
 * `EXPORT_DEAL_TOTALS` is what `GET /time-entries/totals?groupBy=deal` answers for the same entries, written
 * out by hand from the sums in the comments, NOT computed from the entries: the test that sums the file's
 * Hours by its Counts for deal and compares the result with this answer (D40) proves nothing if both are
 * derived the same way.
 */
import {
  dealOn,
  entriesPage,
  meetingOn,
  otherWorkOn,
  projectOn,
  seenByOthers,
  timeEntryView,
  totalsAnswer,
  ADA,
  GRACE,
  GONE,
} from '../fakeApi'
import type { EntriesPage, Person, TimeEntryView, TotalsAnswer } from '../../lib/hoursApi.types'

/**
 * An entry of the export: another person's, so it is what hours-api answers a holder about it (D44; plan § Views
 * "Ids of what the viewer cannot read"): no id for a project, deal, meeting or activity the holder cannot read or
 * whose owner did not answer. A record they can read keeps its id.
 */
const entryOf = (overrides: Parameters<typeof timeEntryView>[0]): TimeEntryView =>
  seenByOthers(timeEntryView(overrides))

/** An account `auth` could not resolve this time. */
export const UNKNOWN_PERSON: Person = { id: 'u-who', name: null, status: 'unknown' }

const DEVELOPMENT = { id: 'wt-p-dev', name: 'Development', retired: false }
const DEMO = { id: 'wt-d-demo', name: 'Demo', retired: false }
const OFFER = { id: 'wt-d-offer', name: 'Offer', retired: false }

const ACME = { state: 'linked', visibility: 'visible', id: 'd1', label: 'Acme renewal', href: '/crm/deals/d1' } as const
const GLOBEX = {
  state: 'linked',
  visibility: 'visible',
  id: 'd2',
  label: 'Globex pilot',
  href: '/crm/deals/d2',
} as const

/** 4 h on a project the viewer can read, with a work type, an activity and a two-line note. Counts for no deal. */
export const ALPHA_DEV: TimeEntryView = entryOf({
  id: 'e-alpha-dev',
  day: '2026-11-12',
  minutes: 240,
  person: ADA,
  on: projectOn('p1', 'Project Alpha'),
  workType: DEVELOPMENT,
  activity: { id: 'a-offer', subject: 'Write the offer', visibility: 'visible' },
  note: 'Line one\nline two',
})

/** 2 h on a project the viewer may not read: no name, no link, the activity withheld too. Counts for no deal. */
export const SECRET_PROJECT: TimeEntryView = entryOf({
  id: 'e-secret-project',
  day: '2026-11-12',
  minutes: 120,
  person: GRACE,
  on: projectOn('p-secret', 'Secret project', 'hidden'),
  workType: DEVELOPMENT,
  activity: { id: 'a-secret', subject: null, visibility: 'hidden' },
})

/** 1 h 30 on a deal the viewer can read. Counts for that deal. */
export const ACME_DEMO: TimeEntryView = entryOf({
  id: 'e-acme-demo',
  day: '2026-11-11',
  minutes: 90,
  person: ADA,
  on: dealOn('d1', 'Acme renewal'),
  workType: DEMO,
  activity: { id: 'a-demo', subject: 'Prepare the demo', visibility: 'visible' },
})

/** 2 h 30 on a meeting linked to the same deal: its hours count for Acme renewal too (AC-2.6). */
export const KICKOFF_ACME: TimeEntryView = entryOf({
  id: 'e-kickoff',
  day: '2026-11-11',
  minutes: 150,
  person: GRACE,
  on: meetingOn('m1', 'Kick-off call', ACME),
})

/** 1 h on another deal the viewer can read. Counts for that deal. */
export const GLOBEX_OFFER: TimeEntryView = entryOf({
  id: 'e-globex-offer',
  day: '2026-11-10',
  minutes: 60,
  person: ADA,
  on: dealOn('d2', 'Globex pilot'),
  workType: OFFER,
})

/** 30 min on a deal the viewer may not read. Counts for a deal that is not visible. */
export const SECRET_DEAL: TimeEntryView = entryOf({
  id: 'e-secret-deal',
  day: '2026-11-10',
  minutes: 30,
  person: ADA,
  on: dealOn('d-secret', 'Secret deal', 'hidden'),
  workType: OFFER,
  activity: { id: 'a-secret-deal', subject: null, visibility: 'hidden' },
})

/** 1 h 30 on a deal whose name CRM did not answer. Counts for a deal whose name is unavailable. */
export const UNNAMED_DEAL: TimeEntryView = entryOf({
  id: 'e-unnamed-deal',
  day: '2026-11-10',
  minutes: 90,
  person: ADA,
  on: dealOn('d3', null, 'unavailable'),
  activity: { id: 'a-unnamed', subject: null, visibility: 'unavailable' },
})

/** 1 h on a meeting linked to a deal the viewer may not read. */
export const WEEKLY_HIDDEN_DEAL: TimeEntryView = entryOf({
  id: 'e-weekly-hidden',
  day: '2026-11-09',
  minutes: 60,
  person: ADA,
  on: meetingOn('m2', 'Weekly', { state: 'linked', visibility: 'hidden' }),
})

/** 30 min on a meeting linked to a deal whose name CRM did not answer. */
export const WEEKLY_UNAVAILABLE_DEAL: TimeEntryView = entryOf({
  id: 'e-weekly-unavailable',
  day: '2026-11-09',
  minutes: 30,
  person: ADA,
  on: meetingOn('m2', 'Weekly', { state: 'linked', visibility: 'unavailable' }),
})

/** 2 h 30 on a meeting whose deal could not be asked (the system route did not answer, AC-4.7). */
export const RETRO_UNKNOWN_DEAL: TimeEntryView = entryOf({
  id: 'e-retro',
  day: '2026-11-09',
  minutes: 150,
  person: GRACE,
  on: meetingOn('m3', 'Retro', { state: 'unknown' }),
})

/** 30 min on a meeting linked to no deal. Counts for no deal. */
export const ALL_HANDS: TimeEntryView = entryOf({
  id: 'e-all-hands',
  day: '2026-11-06',
  minutes: 30,
  person: ADA,
  on: meetingOn('m4', 'All hands', { state: 'none' }),
})

/** The longest entry, 24 h, by a deactivated account (auth keeps no name for it), in a category typed in Italian. */
export const TRAINING: TimeEntryView = entryOf({
  id: 'e-training',
  day: '2026-11-06',
  minutes: 1440,
  person: GONE,
  on: otherWorkOn('Formazione'),
  note: 'Corso interno',
})

/** 1 h of other work by a person whose name could not be read. */
export const ADMIN_WORK: TimeEntryView = entryOf({
  id: 'e-admin',
  day: '2026-11-05',
  minutes: 60,
  person: UNKNOWN_PERSON,
  on: otherWorkOn('Administration'),
})

/** 30 min on a meeting the viewer may not read, linked to a deal they can: the deal is named, the meeting is not. */
export const SECRET_MEETING_GLOBEX: TimeEntryView = entryOf({
  id: 'e-secret-meeting',
  day: '2026-11-05',
  minutes: 30,
  person: ADA,
  on: meetingOn('m-secret', 'Board prep', GLOBEX, 'hidden'),
})

/** 1 h on a meeting whose title Meetings did not answer, linked to no deal. */
export const UNNAMED_MEETING: TimeEntryView = entryOf({
  id: 'e-unnamed-meeting',
  day: '2026-11-04',
  minutes: 60,
  person: ADA,
  on: meetingOn('m5', null, { state: 'none' }, 'unavailable'),
})

/** 30 min on a project whose name Projects did not answer, on a RETIRED work type kept on the entry (AC-3.4). */
export const UNNAMED_PROJECT: TimeEntryView = entryOf({
  id: 'e-unnamed-project',
  day: '2026-11-04',
  minutes: 30,
  person: ADA,
  on: projectOn('p2', null, 'unavailable'),
  workType: { id: 'wt-p-legacy', name: 'Legacy work', retired: true },
  activity: { id: 'a-unnamed-project', subject: null, visibility: 'unavailable' },
})

/** The sixteen entries in the order the server lists them (newest day first). */
export const EXPORT_ENTRIES: readonly TimeEntryView[] = [
  ALPHA_DEV,
  SECRET_PROJECT,
  ACME_DEMO,
  KICKOFF_ACME,
  GLOBEX_OFFER,
  SECRET_DEAL,
  UNNAMED_DEAL,
  WEEKLY_HIDDEN_DEAL,
  WEEKLY_UNAVAILABLE_DEAL,
  RETRO_UNKNOWN_DEAL,
  ALL_HANDS,
  TRAINING,
  ADMIN_WORK,
  SECRET_MEETING_GLOBEX,
  UNNAMED_MEETING,
  UNNAMED_PROJECT,
]

/**
 * `GET /time-entries/totals?groupBy=deal` over `EXPORT_ENTRIES`, by hand (minutes):
 *   Acme renewal             90 (deal) + 150 (meeting)                             = 240
 *   Globex pilot             60 (deal) + 30 (the meeting the viewer may not read)  =  90
 *   hidden                   30 (deal) + 60 (a meeting's deal)                     =  90
 *   unavailable              90 (deal) + 30 (a meeting's deal)                     = 120
 *   deal-unknown             150 (a meeting whose deal could not be asked)         = 150
 *   none                     240 + 120 (projects) + 30 + 60 (meetings, no deal)
 *                            + 1440 + 60 (other work) + 30 (a project)             = 1980
 *   total                                                                          = 2670
 */
export const EXPORT_DEAL_TOTALS: TotalsAnswer = totalsAnswer([
  { kind: 'keyed', key: 'd1', label: 'Acme renewal', minutes: 240 },
  { kind: 'keyed', key: 'd2', label: 'Globex pilot', minutes: 90 },
  { kind: 'hidden', minutes: 90 },
  { kind: 'unavailable', minutes: 120 },
  { kind: 'deal-unknown', minutes: 150 },
  { kind: 'none', minutes: 1980 },
])

/** What the whole export is worth, written out and not summed from the entries. */
export const EXPORT_TOTAL_MINUTES = 2670

/** A page of the walk: `limit=500` and a cursor until the last page. */
export const exportPage = (
  items: readonly TimeEntryView[],
  nextCursor: string | null = null,
  unavailable: EntriesPage['unavailable'] = [],
): EntriesPage => entriesPage([...items], { nextCursor, unavailable })
