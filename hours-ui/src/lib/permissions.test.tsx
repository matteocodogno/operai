/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

const { current } = vi.hoisted(() => ({
  current: {
    value: { epoch: 0, apps: [], roles: [], departments: [], permissions: [] } as {
      epoch: number
      apps: string[]
      roles: string[]
      departments: string[]
      permissions: { resource: string; action: string }[]
    },
  },
}))
vi.mock('shell/session', () => ({ usePermissions: () => current.value }))

import { hoursAccessOf, useHoursAccess } from './permissions'

const result = (over: Partial<typeof current.value> = {}) => ({
  epoch: 0,
  apps: [],
  roles: [],
  departments: [],
  permissions: [],
  ...over,
})

afterEach(() => {
  cleanup()
  current.value = result()
})

/**
 * The Everyone's hours tab and page are a UX convenience for holders of `time-entry:read-all`
 * (design § HoursShell, ADR-0075): the server is the gate. The shell's `usePermissions()` has no
 * "loaded" flag (an unresolved answer is its empty result), so "resolved" is read from the answer.
 */
describe('hoursAccessOf', () => {
  it('a holder of time-entry:read-all can read everyone’s hours', () => {
    const held = result({ epoch: 3, permissions: [{ resource: 'time-entry', action: 'read-all' }] })
    expect(hoursAccessOf(held)).toEqual({ resolved: true, canReadAll: true })
  })

  it('nothing else grants it: not another action, not another resource', () => {
    for (const permission of [
      { resource: 'time-entry', action: 'read' },
      { resource: 'time-list', action: 'manage' },
      { resource: 'estimate', action: 'read-all' },
      { resource: 'time-entry', action: 'read-all-of-them' },
    ]) {
      expect(hoursAccessOf(result({ epoch: 3, permissions: [permission] })).canReadAll).toBe(false)
    }
  })

  it('a person with permissions but not this one is resolved and not a holder', () => {
    const employee = result({
      epoch: 2,
      roles: ['employee'],
      apps: ['meetings'],
      permissions: [{ resource: 'meetings', action: 'access' }],
    })
    expect(hoursAccessOf(employee)).toEqual({ resolved: true, canReadAll: false })
  })

  it('the empty answer is not resolved, and holds nothing (it fails closed while it is unknown)', () => {
    expect(hoursAccessOf(result())).toEqual({ resolved: false, canReadAll: false })
  })

  it.each([
    ['an epoch', { epoch: 1 }],
    ['an app', { apps: ['meetings'] }],
    ['a role', { roles: ['employee'] }],
    ['a department', { departments: ['delivery'] }],
    ['a permission', { permissions: [{ resource: 'meetings', action: 'access' }] }],
  ])('%s alone shows the answer has arrived', (_what, over) => {
    expect(hoursAccessOf(result(over)).resolved).toBe(true)
  })
})

describe('useHoursAccess', () => {
  it('follows the shell’s permissions as they resolve', () => {
    const view = renderHook(() => useHoursAccess())
    expect(view.result.current).toEqual({ resolved: false, canReadAll: false })

    current.value = result({ epoch: 4, permissions: [{ resource: 'time-entry', action: 'read-all' }] })
    view.rerender()
    expect(view.result.current).toEqual({ resolved: true, canReadAll: true })
  })
})
