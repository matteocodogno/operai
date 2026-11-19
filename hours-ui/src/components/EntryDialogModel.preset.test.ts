/**
 * What a dialog opened with a `preset` starts with, and where a refusal lands when its target is fixed
 * (specs/20261116-record-hours-in-place T1; plan § API contracts "`EntryDialog` (recording mode only)"; AC-3.2–3.4,
 * AC-4.2, AC-5.12, D13). The dialog's own tests prove what the person sees; this pins the decisions on values a
 * browser control would never hand over (a preset task on a meeting, a null category).
 */
import { describe, expect, it } from 'vitest'
import { HoursApiError } from '../lib/errors'
import { strings } from '../strings'
import { emptyValues, failureOf, presetValues } from './EntryDialogModel'
import type { EntryPreset } from './EntryDialogModel'

const TODAY = '2026-11-13'
const PROJECT = { id: 'p1', name: 'Project Alpha', companyName: null }
const DEAL = { id: 'd1', title: 'Acme renewal', companyName: 'Acme' }
const MEETING = { id: 'm1', title: 'Kick-off', startsAt: null }
const TASK = { id: 'a-offer', subject: 'Write the offer' }

describe('presetValues', () => {
  it('starts a project on the project and its task, today, with nothing else typed', () => {
    expect(presetValues(TODAY, { on: { kind: 'project', project: PROJECT }, activity: TASK })).toEqual({
      ...emptyValues(TODAY),
      kind: 'project',
      project: PROJECT,
      activityId: 'a-offer',
    })
  })

  it('starts a deal on the deal and its task', () => {
    expect(presetValues(TODAY, { on: { kind: 'deal', deal: DEAL }, activity: TASK })).toEqual({
      ...emptyValues(TODAY),
      kind: 'deal',
      deal: DEAL,
      activityId: 'a-offer',
    })
  })

  it('starts a project or a deal with no task when the preset has none', () => {
    expect(presetValues(TODAY, { on: { kind: 'project', project: PROJECT } }).activityId).toBeNull()
    expect(presetValues(TODAY, { on: { kind: 'deal', deal: DEAL } }).activityId).toBeNull()
  })

  it('takes the preset day, and today when it gives none', () => {
    expect(presetValues(TODAY, { day: '2026-11-10', on: { kind: 'project', project: PROJECT } }).day).toBe('2026-11-10')
    expect(presetValues(TODAY, { on: { kind: 'project', project: PROJECT } }).day).toBe(TODAY)
  })

  it('starts a meeting on the meeting', () => {
    expect(presetValues(TODAY, { on: { kind: 'meeting', meeting: MEETING } })).toEqual({
      ...emptyValues(TODAY),
      kind: 'meeting',
      meeting: MEETING,
    })
  })

  it('starts other work on its category, or on none chosen (A3)', () => {
    expect(presetValues(TODAY, { on: { kind: 'none', categoryId: 'tc-admin' } })).toEqual({
      ...emptyValues(TODAY),
      kind: 'none',
      categoryId: 'tc-admin',
    })
    expect(presetValues(TODAY, { on: { kind: 'none', categoryId: null } }).categoryId).toBe('')
  })

  it.each<[string, EntryPreset['on']]>([
    ['a meeting', { kind: 'meeting', meeting: MEETING }],
    ['other work', { kind: 'none', categoryId: 'tc-admin' }],
  ])('ignores a task on %s: only a project or a deal can have one (time-tracking AC-2.7)', (_name, on) => {
    expect(presetValues(TODAY, { on, activity: TASK }).activityId).toBeNull()
  })
})

describe('failureOf in a fixed dialog (AC-4.2, D13)', () => {
  const t = strings.entry.errors
  const refused = (status: number, rawCode: string | null) =>
    new HoursApiError({ status, title: `Problem ${status}`, rawCode })

  it.each([
    ['not_on_project', 403, 'project', t.notOnProject],
    ['not_involved_in_deal', 403, 'deal', t.notInvolvedInDeal],
    ['not_found', 404, 'project', t.targetGoneFixed.project],
    ['not_found', 404, 'deal', t.targetGoneFixed.deal],
    ['not_found', 404, 'meeting', t.targetGoneFixed.meeting],
  ] as const)('puts %s (%s) on %s as the dialog’s one alert, never on a field', (code, status, kind, message) => {
    expect(failureOf(refused(status, code), kind, undefined, true)).toEqual({
      fields: {},
      form: message,
      reloadLists: false,
    })
  })

  it.each([
    ['not_on_project', 403, 'project', t.notOnProject],
    ['not_involved_in_deal', 403, 'deal', t.notInvolvedInDeal],
    ['not_found', 404, 'project', t.targetGone.project],
  ] as const)('still puts %s (%s) on %s’s picker when the dialog has one', (code, status, kind, message) => {
    expect(failureOf(refused(status, code), kind, undefined, false)).toEqual({
      fields: { entity: message },
      form: null,
      reloadLists: false,
    })
  })

  it('leaves the other refusals where they were, fixed or not', () => {
    for (const fixed of [false, true]) {
      expect(failureOf(refused(422, 'invalid_minutes'), 'project', undefined, fixed).fields).toEqual({
        minutes: t.durationUnreadable,
      })
      expect(failureOf(refused(422, 'future_day'), 'deal', undefined, fixed).fields).toEqual({ day: t.dayFuture })
      expect(failureOf(refused(503, 'host_unavailable'), 'project', undefined, fixed).form).toBe(
        t.hostUnavailable.project,
      )
    }
  })

  it('says something went wrong, nothing more, for a refusal that cannot be about the kind chosen', () => {
    expect(failureOf(refused(403, 'not_on_project'), 'none', undefined, true).form).toBe(t.generic)
    expect(failureOf(refused(404, 'not_found'), 'none', undefined, true).form).toBe(t.generic)
  })

  // QE D1: the fixed task is shown as a fact, a place no error can be written on, so its refusal is the one alert.
  it.each([
    ['project', t.activityNotAllowed.project],
    ['deal', t.activityNotAllowed.deal],
  ] as const)(
    'puts activity_not_allowed on a fixed task of a %s as the dialog’s one alert, in the words My hours uses',
    (kind, message) => {
      expect(failureOf(refused(422, 'activity_not_allowed'), kind, undefined, true, true)).toEqual({
        fields: {},
        form: message,
        reloadLists: false,
      })
    },
  )

  it.each([
    ['a fixed dialog whose Activity is still a select', true],
    ['a dialog with a picker', false],
  ])('keeps activity_not_allowed on the Activity field in %s: there is a field to write it on', (_name, fixed) => {
    expect(failureOf(refused(422, 'activity_not_allowed'), 'project', undefined, fixed, false)).toEqual({
      fields: { activity: t.activityNotAllowed.project },
      form: null,
      reloadLists: false,
    })
  })

  // The class behind D1: a refusal written on a field the dialog does not draw is a Save that does nothing. Every
  // code failureOf knows, in every kind, in the dialog that draws the least: a task fixed on a fixed target.
  const CODES: [number, string | null][] = [
    [422, 'invalid_minutes'],
    [422, 'future_day'],
    [422, 'note_too_long'],
    [422, 'note_required'],
    [422, 'category_not_found'],
    [422, 'category_retired'],
    [422, 'work_type_not_found'],
    [422, 'work_type_retired'],
    [422, 'work_type_not_allowed'],
    [422, 'activity_not_allowed'],
    [403, 'not_on_project'],
    [403, 'not_involved_in_deal'],
    [404, 'not_found'],
    [503, 'host_unavailable'],
    [500, null],
    [418, 'a_code_from_a_server_one_step_ahead'],
  ]
  const DRAWN_WHEN_FIXED = ['day', 'minutes', 'category', 'workType', 'note']
  it.each(
    CODES.flatMap(([status, code]) =>
      (['project', 'deal', 'meeting', 'none'] as const).map((kind) => [status, code, kind] as const),
    ),
  )('a %s %s on a fixed %s is shown: on a field the fixed dialog draws, or as the one alert', (status, code, kind) => {
    const failure = failureOf(refused(status, code), kind, undefined, true, true)
    const fields = Object.keys(failure.fields)
    expect(fields.filter((field) => !DRAWN_WHEN_FIXED.includes(field))).toEqual([])
    expect(fields.length > 0 || (failure.form !== null && failure.form !== '')).toBe(true)
  })
})
