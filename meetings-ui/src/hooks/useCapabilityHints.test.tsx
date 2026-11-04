/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const snapshot = vi.hoisted(() => ({
  value: {
    epoch: 1,
    apps: [] as string[],
    roles: [],
    departments: [],
    permissions: [] as { resource: string; action: string }[],
  },
}))

vi.mock('shell/session', () => ({ usePermissions: () => snapshot.value }))

import { useCapabilityHints } from './useCapabilityHints'

beforeEach(() => {
  snapshot.value = { epoch: 1, apps: [], roles: [], departments: [], permissions: [] }
})

describe('useCapabilityHints', () => {
  it('reads `apps` for the entry points and the {resource, action} pairs for templates and erase', () => {
    snapshot.value = {
      ...snapshot.value,
      apps: ['meetings'],
      permissions: [
        { resource: 'template', action: 'manage' },
        { resource: 'meeting', action: 'erase' },
      ],
    }
    const { result } = renderHook(() => useCapabilityHints())
    expect(result.current).toEqual({ canUseMeetings: true, canManageTemplates: true, canErase: true })
  })

  it('an employee without the app has no entry points (My meetings still works: it asks no hint)', () => {
    const { result } = renderHook(() => useCapabilityHints())
    expect(result.current).toEqual({ canUseMeetings: false, canManageTemplates: false, canErase: false })
  })
})
