/**
 * What the hours panel takes in and what it shows of an answer, apart from how it looks (specs/20261112-project-hours T13; plan §
 * API contracts "`hours/HostHours`" and `SummaryAnswer`; design S3; AC-2.1–2.5, AC-2.7, AC-4.9, AC-3.2): two plain strings from a host with
 * a refusal of any set that would ask about nothing, a refusal to show an answer that is not the contract's (no figure rather than a
 * wrong one), and the rows of the two tables in the server's order.
 */
import { describe, expect, it } from 'vitest'
import { checkProps, isSummaryAnswer, notesOf, personRows, workTypeRows } from './HostHoursModel'
import type { HostHoursProps } from './HostHoursModel'
import type { SummaryAnswer, TotalsGroup } from './lib/hoursApi.types'
import { strings } from './strings'

const PROJECT: HostHoursProps = { on: 'project', targetId: 'p1' }
const DEAL: HostHoursProps = { on: 'deal', targetId: 'd1' }

const ANSWER: SummaryAnswer = {
  on: { type: 'project', id: 'p1' },
  totalMinutes: 5400,
  windowMinutes: null,
  byWorkType: [
    { kind: 'keyed', key: 'wt-dev', label: 'Development', minutes: 3000 },
    { kind: 'none', minutes: 2400 },
  ],
  byPerson: null,
  unavailable: [],
}

describe('checkProps (plan § `hours/HostHours`: two strings and nothing else)', () => {
  it.each([
    ['a project', PROJECT],
    ['a deal', DEAL],
  ] as const)('accepts %s', (_what, props) => {
    expect(checkProps(props)).toEqual(props)
  })

  it.each([
    ['a project with no id', { ...PROJECT, targetId: '' }],
    ['a deal with no id', { ...DEAL, targetId: '' }],
    ['an id that is only spaces', { ...PROJECT, targetId: '  ' }],
    ['other work (that is Record hours’, not this panel’s, kind)', { on: 'none', targetId: '' }],
    ['a meeting', { ...PROJECT, on: 'meeting' }],
    ['an unknown kind', { ...PROJECT, on: 'task' }],
    ['no kind', { targetId: 'p1' }],
    ['an id that is not a string', { ...PROJECT, targetId: 7 }],
    ['no id', { on: 'project' }],
    ['nothing at all', undefined],
    ['null', null],
  ] as const)('refuses %s: a host bug, never a read of nothing', (_what, props) => {
    expect(() => checkProps(props as unknown as HostHoursProps)).toThrow(/HostHours/)
  })

  it('names the rule it broke and never the values', () => {
    expect(() =>
      checkProps({ on: 'project', targetId: '', secret: 'Confidential project name' } as HostHoursProps),
    ).toThrow(/^(?!.*Confidential)/s)
    expect(() => checkProps({ on: 'Confidential kind', targetId: 'p1' } as unknown as HostHoursProps)).toThrow(
      /^(?!.*Confidential)/s,
    )
  })
})

describe('isSummaryAnswer (no figure rather than one that could be wrong, AC-4.9)', () => {
  it.each([
    ['without per person', ANSWER],
    [
      'with per person',
      { ...ANSWER, byPerson: [{ kind: 'keyed', key: 'u1', label: 'Ada', minutes: 5400, status: 'active' }] },
    ],
    ['with nothing recorded', { ...ANSWER, totalMinutes: 0, byWorkType: [], byPerson: [] }],
    ['with notes', { ...ANSWER, unavailable: ['identities', 'authz'] }],
    ['with a note this build does not know (a server one step ahead)', { ...ANSWER, unavailable: ['somethingNew'] }],
    ['with a window figure', { ...ANSWER, windowMinutes: 30 }],
  ] as const)('accepts an answer %s', (_what, answer) => {
    expect(isSummaryAnswer(answer)).toBe(true)
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a list', []],
    ['a missing total', { ...ANSWER, totalMinutes: undefined }],
    ['a total that is text', { ...ANSWER, totalMinutes: '90' }],
    ['a negative total', { ...ANSWER, totalMinutes: -30 }],
    ['a total that is not a number', { ...ANSWER, totalMinutes: Number.NaN }],
    ['a total that is not finite', { ...ANSWER, totalMinutes: Number.POSITIVE_INFINITY }],
    ['work types that are not a list', { ...ANSWER, byWorkType: null }],
    ['a work type group with no minutes', { ...ANSWER, byWorkType: [{ kind: 'none' }] }],
    ['a work type group with negative minutes', { ...ANSWER, byWorkType: [{ kind: 'none', minutes: -1 }] }],
    ['a group that is not an object', { ...ANSWER, byWorkType: [7] }],
    ['a group with no kind', { ...ANSWER, byWorkType: [{ minutes: 30 }] }],
    ['per person that is neither null nor a list', { ...ANSWER, byPerson: {} }],
    ['per person missing (the contract says null)', { ...ANSWER, byPerson: undefined }],
    [
      'a person group with bad minutes',
      { ...ANSWER, byPerson: [{ kind: 'keyed', key: 'u1', label: 'Ada', minutes: 'x' }] },
    ],
    ['notes that are not a list', { ...ANSWER, unavailable: 'authz' }],
    ['notes missing', { ...ANSWER, unavailable: undefined }],
  ] as const)('refuses an answer with %s', (_what, answer) => {
    expect(isSummaryAnswer(answer)).toBe(false)
  })
})

describe('workTypeRows (design S3 "By work type": the server’s order, never re-sorted)', () => {
  it('a keyed group is its work type, the none group is "Without a work type"', () => {
    expect(workTypeRows(ANSWER.byWorkType)).toEqual([
      { key: 'keyed:wt-dev', label: 'Development', minutes: 3000 },
      { key: 'none:1', label: strings.hostHours.byWorkType.none, minutes: 2400 },
    ])
  })

  it('keeps the order it is given, whatever the minutes', () => {
    const groups: TotalsGroup[] = [
      { kind: 'keyed', key: 'a', label: 'Analysis', minutes: 30 },
      { kind: 'keyed', key: 'b', label: 'Build', minutes: 600 },
      { kind: 'none', minutes: 60 },
    ]
    expect(workTypeRows(groups).map((row) => row.label)).toEqual([
      'Analysis',
      'Build',
      strings.hostHours.byWorkType.none,
    ])
  })

  it('says a retired work type is retired, with the word the Entries card uses', () => {
    const [row] = workTypeRows([{ kind: 'keyed', key: 'old', label: 'Support', minutes: 30, retired: true }])
    expect(row?.label).toBe(strings.entries.retired('Support'))
  })

  it('a keyed group whose name did not come reads "Name unavailable", never its key', () => {
    const [row] = workTypeRows([{ kind: 'keyed', key: 'wt-secret-id', label: null, minutes: 30 }])
    expect(row?.label).toBe(strings.totals.nameUnavailable)
    expect(row?.label).not.toContain('wt-secret-id')
  })

  it('a kind this build has no words for still shows, as "Other hours" (the hours are counted)', () => {
    const [row] = workTypeRows([{ kind: 'hidden', minutes: 30 }])
    expect(row).toMatchObject({ label: strings.totals.rows.other, minutes: 30 })
  })

  it('gives every row its own key, two groups of one kind included', () => {
    const keys = workTypeRows([
      { kind: 'none', minutes: 30 },
      { kind: 'none', minutes: 30 },
      { kind: 'keyed', key: 'a', label: 'A', minutes: 30 },
    ]).map((row) => row.key)
    expect(new Set(keys).size).toBe(3)
  })
})

describe('personRows (design S3 "By person": named as everywhere else)', () => {
  it('a person is named as the Person filter and the Everyone’s hours column name them', () => {
    expect(
      personRows([
        { kind: 'keyed', key: 'u1', label: 'Ada Lovelace', minutes: 3000, status: 'active' },
        { kind: 'keyed', key: 'u2', label: null, minutes: 1800, status: 'unknown' },
        { kind: 'keyed', key: 'u3', label: null, minutes: 600, status: 'deleted' },
        { kind: 'keyed', key: 'u4', label: 'Grace Hopper', minutes: 30, status: 'deleted' },
      ]),
    ).toEqual([
      { key: 'keyed:u1', label: 'Ada Lovelace', minutes: 3000 },
      { key: 'keyed:u2', label: strings.everyone.person.unknown, minutes: 1800 },
      { key: 'keyed:u3', label: strings.everyone.person.deactivated(strings.everyone.person.unknown), minutes: 600 },
      { key: 'keyed:u4', label: strings.everyone.person.deactivated('Grace Hopper'), minutes: 30 },
    ])
  })

  it('a person group with no status is read as unknown, so a bare name is still shown', () => {
    const [row] = personRows([{ kind: 'keyed', key: 'u1', label: 'Ada', minutes: 30 }])
    expect(row?.label).toBe('Ada')
  })

  it('a group that is not a person still shows, as "Other hours"', () => {
    const [row] = personRows([{ kind: 'none', minutes: 30 }])
    expect(row?.label).toBe(strings.totals.rows.other)
  })
})

describe('notesOf (the two things an answer can say it could not ask)', () => {
  it.each([
    [[], { identities: false, authz: false }],
    [['identities'], { identities: true, authz: false }],
    [['authz'], { identities: false, authz: true }],
    [['authz', 'identities'], { identities: true, authz: true }],
    [['somethingNew'], { identities: false, authz: false }],
  ] as const)('%j → %j', (unavailable, notes) => {
    expect(notesOf({ ...ANSWER, unavailable: [...unavailable] as SummaryAnswer['unavailable'] })).toEqual(notes)
  })
})
