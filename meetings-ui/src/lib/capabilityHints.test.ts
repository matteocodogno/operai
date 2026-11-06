import { describe, expect, it } from 'vitest'
import { capabilityHints } from './capabilityHints'

const result = (apps: string[], permissions: { resource: string; action: string }[]) => ({
  epoch: 1,
  apps,
  roles: [],
  departments: [],
  permissions,
})

describe('capabilityHints (plan G5): UI hints only, the server decides', () => {
  it('canUseMeetings reads `apps`: New meeting, Templates, Start meeting and Link an existing meeting', () => {
    expect(capabilityHints(result(['meetings'], [])).canUseMeetings).toBe(true)
    expect(capabilityHints(result(['crm', 'refund'], [])).canUseMeetings).toBe(false)
  })

  it('canManageTemplates reads the {template, manage} pair: the shared scope in the template form', () => {
    expect(capabilityHints(result([], [{ resource: 'template', action: 'manage' }])).canManageTemplates).toBe(true)
    expect(capabilityHints(result([], [{ resource: 'template', action: 'read' }])).canManageTemplates).toBe(false)
    expect(capabilityHints(result([], [{ resource: 'manage', action: 'template' }])).canManageTemplates).toBe(false)
  })

  it('canErase reads the {meeting, erase} pair: the Erase tab', () => {
    expect(capabilityHints(result([], [{ resource: 'meeting', action: 'erase' }])).canErase).toBe(true)
    expect(capabilityHints(result([], [{ resource: 'meeting', action: 'read' }])).canErase).toBe(false)
  })

  it('the three hints are independent: erase does not imply template management, nor `apps`', () => {
    expect(capabilityHints(result([], [{ resource: 'meeting', action: 'erase' }]))).toEqual({
      canUseMeetings: false,
      canManageTemplates: false,
      canErase: true,
    })
  })

  it('an empty snapshot grants nothing', () => {
    expect(capabilityHints(result([], []))).toEqual({
      canUseMeetings: false,
      canManageTemplates: false,
      canErase: false,
    })
  })
})
