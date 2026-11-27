/**
 * The `operai:time-entry-recorded` event's name and detail guard (specs/20261112-project-hours T10; plan § "Browser event",
 * § Refreshing after Record hours; D84, D-P6; AC-2.8). The guard is what a listener (`HostHours` here, `ConsumptionBlock` in
 * projects-ui) asks before it acts on anything that arrives on `window`: any script of the page can dispatch an event with
 * this name, so a `detail` that is not exactly the content-free pair is ignored, never read for what else it carries.
 */
import { describe, expect, it } from 'vitest'
import { TIME_ENTRY_RECORDED, isTimeEntryRecordedDetail } from './timeEntryRecordedEvent'

describe('the event name', () => {
  it('is the one the plan and the listeners in projects-ui use', () => {
    expect(TIME_ENTRY_RECORDED).toBe('operai:time-entry-recorded')
  })
})

describe('isTimeEntryRecordedDetail accepts exactly { on, targetId } (plan § Browser event)', () => {
  it.each([
    ['a project', { on: 'project', targetId: 'p1' }],
    ['a deal', { on: 'deal', targetId: 'd1' }],
    ['other work, with no target id', { on: 'none', targetId: '' }],
    ['a target id as an opaque text (a cuid, a UUID)', { on: 'project', targetId: 'cm3x9k2l00001abcd' }],
  ])('accepts %s', (_what, detail) => {
    expect(isTimeEntryRecordedDetail(detail)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'project'],
    ['a number', 7],
    ['an array', ['project', 'p1']],
    ['an empty object', {}],
    ['a function', () => ({ on: 'project', targetId: 'p1' })],
  ])('refuses %s', (_what, detail) => {
    expect(isTimeEntryRecordedDetail(detail)).toBe(false)
  })

  it.each([
    ['a kind that is not project, deal or none', { on: 'meeting', targetId: 'm1' }],
    ['an unknown kind', { on: 'task', targetId: 'a1' }],
    ['a kind in another case', { on: 'Project', targetId: 'p1' }],
    ['no kind', { targetId: 'p1' }],
    ['a kind that is not text', { on: 1, targetId: 'p1' }],
    ['no target id', { on: 'project' }],
    ['a target id that is not text', { on: 'project', targetId: 5 }],
    ['a null target id', { on: 'deal', targetId: null }],
  ])('refuses %s', (_what, detail) => {
    expect(isTimeEntryRecordedDetail(detail)).toBe(false)
  })

  it.each([
    ['a project with no target id', { on: 'project', targetId: '' }],
    ['a deal with a blank target id', { on: 'deal', targetId: '  ' }],
    ['other work that names a target', { on: 'none', targetId: 'p1' }],
  ])('refuses %s: the target id is "" exactly when the hours went to no project or deal', (_what, detail) => {
    expect(isTimeEntryRecordedDetail(detail)).toBe(false)
  })

  it.each([
    ['minutes', { on: 'project', targetId: 'p1', minutes: 120 }],
    ['a day', { on: 'project', targetId: 'p1', day: '2026-11-26' }],
    ['a person', { on: 'deal', targetId: 'd1', userId: 'u1' }],
    ['an entry id', { on: 'deal', targetId: 'd1', entryId: 'e1' }],
    ['a note', { on: 'project', targetId: 'p1', note: 'secret' }],
    ['a key that is undefined', { on: 'project', targetId: 'p1', minutes: undefined }],
  ])(
    'refuses a detail that also carries %s: the event is content-free, so more is a different message',
    (_w, detail) => {
      expect(isTimeEntryRecordedDetail(detail)).toBe(false)
    },
  )

  it('refuses an array even when it carries the two members as named properties', () => {
    expect(isTimeEntryRecordedDetail(Object.assign([], { on: 'project', targetId: 'p1' }))).toBe(false)
  })

  it('reads own properties only: an inherited one is not a detail', () => {
    const inherited = Object.create({ on: 'project', targetId: 'p1' }) as unknown
    expect(isTimeEntryRecordedDetail(inherited)).toBe(false)
  })

  it('narrows the type, so a listener reads `on` and `targetId` without a cast', () => {
    const detail: unknown = { on: 'deal', targetId: 'd1' }
    if (!isTimeEntryRecordedDetail(detail)) throw new Error('the guard refused a valid detail')
    const target: { on: 'project' | 'deal' | 'none'; targetId: string } = detail
    expect(target).toEqual({ on: 'deal', targetId: 'd1' })
  })
})
