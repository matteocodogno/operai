/**
 * `meetingProjectOf` — a meeting entry's project, with a missing one read as "none" (specs/20261112-project-hours T11; design G4;
 * plan § Deploy order step 2: hours-ui ships before hours-api sends `on.project`).
 */
import { describe, expect, it } from 'vitest'
import { meetingOn } from '../test-support/fakeApi'
import type { MeetingProject } from './hoursApi.types'
import { meetingProjectOf } from './meetingProject'

const ALPHA: MeetingProject = {
  state: 'linked',
  visibility: 'visible',
  id: 'p1',
  label: 'Project Alpha',
  href: '/projects/p1',
}

describe('meetingProjectOf', () => {
  it.each<[string, MeetingProject]>([
    ['linked, visible', ALPHA],
    ['linked, hidden', { state: 'linked', visibility: 'hidden' }],
    ['linked, unavailable', { state: 'linked', visibility: 'unavailable' }],
    ['none', { state: 'none' }],
    ['unknown', { state: 'unknown' }],
  ])('is the project the server sent: %s', (_what, project) => {
    expect(meetingProjectOf({ ...meetingOn('m1', 'Kick-off call'), project })).toBe(project)
  })

  it('reads a missing `project` (an hours-api older than this feature) as none, never as unknown', () => {
    const on = meetingOn('m1', 'Kick-off call')
    expect(on).not.toHaveProperty('project')
    expect(meetingProjectOf(on)).toEqual({ state: 'none' })
  })

  it('reads a `project` the server sent as null the same way', () => {
    const on = { ...meetingOn('m1', 'Kick-off call'), project: null } as unknown as ReturnType<typeof meetingOn>
    expect(meetingProjectOf(on)).toEqual({ state: 'none' })
  })
})
