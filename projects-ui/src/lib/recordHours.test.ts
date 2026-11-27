/**
 * The "who" rule and the props of Record hours on the project page and on a task's row (specs/20261116-record-hours-in-place
 * AC-1.1, AC-1.2, AC-3.1 – AC-3.4, AC-3.6, plan decision 3 and risk R10): whether the page or the row offers the
 * button is decided here, from what it already holds and the signed-in person's id, and only as a convenience —
 * hours-api decides every save (ADR 20261116-record-hours-widget-through-the-host-extension-seam).
 */
import { describe, expect, it } from 'vitest'
import { ADA, projectDetail } from '../test-support/fakeApi'
import type { MyTask, PersonRef, PreSalesTask, ProjectTask, TaskDetails } from './activitiesApi'
import type { Person } from './types'
import { MY_HOURS_HREF, mayRecordOnProject, mayRecordOnTask, peopleOnProject, recordHoursPropsOf } from './recordHours'

const BOB: Person = { id: 'u-bob', name: 'Bob Builder', deleted: false }
const CARA: Person = { id: 'u-cara', name: 'Cara Coder', deleted: false }

const ref = (id: string, status: PersonRef['status'] = 'active'): PersonRef => ({ id, name: id, status })

/** A task as an older server sends it, without one optional member. */
const without = (task: MyTask, key: 'deal' | 'participants'): MyTask => {
  const copy: Record<string, unknown> = { ...task }
  delete copy[key]
  return copy as MyTask
}

/** One project task as activities-api sends it: written by `u-author`, assigned to `u-assignee`, nobody else on it. */
const operational = (over: Partial<ProjectTask> = {}, details: Partial<TaskDetails> = {}): ProjectTask => ({
  id: 't-1',
  kind: 'operational',
  type: 'task',
  subject: 'Write the offer',
  body: null,
  occurredAt: '2026-11-01T09:00:00.000Z',
  project: { id: 'p-1', name: 'Intranet' },
  author: ref('u-author'),
  participants: [],
  task: { dueDate: null, assignee: ref('u-assignee'), completedAt: null, completedBy: null, ...details },
  may: { edit: true, delete: true, complete: true },
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  ...over,
})

/** One pre-sales task as My tasks lists it: a CRM company, a deal. */
const preSales = (over: Partial<PreSalesTask> = {}, details: Partial<TaskDetails> = {}): PreSalesTask => ({
  ...operational({}, details),
  kind: 'pre_sales',
  project: null,
  company: { id: 'c-9', name: 'Globex AG' },
  deal: { id: 'd-1', title: 'Website' },
  ...over,
})

describe('mayRecordOnProject (AC-1.1, AC-1.2)', () => {
  it('is true for the project manager', () => {
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [BOB] }), ADA.id)).toBe(true)
  })

  it('is true for a member of the team', () => {
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [BOB, CARA] }), CARA.id)).toBe(true)
  })

  it('is false for anyone else who can read the project', () => {
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [BOB] }), 'u-reader')).toBe(false)
  })

  it('is false for a person who is on the project only by an id that looks like a name', () => {
    // Ids are compared whole: a prefix, a name or a different case is somebody else.
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [] }), 'u-ad')).toBe(false)
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [] }), 'U-ADA')).toBe(false)
  })

  it('is false for everyone but the team while the project awaits its project manager (`projectManager: null`)', () => {
    const awaiting = projectDetail({ projectManager: null, awaitingProjectManager: true, team: [BOB] })
    expect(mayRecordOnProject(awaiting, 'u-reader')).toBe(false)
    expect(mayRecordOnProject(awaiting, BOB.id)).toBe(true)
  })

  it('is false while the session has not given the person yet (`me: null`), whoever is on the project', () => {
    expect(mayRecordOnProject(projectDetail({ projectManager: ADA, team: [BOB] }), null)).toBe(false)
    expect(mayRecordOnProject(projectDetail({ projectManager: null, team: [] }), null)).toBe(false)
  })

  it('does not depend on the project’s state: a closed or cancelled project still offers it (A5)', () => {
    for (const state of ['planned', 'active', 'on_hold', 'closed', 'cancelled'] as const) {
      expect(mayRecordOnProject(projectDetail({ state, team: [BOB] }), BOB.id), state).toBe(true)
    }
  })
})

describe('mayRecordOnProject reads project.onProject (teams AC-5.1, AC-5.4, D4)', () => {
  it('is true for a person on the project only through a team: they are in onProject, not in team', () => {
    const project = projectDetail({ projectManager: ADA, team: [], onProject: [ADA, CARA], onProjectComplete: true })
    expect(mayRecordOnProject(project, CARA.id)).toBe(true)
  })

  it('follows the server: a listed member the answer leaves out is not offered', () => {
    const project = projectDetail({ projectManager: ADA, team: [BOB], onProject: [ADA], onProjectComplete: true })
    expect(mayRecordOnProject(project, BOB.id)).toBe(false)
  })

  it('while the teams are not loaded, onProject is the known part: the manager and the listed people still record', () => {
    const project = projectDetail({ projectManager: ADA, team: [BOB], onProject: [ADA, BOB], onProjectComplete: false })
    expect(mayRecordOnProject(project, ADA.id)).toBe(true)
    expect(mayRecordOnProject(project, BOB.id)).toBe(true)
    expect(mayRecordOnProject(project, CARA.id)).toBe(false)
  })

  it('R6: against a projects-api without onProject it falls back to the manager and the listed team', () => {
    const project = projectDetail({ projectManager: ADA, team: [BOB] })
    expect('onProject' in project).toBe(false)
    expect(peopleOnProject(project).map((person) => person.id)).toEqual([ADA.id, BOB.id])
    expect(mayRecordOnProject(project, ADA.id)).toBe(true)
    expect(mayRecordOnProject(project, BOB.id)).toBe(true)
    expect(mayRecordOnProject(project, CARA.id)).toBe(false)
  })

  it('the fallback leaves out an absent manager and counts each person once', () => {
    const project = projectDetail({ projectManager: null, team: [BOB, BOB] })
    expect(peopleOnProject(project).map((person) => person.id)).toEqual([BOB.id])
  })

  it('an empty onProject is an answer, not an absence: nobody is on the project', () => {
    const project = projectDetail({ projectManager: ADA, team: [BOB], onProject: [] })
    expect(mayRecordOnProject(project, ADA.id)).toBe(false)
  })
})

describe('recordHoursPropsOf(project) (AC-1.1, R10)', () => {
  it('is the six plain strings of the extension, on the project, with no task and the page placement', () => {
    expect(recordHoursPropsOf(projectDetail({ id: 'p-9', name: 'Alpenstrom — portale clienti' }))).toEqual({
      on: 'project',
      targetId: 'p-9',
      targetName: 'Alpenstrom — portale clienti',
      activityId: '',
      activityName: '',
      placement: 'page',
    })
  })

  it('takes the id and the name from the one project it is given, never from two sources (R10)', () => {
    const first = projectDetail({ id: 'p-1', name: 'First' })
    const second = projectDetail({ id: 'p-2', name: 'Second' })
    const a = recordHoursPropsOf(first)
    const b = recordHoursPropsOf(second)
    expect([a.targetId, a.targetName]).toEqual(['p-1', 'First'])
    expect([b.targetId, b.targetName]).toEqual(['p-2', 'Second'])
  })
})

describe('recordHoursPropsOf(task) (AC-3.2, AC-3.3, AC-3.4, G3, R10)', () => {
  it('an operational task records on its project and on the task (AC-3.2)', () => {
    expect(recordHoursPropsOf(operational({ id: 't-7', subject: 'Write the offer' }))).toEqual({
      on: 'project',
      targetId: 'p-1',
      targetName: 'Intranet',
      activityId: 't-7',
      activityName: 'Write the offer',
      placement: 'row',
    })
  })

  it('a pre-sales task with a deal records on the deal and on the task (AC-3.3)', () => {
    expect(recordHoursPropsOf(preSales({ id: 't-8', subject: 'Send the quote' }))).toEqual({
      on: 'deal',
      targetId: 'd-1',
      targetName: 'Website',
      activityId: 't-8',
      activityName: 'Send the quote',
      placement: 'row',
    })
  })

  it('a pre-sales task with no deal records as other work: no ids, no name, the subject only names the button (AC-3.4, G3)', () => {
    const expected = {
      on: 'none',
      targetId: '',
      targetName: '',
      activityId: '',
      activityName: 'Call Globex back',
      placement: 'row',
    }
    expect(recordHoursPropsOf(preSales({ subject: 'Call Globex back', deal: null }))).toEqual(expected)
    // An older server that sends no `deal` at all says the same thing.
    expect(recordHoursPropsOf(without(preSales({ subject: 'Call Globex back' }), 'deal'))).toEqual(expected)
  })

  it('a deal-less task carries nothing of its company or of the task itself (AC-3.5: no link to either)', () => {
    const props = recordHoursPropsOf(
      preSales({ id: 't-9', deal: null, company: { id: 'c-secret', name: 'Globex AG' } }),
    )
    expect(JSON.stringify(props)).not.toContain('c-secret')
    expect(JSON.stringify(props)).not.toContain('Globex AG')
    expect(JSON.stringify(props)).not.toContain('t-9')
  })

  it('a project or a deal the server could not name still records, and the widget says "this project" / "this deal"', () => {
    expect(recordHoursPropsOf(operational({ project: { id: 'p-1', name: null } }))).toMatchObject({
      on: 'project',
      targetId: 'p-1',
      targetName: '',
    })
    expect(recordHoursPropsOf(preSales({ deal: { id: 'd-1', title: null } }))).toMatchObject({
      on: 'deal',
      targetId: 'd-1',
      targetName: '',
    })
  })

  it('takes the id and the name from the one project or deal the task is about, never from two sources (R10)', () => {
    const a = recordHoursPropsOf(operational({ project: { id: 'p-1', name: 'First' } }))
    const b = recordHoursPropsOf(operational({ project: { id: 'p-2', name: 'Second' } }))
    expect([a?.targetId, a?.targetName]).toEqual(['p-1', 'First'])
    expect([b?.targetId, b?.targetName]).toEqual(['p-2', 'Second'])
    // A pre-sales task also names a company: it never becomes the deal's name.
    expect(
      recordHoursPropsOf(preSales({ company: { id: 'c-1', name: 'Globex AG' }, deal: { id: 'd-5', title: 'Portal' } })),
    ).toMatchObject({ targetId: 'd-5', targetName: 'Portal' })
  })

  it('is the same for a done task as for an open one (AC-3.6)', () => {
    const done = { completedAt: '2026-11-05T10:00:00.000Z', completedBy: ref('u-assignee') }
    expect(recordHoursPropsOf(operational({}, done))).toEqual(recordHoursPropsOf(operational()))
    expect(recordHoursPropsOf(preSales({}, done))).toEqual(recordHoursPropsOf(preSales()))
    expect(recordHoursPropsOf(preSales({ deal: null }, done))).toEqual(recordHoursPropsOf(preSales({ deal: null })))
  })

  it('is always the six plain strings of the extension and nothing else', () => {
    for (const task of [operational(), preSales(), preSales({ deal: null })]) {
      const props = recordHoursPropsOf(task)!
      expect(Object.keys(props).sort()).toEqual(
        ['activityId', 'activityName', 'on', 'placement', 'targetId', 'targetName'].sort(),
      )
      for (const value of Object.values(props)) expect(typeof value).toBe('string')
    }
  })

  it('offers no target for a task that names none the widget could record on: `null`, never "record on nothing"', () => {
    // The widget throws on `on: "project"` with no id; the row shows no button instead.
    expect(recordHoursPropsOf(operational({ project: null }))).toBeNull()
    expect(recordHoursPropsOf(operational({ project: { id: '', name: 'Ghost' } }))).toBeNull()
    // A deal with no id is no deal: the task is other work, as if it had none.
    expect(recordHoursPropsOf(preSales({ deal: { id: '', title: 'Ghost' } }))).toMatchObject({
      on: 'none',
      targetId: '',
    })
  })
})

describe('the fallback link', () => {
  it('is a fixed path to My hours in the shell, outside this remote’s basepath', () => {
    expect(MY_HOURS_HREF).toBe('/hours')
  })
})

describe('mayRecordOnTask (AC-3.1, AC-3.6)', () => {
  it('is true for the task’s assignee, whichever kind of task it is', () => {
    expect(mayRecordOnTask(operational(), 'u-assignee')).toBe(true)
    expect(mayRecordOnTask(preSales(), 'u-assignee')).toBe(true)
  })

  it('is true for a participant', () => {
    const task = operational({ participants: [ref('u-pat'), ref('u-quinn')] })
    expect(mayRecordOnTask(task, 'u-pat')).toBe(true)
    expect(mayRecordOnTask(task, 'u-quinn')).toBe(true)
    expect(mayRecordOnTask(preSales({ participants: [ref('u-pat')] }), 'u-pat')).toBe(true)
  })

  it('is true for a participant of a task nobody is assigned to', () => {
    expect(mayRecordOnTask(operational({ participants: [ref('u-pat')] }, { assignee: null }), 'u-pat')).toBe(true)
  })

  it('is false for the author alone, and for anyone else', () => {
    const task = operational({ participants: [ref('u-pat')] })
    expect(mayRecordOnTask(task, 'u-author')).toBe(false)
    expect(mayRecordOnTask(task, 'u-someone-else')).toBe(false)
    expect(mayRecordOnTask(preSales(), 'u-author')).toBe(false)
  })

  it('compares ids whole: a prefix, a name or a different case is somebody else', () => {
    const task = operational({ participants: [ref('u-pat')] })
    expect(mayRecordOnTask(task, 'u-assign')).toBe(false)
    expect(mayRecordOnTask(task, 'U-ASSIGNEE')).toBe(false)
    expect(mayRecordOnTask(task, 'u-pa')).toBe(false)
  })

  it('is false while the session has not given the person yet, even for a task nobody is assigned to', () => {
    // An absent id never matches an absent assignee: `null` is "not known", not "nobody".
    expect(mayRecordOnTask(operational({ participants: [ref('u-pat')] }), null)).toBe(false)
    expect(mayRecordOnTask(operational({}, { assignee: null }), null)).toBe(false)
    expect(mayRecordOnTask(operational({}, { assignee: null }), '')).toBe(false)
  })

  it('never lets an answer with a blank person id match a person who is not known yet', () => {
    // Malformed answers (an id the server failed to fill): blank equals blank, which is not somebody.
    const blank = operational({ participants: [ref('')] }, { assignee: ref('') })
    expect(mayRecordOnTask(blank, '')).toBe(false)
    const nulled = operational({ participants: [ref(null as unknown as string)] }, { assignee: ref(null as never) })
    expect(mayRecordOnTask(nulled, null)).toBe(false)
  })

  it('does not fail on a task an older server sent without `participants`', () => {
    const withoutParticipants = without(operational(), 'participants')
    expect(mayRecordOnTask(withoutParticipants, 'u-pat')).toBe(false)
    expect(mayRecordOnTask(withoutParticipants, 'u-assignee')).toBe(true)
  })

  it('answers the same for a done task as for an open one (AC-3.6)', () => {
    const done = { completedAt: '2026-11-05T10:00:00.000Z', completedBy: ref('u-assignee') }
    const task = operational({ participants: [ref('u-pat')] }, done)
    expect(mayRecordOnTask(task, 'u-assignee')).toBe(true)
    expect(mayRecordOnTask(task, 'u-pat')).toBe(true)
    expect(mayRecordOnTask(task, 'u-author')).toBe(false)
    expect(mayRecordOnTask(task, 'u-someone-else')).toBe(false)
  })

  it('does not depend on what the server says the person may do with the task', () => {
    const none = { edit: false, delete: false, complete: false }
    expect(mayRecordOnTask(operational({ may: none }), 'u-assignee')).toBe(true)
  })
})
