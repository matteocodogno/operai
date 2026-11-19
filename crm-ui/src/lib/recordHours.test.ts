/**
 * The "who" rule and the props of Record hours on the deal page (specs/20261116-record-hours-in-place
 * AC-2.1, AC-2.2; plan decisions 3 and 4, risk R10; ADR 20261116-record-hours-widget-through-the-host-extension-seam).
 * The rule decides only whether the button shows; hours-api decides every save.
 */
import { describe, expect, it } from 'vitest'
import { mayRecordOnDeal, mayRecordOnTask, recordHoursPropsOf, recordHoursPropsOfDeal } from './recordHours'
import type { Activity, ActivityTask, Deal, DealEstimate, PersonRef } from './types'

const person = (id: string, name = `Person ${id}`): PersonRef => ({ id, name, status: 'active' })

const estimate = (technical: PersonRef): DealEstimate => ({
  estimateId: 'e1',
  name: 'Estimate',
  technical,
  state: 'requested',
  requestedBy: person('u-requester'),
  requestedAt: '2026-11-01T10:00:00.000Z',
  readyAt: null,
})

const deal = (overrides: Partial<Deal> = {}): Deal => ({
  id: 'd1',
  title: 'Platform rebuild',
  company: { id: 'c1', name: 'Acme SA' },
  stage: 'proposal',
  entity: 'welld_ch',
  expectedCloseDate: null,
  owner: person('u-owner'),
  closedAt: null,
  updatedAt: '2026-11-01T10:00:00.000Z',
  version: 1,
  estimateState: null,
  estimateOverridden: false,
  lostReason: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  estimate: null,
  estimateOverride: null,
  ...overrides,
})

describe('mayRecordOnDeal (AC-2.1, AC-2.2)', () => {
  it('is true for the deal’s owner', () => {
    expect(mayRecordOnDeal(deal(), 'u-owner')).toBe(true)
  })

  it('is true for the technical contact of the deal’s estimate', () => {
    const withEstimate = deal({ estimate: estimate(person('u-tech')) })
    expect(mayRecordOnDeal(withEstimate, 'u-tech')).toBe(true)
  })

  it('is false for someone who can only read the deal', () => {
    const withEstimate = deal({ estimate: estimate(person('u-tech')) })
    expect(mayRecordOnDeal(withEstimate, 'u-reader')).toBe(false)
  })

  it('is false for the requester of the estimate, who is neither owner nor technical contact', () => {
    const withEstimate = deal({ estimate: estimate(person('u-tech')) })
    expect(mayRecordOnDeal(withEstimate, 'u-requester')).toBe(false)
  })

  it('is false for a task assignee on the deal who is neither: the deal object does not even carry them (AC-2.2)', () => {
    // A person involved only through one of the deal's activities records from that task's row, never the page.
    expect(mayRecordOnDeal(deal(), 'u-assignee')).toBe(false)
  })

  it('is false when the deal has no estimate and the person is not the owner (no technical contact to match)', () => {
    expect(mayRecordOnDeal(deal({ estimate: null }), 'u-tech')).toBe(false)
  })

  it('is false while the session has not given the person’s id yet', () => {
    const withEstimate = deal({ estimate: estimate(person('u-tech')) })
    expect(mayRecordOnDeal(withEstimate, null)).toBe(false)
    expect(mayRecordOnDeal(withEstimate, '')).toBe(false)
  })

  it('never matches a missing owner or technical id against a missing person', () => {
    // A defensive case: an id the server did not send must not equal "no id yet".
    const odd = deal({ owner: { id: '', name: null, status: 'unknown' } })
    expect(mayRecordOnDeal(odd, '')).toBe(false)
    expect(mayRecordOnDeal(odd, null)).toBe(false)
  })
})

describe('recordHoursPropsOfDeal (AC-2.1, plan R10)', () => {
  it('gives the deal as {on:deal, id, title} with no task and the page placement', () => {
    expect(recordHoursPropsOfDeal(deal({ id: 'd7', title: 'Alpenstrom portal' }))).toEqual({
      on: 'deal',
      targetId: 'd7',
      targetName: 'Alpenstrom portal',
      activityId: '',
      activityName: '',
      placement: 'page',
    })
  })

  it('takes the id and the title from the same deal, so the name shown is the id recorded on (R10)', () => {
    const first = deal({ id: 'd-first', title: 'First deal' })
    const second = deal({ id: 'd-second', title: 'Second deal' })
    for (const d of [first, second]) {
      const props = recordHoursPropsOfDeal(d)
      expect(props.targetId).toBe(d.id)
      expect(props.targetName).toBe(d.title)
    }
  })

  it('says "" for a deal whose title is empty, never an id (the widget words it "this deal")', () => {
    expect(recordHoursPropsOfDeal(deal({ id: 'd1', title: '' })).targetName).toBe('')
  })
})

const taskOf = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  dueDate: null,
  assignee: person('u-assignee'),
  completedAt: null,
  completedBy: null,
  ...overrides,
})

const activity = (overrides: Partial<Activity> = {}): Activity => ({
  id: 'a1',
  type: 'task',
  subject: 'Send the offer',
  body: null,
  occurredAt: '2026-11-03T09:30:00.000Z',
  company: { id: 'c1', name: 'Acme SA' },
  contact: null,
  deal: { id: 'd1', title: 'Platform rebuild' },
  author: person('u-author'),
  participants: [],
  task: taskOf(),
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
  ...overrides,
})

describe('mayRecordOnTask (AC-3.1, AC-3.6)', () => {
  it('is true for the task’s assignee', () => {
    expect(mayRecordOnTask(activity(), 'u-assignee')).toBe(true)
  })

  it('is true for a participant of the task', () => {
    const withParticipants = activity({ participants: [person('u-p1'), person('u-p2')] })
    expect(mayRecordOnTask(withParticipants, 'u-p2')).toBe(true)
  })

  it('is false for the author alone: writing a task does not put hours on it (AC-3.1)', () => {
    expect(mayRecordOnTask(activity(), 'u-author')).toBe(false)
  })

  it('is false for anyone else who can read the task, and for the author when the assignee is someone else', () => {
    const withParticipants = activity({ participants: [person('u-p1')] })
    expect(mayRecordOnTask(withParticipants, 'u-reader')).toBe(false)
    expect(mayRecordOnTask(withParticipants, 'u-author')).toBe(false)
  })

  it('is false for an unassigned task unless the person is a participant', () => {
    const unassigned = activity({ task: taskOf({ assignee: null }), participants: [person('u-p1')] })
    expect(mayRecordOnTask(unassigned, 'u-assignee')).toBe(false)
    expect(mayRecordOnTask(unassigned, 'u-p1')).toBe(true)
  })

  it('reads an older server that sends no participants as "none"', () => {
    const older = activity({ participants: undefined })
    expect('participants' in older && older.participants === undefined).toBe(true)
    expect(mayRecordOnTask(older, 'u-assignee')).toBe(true)
    expect(mayRecordOnTask(older, 'u-p1')).toBe(false)
  })

  it('answers the same for a done task as for an open one, in both directions (AC-3.6)', () => {
    const done = (overrides: Partial<Activity> = {}) =>
      activity({
        ...overrides,
        task: taskOf({ completedAt: '2026-11-10T10:00:00.000Z', completedBy: person('u-assignee') }),
      })
    const withParticipants = { participants: [person('u-p1')] }
    expect(mayRecordOnTask(done(), 'u-assignee')).toBe(true)
    expect(mayRecordOnTask(done(withParticipants), 'u-p1')).toBe(true)
    expect(mayRecordOnTask(done(), 'u-author')).toBe(false)
    expect(mayRecordOnTask(done(), 'u-reader')).toBe(false)
  })

  it('is false for an activity that is not a task, even for someone who took part in it', () => {
    const call = activity({ type: 'call', task: null, participants: [person('u-p1')] })
    expect(mayRecordOnTask(call, 'u-p1')).toBe(false)
    expect(mayRecordOnTask(call, 'u-author')).toBe(false)
    expect(mayRecordOnTask(call, 'u-assignee')).toBe(false)
  })

  it('is false while the session has not given the person’s id yet, whatever the task holds', () => {
    const odd = activity({
      task: taskOf({ assignee: { id: '', name: null, status: 'unknown' } }),
      participants: [{ id: '', name: null, status: 'unknown' }],
    })
    expect(mayRecordOnTask(odd, null)).toBe(false)
    expect(mayRecordOnTask(odd, '')).toBe(false)
    expect(mayRecordOnTask(activity(), null)).toBe(false)
  })
})

describe('recordHoursPropsOf (AC-3.3, AC-3.4, AC-3.5, plan R10, G3)', () => {
  it('gives a task about a deal as {on:deal, the deal, the task} on a row (AC-3.3)', () => {
    const task = activity({ id: 't9', subject: 'Write the offer', deal: { id: 'd7', title: 'Alpenstrom portal' } })
    expect(recordHoursPropsOf(task)).toEqual({
      on: 'deal',
      targetId: 'd7',
      targetName: 'Alpenstrom portal',
      activityId: 't9',
      activityName: 'Write the offer',
      placement: 'row',
    })
  })

  it('gives a task about a company and no deal as other work: no ids, the subject only to name the button (AC-3.4, G3)', () => {
    const task = activity({ id: 't9', subject: 'Call the CFO', deal: null, contact: { id: 'k1', name: 'Bea Meier' } })
    expect(recordHoursPropsOf(task)).toEqual({
      on: 'none',
      targetId: '',
      targetName: '',
      activityId: '',
      activityName: 'Call the CFO',
      placement: 'row',
    })
  })

  it('carries no link to the company or the contact: a deal-less task records on other work (AC-3.5)', () => {
    const props = recordHoursPropsOf(activity({ deal: null, company: { id: 'c-secret', name: 'Secret SA' } }))
    expect(JSON.stringify(props)).not.toContain('c-secret')
    expect(JSON.stringify(props)).not.toContain('Secret SA')
  })

  it('takes the deal’s id and title from the same deal and the task’s id and subject from the same task (R10)', () => {
    const tasks = [
      activity({ id: 't1', subject: 'First task', deal: { id: 'd-first', title: 'First deal' } }),
      activity({ id: 't2', subject: 'Second task', deal: { id: 'd-second', title: 'Second deal' } }),
    ]
    for (const task of tasks) {
      const props = recordHoursPropsOf(task)
      expect(props).toMatchObject({
        targetId: task.deal!.id,
        targetName: task.deal!.title,
        activityId: task.id,
        activityName: task.subject,
      })
    }
  })

  it('says "" for a deal with no title, never an id (the widget words it "this deal")', () => {
    const task = activity({ deal: { id: 'd1', title: null as unknown as string } })
    expect(recordHoursPropsOf(task)?.targetName).toBe('')
  })

  it('is the same for a done task as for an open one (AC-3.6)', () => {
    const open = activity({ deal: { id: 'd7', title: 'Alpenstrom portal' } })
    const done = activity({
      deal: { id: 'd7', title: 'Alpenstrom portal' },
      task: taskOf({ completedAt: '2026-11-10T10:00:00.000Z' }),
    })
    expect(recordHoursPropsOf(done)).toEqual(recordHoursPropsOf(open))
    expect(recordHoursPropsOf({ ...done, deal: null })).toEqual(recordHoursPropsOf({ ...open, deal: null }))
  })

  it('gives nothing for an activity that is not a task: there are no hours to record on a call', () => {
    expect(recordHoursPropsOf(activity({ type: 'call', task: null }))).toBeNull()
  })
})
