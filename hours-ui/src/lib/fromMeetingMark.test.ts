/**
 * showsFromMeetingMark — the one rule of the "From meeting" mark (specs/20261112-meeting-hours AC-2.3 as changed, D67, A47;
 * plan § hours-ui — changed, D-P5; design S1). An automatic entry is marked exactly while it is recorded on a meeting: its
 * own, another one, or one since deleted (`on.type` stays `meeting`). Not the delete sentence's rule, which reads `origin`
 * alone (AC-2.7, D70) and is `DeleteEntryDialog.test.tsx`'s.
 */
import { describe, expect, it } from 'vitest'
import type { TimeEntryView } from './hoursApi.types'
import { showsFromMeetingMark } from './fromMeetingMark'
import { dealOn, meetingOn, otherWorkOn, projectOn } from '../test-support/fakeApi'

type Marked = Pick<TimeEntryView, 'origin' | 'on'>

describe('showsFromMeetingMark: origin meeting AND recorded on a meeting (AC-2.3, D67)', () => {
  it.each<[string, Marked, boolean]>([
    ['an automatic entry on its meeting', { origin: 'meeting', on: meetingOn('m1', 'Weekly sync') }, true],
    [
      'one moved to another meeting (A47: it is on a meeting)',
      { origin: 'meeting', on: meetingOn('m2', 'Retro') },
      true,
    ],
    [
      'one whose meeting the viewer cannot read (a deleted one included): `on.type` stays meeting',
      { origin: 'meeting', on: meetingOn('m1', null, { state: 'none' }, 'hidden') },
      true,
    ],
    [
      'one whose meeting Meetings did not answer for',
      { origin: 'meeting', on: meetingOn('m1', null, { state: 'none' }, 'unavailable') },
      true,
    ],
    ['one moved to a project', { origin: 'meeting', on: projectOn('p1', 'Project Alpha') }, false],
    ['one moved to a deal', { origin: 'meeting', on: dealOn('d1', 'Brera') }, false],
    ['one moved to other work', { origin: 'meeting', on: otherWorkOn('Training') }, false],
    ['an entry typed by hand, on a meeting', { origin: 'person', on: meetingOn('m1', 'Weekly sync') }, false],
    ['an entry typed by hand, on a project', { origin: 'person', on: projectOn('p1', 'Project Alpha') }, false],
    ['an entry from an hours-api that sends no origin, on a meeting', { on: meetingOn('m1', 'Weekly sync') }, false],
  ])('%s', (_name, entry, expected) => {
    expect(showsFromMeetingMark(entry)).toBe(expected)
  })

  it('is false when `on` is missing, whatever the origin: a malformed view draws no mark and does not throw', () => {
    expect(showsFromMeetingMark({ origin: 'meeting' } as unknown as Marked)).toBe(false)
    expect(showsFromMeetingMark({ origin: 'person' } as unknown as Marked)).toBe(false)
    expect(showsFromMeetingMark({} as unknown as Marked)).toBe(false)
  })

  it('is the same answer after a move off a meeting and back onto one: the rule reads the current target, not a history', () => {
    const onMeeting: Marked = { origin: 'meeting', on: meetingOn('m1', 'Weekly sync') }
    const onProject: Marked = { ...onMeeting, on: projectOn('p1', 'Project Alpha') }
    expect([onMeeting, onProject, onMeeting].map(showsFromMeetingMark)).toEqual([true, false, true])
  })
})
