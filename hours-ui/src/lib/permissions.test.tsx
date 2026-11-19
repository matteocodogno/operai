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
 * (design § HoursShell, ADR 20261108-estimai-oversight-permission-amends-0036): the server is the gate. The shell's `usePermissions()` has no
 * "loaded" flag (an unresolved answer is its empty result), so "resolved" is read from the answer.
 */
describe('hoursAccessOf', () => {
  it('a holder of time-entry:read-all can read everyone’s hours', () => {
    const held = result({ epoch: 3, permissions: [{ resource: 'time-entry', action: 'read-all' }] })
    expect(hoursAccessOf(held)).toEqual({ resolved: true, canReadAll: true, canManageLists: false })
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
    expect(hoursAccessOf(employee)).toEqual({ resolved: true, canReadAll: false, canManageLists: false })
  })

  it('the empty answer is not resolved, and holds nothing (it fails closed while it is unknown)', () => {
    expect(hoursAccessOf(result())).toEqual({ resolved: false, canReadAll: false, canManageLists: false })
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

/**
 * The Settings tab and page (the time lists, T43, D51) are the same kind of convenience for holders of
 * `time-list:manage`: independent of `time-entry:read-all`, and the server is the gate on every write.
 */
describe('hoursAccessOf: managing the time lists', () => {
  it('a holder of time-list:manage can manage the lists, and that alone', () => {
    const held = result({ epoch: 3, permissions: [{ resource: 'time-list', action: 'manage' }] })
    expect(hoursAccessOf(held)).toEqual({ resolved: true, canReadAll: false, canManageLists: true })
  })

  it('holding both permissions grants both, independently', () => {
    const both = result({
      epoch: 3,
      permissions: [
        { resource: 'time-entry', action: 'read-all' },
        { resource: 'time-list', action: 'manage' },
      ],
    })
    expect(hoursAccessOf(both)).toEqual({ resolved: true, canReadAll: true, canManageLists: true })
  })

  it('nothing else grants it: not another action, not another resource', () => {
    for (const permission of [
      { resource: 'time-list', action: 'read' },
      { resource: 'time-entry', action: 'manage' },
      { resource: 'time-entry', action: 'read-all' },
      { resource: 'settings', action: 'manage' },
      { resource: 'time-list', action: 'manage-all' },
    ]) {
      expect(hoursAccessOf(result({ epoch: 3, permissions: [permission] })).canManageLists).toBe(false)
    }
  })

  it('an empty answer holds nothing: the tab stays out while the permissions resolve (fail closed)', () => {
    expect(hoursAccessOf(result()).canManageLists).toBe(false)
  })
})

describe('useHoursAccess', () => {
  it('follows the shell’s permissions as they resolve', () => {
    const view = renderHook(() => useHoursAccess())
    expect(view.result.current).toEqual({ resolved: false, canReadAll: false, canManageLists: false })

    current.value = result({ epoch: 4, permissions: [{ resource: 'time-entry', action: 'read-all' }] })
    view.rerender()
    expect(view.result.current).toEqual({ resolved: true, canReadAll: true, canManageLists: false })

    current.value = result({ epoch: 5, permissions: [{ resource: 'time-list', action: 'manage' }] })
    view.rerender()
    expect(view.result.current).toEqual({ resolved: true, canReadAll: false, canManageLists: true })
  })
})
