/**
 * What the Record hours button takes in and what it opens the dialog on (specs/20261116-record-hours-in-place T2; plan §
 * API contracts "`hours/RecordHours`", "valid sets", R10; AC-1.3, AC-2.3, AC-3.2–3.5): six plain strings from a
 * host, a refusal of any set that would record on nothing, and the preset the dialog starts from.
 */
import { describe, expect, it } from 'vitest'
import { checkProps, presetOf } from './RecordHoursModel'
import type { RecordHoursProps } from './RecordHoursModel'

const PROJECT: RecordHoursProps = {
  on: 'project',
  targetId: 'p1',
  targetName: 'Alpenstrom — portale clienti',
  activityId: '',
  activityName: '',
  placement: 'page',
}
const DEAL: RecordHoursProps = { ...PROJECT, on: 'deal', targetId: 'd1', targetName: 'Acme renewal' }
const NONE: RecordHoursProps = { ...PROJECT, on: 'none', targetId: '', targetName: '' }

describe('checkProps (plan § `hours/RecordHours` "valid sets")', () => {
  it.each([
    ['a project, from its page', PROJECT],
    ['a deal, from its page', DEAL],
    ['a project task', { ...PROJECT, activityId: 'a1', activityName: 'Write the offer', placement: 'row' }],
    ['a deal task', { ...DEAL, activityId: 'a1', activityName: 'Send the offer', placement: 'row' }],
    ['a task whose subject the host could not give', { ...PROJECT, activityId: 'a1', placement: 'row' }],
    ['a project the host could not name', { ...PROJECT, targetName: '' }],
    ['a CRM task with no deal', { ...NONE, activityName: 'Call Acme', placement: 'row' }],
    ['other work with nothing to name', NONE],
  ] as const)('accepts %s', (_what, props) => {
    expect(checkProps(props)).toEqual(props)
  })

  it.each([
    ['a project with no id', { ...PROJECT, targetId: '' }],
    ['a deal with no id', { ...DEAL, targetId: '' }],
    ['a project whose id is only spaces', { ...PROJECT, targetId: '  ' }],
    ['a task name with no task', { ...PROJECT, activityName: 'Write the offer' }],
    ['other work with an id', { ...NONE, targetId: 'p1' }],
    ['other work with a name', { ...NONE, targetName: 'Alpenstrom' }],
    ['other work with a task (a task is recorded on a project or a deal only)', { ...NONE, activityId: 'a1' }],
    ['an unknown kind', { ...PROJECT, on: 'meeting' }],
    ['an unknown placement', { ...PROJECT, placement: 'header' }],
    ['a member that is not a string', { ...PROJECT, targetName: 7 }],
    ['a member that is missing', { on: 'project', targetId: 'p1' }],
    ['nothing at all', undefined],
  ] as const)('refuses %s: a host bug, never a silent "record on nothing"', (_what, props) => {
    expect(() => checkProps(props as unknown as RecordHoursProps)).toThrow(/RecordHours/)
  })

  it('names the rule it broke and never the values', () => {
    const secret = 'Confidential project name'
    expect(() => checkProps({ ...PROJECT, targetId: '', targetName: secret })).toThrow(/^(?!.*Confidential)/s)
  })
})

describe('presetOf (R10: the dialog is opened on what the host passed, from one object)', () => {
  it('a project: the project, with the id and name the host gave, and no task', () => {
    expect(presetOf(PROJECT)).toEqual({
      on: { kind: 'project', project: { id: 'p1', name: 'Alpenstrom — portale clienti', companyName: null } },
    })
  })

  it('a project task: the task too, with its subject', () => {
    expect(presetOf({ ...PROJECT, activityId: 'a1', activityName: 'Write the offer' })).toEqual({
      on: { kind: 'project', project: { id: 'p1', name: 'Alpenstrom — portale clienti', companyName: null } },
      activity: { id: 'a1', subject: 'Write the offer' },
    })
  })

  it('a deal task: the deal and the task', () => {
    expect(presetOf({ ...DEAL, activityId: 'a1', activityName: 'Send the offer' })).toEqual({
      on: { kind: 'deal', deal: { id: 'd1', title: 'Acme renewal', companyName: null } },
      activity: { id: 'a1', subject: 'Send the offer' },
    })
  })

  it('a task with no subject: the task, its subject unknown', () => {
    expect(presetOf({ ...DEAL, activityId: 'a1' }).activity).toEqual({ id: 'a1', subject: null })
  })

  it('other work: no category chosen (A3) and never a task, even when the host named one for the button', () => {
    expect(presetOf({ ...NONE, activityName: 'Call Acme' })).toEqual({ on: { kind: 'none', categoryId: null } })
  })

  it('leaves the day to the dialog, which opens on today', () => {
    expect(presetOf(PROJECT).day).toBeUndefined()
  })
})
