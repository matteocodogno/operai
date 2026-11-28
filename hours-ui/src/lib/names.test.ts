/**
 * names — what the screen says about a name it may or may not show (specs/20261112-time-tracking T25; AC-4.10,
 * AC-4.7, AC-2.6, AC-2.9; design S1 "Names the viewer cannot read"). The rule under every case: a name is
 * shown only for `visibility: "visible"`, a placeholder from the catalog stands in otherwise, and the
 * placeholder never carries the server's label or an id — even when the server (wrongly) sent one.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView, totalsAnswer } from '../test-support/fakeApi'
import type { MeetingDeal, MeetingProject, TimeEntryView } from './hoursApi.types'
import {
  activityLine,
  countsForDealLine,
  countsForProjectLine,
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

  it('a deal that could not be read at all is "unknown right now", said for the deal or the project (one line for both)', () => {
    expect(countsForDealLine(meetingWith({ state: 'unknown' }))).toBe(n.countsForUnknownDeal)
    expect(n.countsForUnknownDeal).toBe('The deal or project these hours count for is unknown right now')
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

describe('countsForProjectLine: the project a meeting’s hours count for (specs/20261112-project-hours AC-4.4, AC-4.7)', () => {
  const meetingFor = (project: MeetingProject) => ({ ...meetingOn('m1', 'Kick-off call'), project })

  it('a linked, visible project is named', () => {
    const line = countsForProjectLine(
      meetingFor({ state: 'linked', visibility: 'visible', id: 'p1', label: 'Project Alpha', href: '/projects/p1' }),
    )
    expect(line).toBe(n.countsForProject('Project Alpha'))
    expect(line).toBe('Counts for project Project Alpha')
  })

  it('a linked project the viewer cannot read, or whose name did not come, is the design’s words', () => {
    expect(countsForProjectLine(meetingFor({ state: 'linked', visibility: 'hidden' }))).toBe(n.countsForHiddenProject)
    expect(countsForProjectLine(meetingFor({ state: 'linked', visibility: 'unavailable' }))).toBe(
      n.countsForUnavailableProject,
    )
    expect(n.countsForHiddenProject).toBe('Counts for a project that is not visible to you')
    expect(n.countsForUnavailableProject).toBe('Counts for a project whose name is unavailable')
  })

  it('a readable project that came without a label is "name unavailable", never named by its id', () => {
    const noLabel = { state: 'linked', visibility: 'visible', id: 'p-secret-id', label: null, href: '/projects/p1' }
    const line = countsForProjectLine(meetingFor(noLabel as unknown as MeetingProject))
    expect(line).toBe(n.countsForUnavailableProject)
    expect(line).not.toContain('p-secret-id')
  })

  it('says nothing for a project that could not be read: the deal’s unknown line speaks for both', () => {
    expect(countsForProjectLine(meetingFor({ state: 'unknown' }))).toBeNull()
    expect(countsForDealLine({ ...meetingFor({ state: 'unknown' }), deal: { state: 'unknown' } })).toBe(
      n.countsForUnknownDeal,
    )
  })

  it('says nothing for a meeting linked to no project, nor for one from an hours-api that sends no `project`', () => {
    expect(countsForProjectLine(meetingFor({ state: 'none' }))).toBeNull()
    expect(countsForProjectLine(meetingOn('m1', 'Kick-off call'))).toBeNull()
  })

  it('says nothing for the other kinds, a project entry included (its name is the row’s own)', () => {
    expect(countsForProjectLine(projectOn('p1'))).toBeNull()
    expect(countsForProjectLine(dealOn('d1'))).toBeNull()
    expect(countsForProjectLine(otherWorkOn('Formazione'))).toBeNull()
  })

  it('never writes a name or an id the server sent for a project that is not visible', () => {
    for (const visibility of ['hidden', 'unavailable'] as const) {
      const leaked = { state: 'linked', visibility, id: 'p-secret', label: 'Leaked project' } as MeetingProject
      const line = countsForProjectLine(meetingFor(leaked))
      expect(line).not.toContain('Leaked')
      expect(line).not.toContain('p-secret')
      expect(line).toBe(visibility === 'hidden' ? n.countsForHiddenProject : n.countsForUnavailableProject)
    }
  })

  it('a meeting has one host: a meeting linked to a project says nothing about a deal', () => {
    const on = {
      ...meetingOn('m1', 'Kick-off call', { state: 'none' }),
      project: { state: 'linked', visibility: 'hidden' } as const,
    }
    expect(countsForDealLine(on)).toBeNull()
    expect(countsForProjectLine(on)).toBe(n.countsForHiddenProject)
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
    [
      'a meeting whose project is hidden',
      timeEntryView({ on: { ...meetingOn('m1', 'Kick-off'), project: { state: 'linked', visibility: 'hidden' } } }),
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

  it.each<[string, MeetingProject | undefined]>([
    [
      'linked to a project the viewer can read',
      { state: 'linked', visibility: 'visible', id: 'p1', label: 'Alpha', href: '/projects/p1' },
    ],
    ['whose project’s name is unavailable', { state: 'linked', visibility: 'unavailable' }],
    ['linked to no project', { state: 'none' }],
    ['whose project is unknown', { state: 'unknown' }],
    ['from an hours-api that sends no `project`', undefined],
  ])('a meeting %s is not a hidden name', (_what, project) => {
    const on = project === undefined ? meetingOn('m1', 'Kick-off') : { ...meetingOn('m1', 'Kick-off'), project }
    expect(hasHiddenName([timeEntryView({ on })])).toBe(false)
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

  it('knows meeting-projects, which comes with meeting-deals from the one read of the meetings’ hosts', () => {
    expect(unavailableSources(['meeting-projects'])).toEqual(['meeting-projects'])
    expect(unavailableSources(['meeting-projects', 'projects'])).toEqual(['projects', 'meeting-projects'])
  })

  it('names the pair once: the two codes say one thing, so the banner never repeats the phrase', () => {
    expect(n.sources['meeting-projects']).toBe(n.sources['meeting-deals'])
    expect(unavailableSources(['meeting-deals', 'meeting-projects', 'identities'])).toEqual([
      'identities',
      'meeting-deals',
    ])
    expect(unavailableSources(['meeting-projects'], ['meeting-deals'])).toEqual(['meeting-deals'])
  })
})
