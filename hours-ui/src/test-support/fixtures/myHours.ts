/**
 * Fixtures of the My hours filters and totals (specs/029-time-tracking T24). Typed with the wire types,
 * so a contract change fails the build. The totals are in the order the SERVER sends them — chosen so
 * that a client that re-sorted them (by name, by minutes, by key) would visibly change it, which is what
 * the tests of "never re-sorted" lean on.
 */
import { totalsAnswer } from '../fakeApi'
import type { FakeHandler } from '../fakeApi'
import type { TimeListsView, TotalsAnswer } from '../../lib/hoursApi.types'

/** 13 November 2026 is a Friday in Zurich: noon UTC is the same day there. */
export const TODAY_INSTANT = '2026-11-13T12:00:00.000Z'

/**
 * Lists with the cases a filter must get right: a name typed in Italian (shown verbatim in both
 * languages, AC-3.8), a retired category and a retired work type (still offered by the filters, marked,
 * AC-3.4), and the same name ("Analysis") in the projects list and the deals list under different ids.
 */
export const LISTS: TimeListsView = {
  categories: [
    { id: 'tc-formazione', name: 'Formazione', requiresNote: false, retired: false },
    { id: 'tc-admin', name: 'Administration', requiresNote: false, retired: false },
    { id: 'tc-seminars', name: 'Seminars', requiresNote: false, retired: true },
  ],
  workTypes: {
    project: [
      { id: 'wt-p-dev', list: 'project', name: 'Development', retired: false },
      { id: 'wt-p-analysis', list: 'project', name: 'Analysis', retired: false },
      { id: 'wt-p-legacy', list: 'project', name: 'Legacy support', retired: true },
    ],
    deal: [
      { id: 'wt-d-analysis', list: 'deal', name: 'Analysis', retired: false },
      { id: 'wt-d-demo', list: 'deal', name: 'Demo', retired: false },
    ],
  },
}

/** By project: the keyed groups (minutes descending), then hidden, unavailable and none (plan § Totals). 137 h. */
export const PROJECT_TOTALS = totalsAnswer([
  { kind: 'keyed', key: 'p-beta', label: 'Project Beta', minutes: 3000 },
  { kind: 'keyed', key: 'p-alpha', label: 'Project Alpha', minutes: 2400 },
  { kind: 'hidden', minutes: 720 },
  { kind: 'unavailable', minutes: 150 },
  { kind: 'none', minutes: 1950 },
])

/** By deal, with the three merged kinds only a deal grouping has. 96 h 30. */
export const DEAL_TOTALS = totalsAnswer([
  { kind: 'keyed', key: 'd-acme', label: 'Acme renewal', minutes: 4800 },
  { kind: 'keyed', key: 'd-globex', label: 'Globex pilot', minutes: 90 },
  { kind: 'hidden', minutes: 120 },
  { kind: 'unavailable', minutes: 30 },
  { kind: 'deal-unknown', minutes: 150 },
  { kind: 'none', minutes: 600 },
])

/** By category: a retired one among them. 137 h. */
export const CATEGORY_TOTALS = totalsAnswer([
  { kind: 'keyed', key: 'tc-formazione', label: 'Formazione', minutes: 600, retired: false },
  { kind: 'keyed', key: 'tc-seminars', label: 'Seminars', minutes: 180, retired: true },
  { kind: 'none', minutes: 7440 },
])

/** By month, newest first, a month in the middle missing (a month without entries is absent). */
export const MONTH_TOTALS = totalsAnswer([
  { kind: 'keyed', key: '2026-11', label: null, minutes: 3600 },
  { kind: 'keyed', key: '2026-09', label: null, minutes: 4620 },
])

/** By day, as My hours asks it to label the entries (T25 shows them; T24 only asks). */
export const DAY_TOTALS = totalsAnswer([
  { kind: 'keyed', key: '2026-11-12', label: null, minutes: 510 },
  { kind: 'keyed', key: '2026-11-10', label: null, minutes: 240 },
])

/** `GET /time-entries/totals`, answered per `groupBy` with the fixtures above (nothing for an ungrouped ask). */
export const totalsHandler: FakeHandler = (url) => {
  const byGroup: Record<string, TotalsAnswer> = {
    project: PROJECT_TOTALS,
    deal: DEAL_TOTALS,
    category: CATEGORY_TOTALS,
    month: MONTH_TOTALS,
    day: DAY_TOTALS,
  }
  return { status: 200, body: byGroup[url.searchParams.get('groupBy') ?? ''] ?? totalsAnswer([]) }
}
