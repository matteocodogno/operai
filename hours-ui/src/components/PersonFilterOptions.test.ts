/**
 * How a person is named, and the Person filter's options from the totals (specs/029-time-tracking T29; AC-4.8,
 * design S4 "Filters card"): "Unknown user" for a name that could not be read, "(deactivated)" for a closed
 * account, the server's order kept, and only the people the person grouping holds.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import { totalsAnswer } from '../test-support/fakeApi'
import { personName, personOptions } from './PersonFilterOptions'

describe('personName', () => {
  it('is the name as auth resolved it', () => {
    expect(personName('Ada Lovelace', 'active')).toBe('Ada Lovelace')
  })

  it('is "Unknown user" for a name that could not be read (null, status unknown)', () => {
    expect(personName(null, 'unknown')).toBe(strings.everyone.person.unknown)
    expect(personName(null, 'unknown')).toBe('Unknown user')
  })

  it('is "Unknown user" too for an active person whose name did not come, and for a blank one', () => {
    expect(personName(null, 'active')).toBe('Unknown user')
    expect(personName('  ', 'active')).toBe('Unknown user')
  })

  it('marks a deactivated account: its name (none is kept by auth) followed by "(deactivated)"', () => {
    expect(personName('Ada Lovelace', 'deleted')).toBe('Ada Lovelace (deactivated)')
    expect(personName(null, 'deleted')).toBe('Unknown user (deactivated)')
  })
})

describe('personOptions', () => {
  it('is one option per keyed group, id = the user id the filter sends, in the order the server sent them', () => {
    const answer = totalsAnswer([
      { kind: 'keyed', key: 'u-grace', label: 'Grace Hopper', minutes: 600, status: 'active' },
      { kind: 'keyed', key: 'u-ada', label: 'Ada Lovelace', minutes: 120, status: 'active' },
    ])
    expect(personOptions(answer)).toEqual([
      { id: 'u-grace', label: 'Grace Hopper' },
      { id: 'u-ada', label: 'Ada Lovelace' },
    ])
  })

  it('names an unreadable person "Unknown user" and a closed account "(deactivated)"', () => {
    const answer = totalsAnswer([
      { kind: 'keyed', key: 'u-ada', label: 'Ada Lovelace', minutes: 120, status: 'active' },
      { kind: 'keyed', key: 'u-gone', label: null, minutes: 60, status: 'deleted' },
      { kind: 'keyed', key: 'u-who', label: null, minutes: 30, status: 'unknown' },
    ])
    expect(personOptions(answer).map((option) => option.label)).toEqual([
      'Ada Lovelace',
      'Unknown user (deactivated)',
      'Unknown user',
    ])
  })

  it('never offers a merged group (the person grouping has none; a server one step ahead might)', () => {
    const answer = totalsAnswer([
      { kind: 'keyed', key: 'u-ada', label: 'Ada Lovelace', minutes: 120, status: 'active' },
      { kind: 'hidden', minutes: 60 },
      { kind: 'none', minutes: 30 },
    ])
    expect(personOptions(answer)).toEqual([{ id: 'u-ada', label: 'Ada Lovelace' }])
  })
})
