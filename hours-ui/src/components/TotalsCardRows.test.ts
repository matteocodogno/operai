/**
 * The rows of the Totals table (specs/20261112-project-hours T12; AC-4.5, AC-4.10, plan R4; design S4 "By-project
 * totals"): a group is one row, in the order the server sent them, and a kind this build has no words for still
 * shows its hours.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import type { TotalsGroup } from '../lib/hoursApi.types'
import { totalsRows } from './TotalsCardRows'

const t = strings.totals

describe('by project: meeting hours whose project could not be asked (AC-4.5, AC-4.10)', () => {
  it('shows `project-unknown` as "Meetings whose project is unknown right now"', () => {
    const rows = totalsRows('project', [{ kind: 'project-unknown', minutes: 150 }])
    expect(rows.map((row) => row.label)).toEqual(['Meetings whose project is unknown right now'])
    expect(t.rows.project.projectUnknown).toBe('Meetings whose project is unknown right now')
  })

  it('keeps the server’s order — keyed, hidden, unavailable, project-unknown, none — and sorts nothing', () => {
    const groups: TotalsGroup[] = [
      { kind: 'keyed', key: 'p1', label: 'Project Alpha', minutes: 60 },
      { kind: 'hidden', minutes: 120 },
      { kind: 'unavailable', minutes: 30 },
      { kind: 'project-unknown', minutes: 900 },
      { kind: 'none', minutes: 600 },
    ]
    expect(totalsRows('project', groups).map((row) => [row.label, row.minutes])).toEqual([
      ['Project Alpha', 60],
      [t.rows.project.hidden, 120],
      [t.rows.project.unavailable, 30],
      [t.rows.project.projectUnknown, 900],
      [t.rows.project.none, 600],
    ])
  })

  it('gives each merged row its own key, so two different kinds never collide', () => {
    const rows = totalsRows('project', [
      { kind: 'hidden', minutes: 1 },
      { kind: 'project-unknown', minutes: 2 },
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })
})

describe('a kind this build has no words for (plan R4: an old hours-ui on a newer hours-api)', () => {
  it('still shows its hours, as "Other hours", in place', () => {
    const future = { kind: 'brand-new', minutes: 90 } as unknown as TotalsGroup
    const rows = totalsRows('project', [{ kind: 'keyed', key: 'p1', label: 'Project Alpha', minutes: 60 }, future])
    expect(rows.map((row) => [row.label, row.minutes])).toEqual([
      ['Project Alpha', 60],
      [t.rows.other, 90],
    ])
  })

  it('shows `project-unknown` under any other grouping as "Other hours" rather than throwing or hiding it', () => {
    for (const groupBy of ['person', 'deal', 'category', 'month'] as const) {
      const [row] = totalsRows(groupBy, [{ kind: 'project-unknown', minutes: 30 }])
      expect(row).toEqual({ key: 'project-unknown:0', label: t.rows.other, minutes: 30 })
    }
  })
})
