/**
 * names — what the screen says about a name it may or may not show (specs/029-time-tracking T25; AC-4.10,
 * AC-4.7, AC-2.6, AC-2.9; design S1 "Names the viewer cannot read"). The rule under every case: a name is
 * shown only for `visibility: "visible"`, a placeholder from the catalog stands in otherwise, and the
 * placeholder never carries the server's label or an id — even when the server (wrongly) sent one.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView, totalsAnswer } from '../test-support/fakeApi'
import type { MeetingDeal, TimeEntryView } from './hoursApi.types'
import {
  activityLine,
  countsForDealLine,
  hasHiddenName,
  onPhrase,
  rowName,
  suitePath,
  unavailableSources,
} from './names'

const n = strings.names
const e = strings.entries

describe('suitePath: only a path inside the suite is ever a link', () => {
  it.each(['/projects/p1', '/crm/deals/d1', '/my-meetings/m/m1'])('keeps %s', (path) => {
    expect(suitePath(path)).toBe(path)
  })

  it.each([
    ['javascript:alert(1)'],
    ['https://elsewhere.example/projects/p1'],
    ['//elsewhere.example/projects/p1'],
    ['/\\elsewhere.example'],
    ['projects/p1'],
    [''],
  ])('refuses %s', (href) => {
    expect(suitePath(href)).toBeNull()
  })

  it('has no link for null or undefined', () => {
    expect(suitePath(null)).toBeNull()
    expect(suitePath(undefined)).toBeNull()
  })
})

describe('rowName: the name on a row (AC-4.10, AC-4.7)', () => {
  it('a visible project, deal or meeting is its label with the API’s link', () => {
    expect(rowName(projectOn('p1', 'Project Alpha'))).toEqual({ text: 'Project Alpha', href: '/projects/p1' })
    expect(rowName(dealOn('d1', 'Acme renewal'))).toEqual({ text: 'Acme renewal', href: '/crm/deals/d1' })
    expect(rowName(meetingOn('m1', 'Kick-off call'))).toEqual({ text: 'Kick-off call', href: '/my-meetings/m/m1' })
  })

  it('a hidden one is "Not visible to you" with no link, and never the label the server may have sent', () => {
    const leaked = { ...projectOn('p9', 'Secret project', 'hidden'), label: 'Secret project', href: '/projects/p9' }
    expect(rowName(leaked)).toEqual({ text: n.hidden, href: null })
  })

  it('an unavailable one is "Name unavailable" with no link', () => {
    const leaked = { ...dealOn('d9', 'Leaked', 'unavailable'), label: 'Leaked', href: '/crm/deals/d9' }
    expect(rowName(leaked)).toEqual({ text: n.unavailable, href: null })
  })

  it('a visible one with no label is "Name unavailable", never an id, and is not a link to nothing', () => {
    const noLabel = { ...projectOn('p-secret-id', 'x'), label: null }
    const shown = rowName(noLabel)
    expect(shown?.text).toBe(n.unavailable)
    expect(shown?.text).not.toContain('p-secret-id')
  })

  it('a visible one whose link is not a suite path shows the name as plain text', () => {
    expect(rowName({ ...projectOn('p1', 'Project Alpha'), href: 'javascript:alert(1)' })).toEqual({
      text: 'Project Alpha',
      href: null,
    })
  })

  it('other work has no name: its category is the details line', () => {
    expect(rowName(otherWorkOn('Formazione'))).toBeNull()
  })
})

describe('countsForDealLine: the deal a meeting’s hours count for (AC-2.6, AC-4.10, AC-4.7)', () => {
  const meetingWith = (deal: MeetingDeal) => meetingOn('m1', 'Kick-off call', deal)

  it('a linked, visible deal is named', () => {
    const line = countsForDealLine(
      meetingWith({ state: 'linked', visibility: 'visible', id: 'd1', label: 'Acme renewal', href: '/crm/deals/d1' }),
    )
    expect(line).toBe(n.countsForDeal('Acme renewal'))
    expect(line).toBe('Counts for deal Acme renewal')
  })

  it('a linked deal the viewer cannot read, or whose name did not come, is the design’s words', () => {
    expect(countsForDealLine(meetingWith({ state: 'linked', visibility: 'hidden' }))).toBe(n.countsForHiddenDeal)
    expect(countsForDealLine(meetingWith({ state: 'linked', visibility: 'unavailable' }))).toBe(
      n.countsForUnavailableDeal,
    )
  })

  it('a deal that could not be read at all is "unknown right now"', () => {
    expect(countsForDealLine(meetingWith({ state: 'unknown' }))).toBe(n.countsForUnknownDeal)
  })

  it('a meeting linked to no deal says nothing, and neither do the other kinds', () => {
    expect(countsForDealLine(meetingWith({ state: 'none' }))).toBeNull()
    expect(countsForDealLine(projectOn('p1'))).toBeNull()
    expect(countsForDealLine(dealOn('d1'))).toBeNull()
    expect(countsForDealLine(otherWorkOn('Formazione'))).toBeNull()
  })

  it('never writes a name the server sent for a deal that is not visible', () => {
    const leaked = { state: 'linked', visibility: 'hidden', id: 'd-secret', label: 'Leaked deal' } as MeetingDeal
    const line = countsForDealLine(meetingWith(leaked))
    expect(line).toBe(n.countsForHiddenDeal)
    expect(line).not.toContain('Leaked')
    expect(line).not.toContain('d-secret')
  })
})

describe('activityLine: the activity an entry points at (AC-2.7, AC-2.9, AC-4.10)', () => {
  it('none, or deleted since, has no line', () => {
    expect(activityLine(null)).toBeNull()
  })

  it('a visible activity is its subject', () => {
    expect(activityLine({ id: 'a1', subject: 'Write the offer', visibility: 'visible' })).toBe(
      'Activity: Write the offer',
    )
  })

  it('a hidden one, or one whose subject did not come, is the design’s words, never the subject or the id', () => {
    expect(activityLine({ id: 'a-secret', subject: 'Leaked subject', visibility: 'hidden' })).toBe(n.activityHidden)
    expect(activityLine({ id: 'a-secret', subject: null, visibility: 'unavailable' })).toBe(n.activityUnavailable)
    expect(activityLine({ id: 'a-secret', subject: null, visibility: 'visible' })).toBe(n.activityUnavailable)
  })
})

describe('onPhrase: how an entry is named in a button’s label', () => {
  it('is the label for a visible name', () => {
    expect(onPhrase(projectOn('p1', 'Project Alpha'))).toBe('Project Alpha')
  })

  it('names the kind and the reason when the name is withheld, so two hidden rows are told apart only by position', () => {
    expect(onPhrase(projectOn('p1', 'x', 'hidden'))).toBe(e.onPhrase.project.hidden)
    expect(onPhrase(dealOn('d1', 'x', 'unavailable'))).toBe(e.onPhrase.deal.unavailable)
    expect(onPhrase(meetingOn('m1', 'x', { state: 'none' }, 'hidden'))).toBe(e.onPhrase.meeting.hidden)
  })

  it('is the category for other work', () => {
    expect(onPhrase(otherWorkOn('Formazione'))).toBe(e.onPhrase.none('Formazione'))
  })
})

describe('hasHiddenName: when the "names not visible" note shows (AC-4.10)', () => {
  const plain = timeEntryView()

  it('is false for nothing hidden', () => {
    expect(hasHiddenName([plain])).toBe(false)
    expect(hasHiddenName([plain], totalsAnswer([{ kind: 'keyed', key: 'p1', label: 'Alpha', minutes: 120 }]))).toBe(
      false,
    )
  })

  it.each<[string, TimeEntryView]>([
    ['a hidden project', timeEntryView({ on: projectOn('p1', 'x', 'hidden') })],
    ['a hidden deal', timeEntryView({ on: dealOn('d1', 'x', 'hidden') })],
    ['a hidden meeting', timeEntryView({ on: meetingOn('m1', 'x', { state: 'none' }, 'hidden') })],
    [
      'a meeting whose deal is hidden',
      timeEntryView({ on: meetingOn('m1', 'Kick-off', { state: 'linked', visibility: 'hidden' }) }),
    ],
    ['a hidden activity', timeEntryView({ activity: { id: 'a1', subject: null, visibility: 'hidden' } })],
  ])('is true for %s', (_name, entry) => {
    expect(hasHiddenName([plain, entry])).toBe(true)
  })

  it('is true for a hidden group of the totals, whatever the entries say', () => {
    expect(hasHiddenName([plain], totalsAnswer([{ kind: 'hidden', minutes: 60 }]))).toBe(true)
  })

  it('an unavailable name is not a hidden one (that is the other banner)', () => {
    const unavailable = timeEntryView({ on: projectOn('p1', 'x', 'unavailable') })
    expect(hasHiddenName([unavailable], totalsAnswer([{ kind: 'unavailable', minutes: 60 }]))).toBe(false)
  })
})

describe('unavailableSources: the sources the banner names', () => {
  it('is empty when every read answered', () => {
    expect(unavailableSources([], [], undefined)).toEqual([])
  })

  it('is the union of the reads, each once, in the catalog’s fixed order', () => {
    expect(unavailableSources(['meeting-deals', 'projects'], ['projects', 'identities'], ['crm'])).toEqual([
      'identities',
      'projects',
      'crm',
      'meeting-deals',
    ])
  })
})
