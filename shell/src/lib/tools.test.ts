/**
 * @vitest-environment jsdom
 *
 * Tests for the tool registry (specs/20261006-hardware-inventory, T42, AC-4.1/AC-9.6).
 * `inventory` is a gated tool; `/devices` (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote) is deliberately NOT one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  LAST_TOOL_STORAGE_KEY,
  SETTINGS_TOOL_IDS,
  TOOLS,
  isToolId,
  readLastToolId,
  recordLastTool,
  resolveLastToolPath,
  toolPath,
} from './tools'

afterEach(() => {
  localStorage.clear()
})

describe('TOOLS — inventory', () => {
  it('lists Inventory at /inventory, after Admin', () => {
    expect(TOOLS.map((t) => t.id)).toEqual([
      'estimai',
      'refund',
      'admin',
      'inventory',
      'crm',
      'meetings',
      'projects',
      'letterheads',
      'accounting',
    ])
    expect(TOOLS.find((t) => t.id === 'inventory')).toEqual({
      id: 'inventory',
      label: 'Inventory',
      to: '/inventory',
    })
  })

  it('recognises inventory as a tool id and resolves its path', () => {
    expect(isToolId('inventory')).toBe(true)
    expect(toolPath('inventory')).toBe('/inventory')
  })

  it('round-trips inventory through the last-tool record', () => {
    recordLastTool('inventory')
    expect(localStorage.getItem(LAST_TOOL_STORAGE_KEY)).toBe('inventory')
    expect(readLastToolId()).toBe('inventory')
    expect(resolveLastToolPath()).toBe('/inventory')
  })

  it('has no entry for /devices — an identity-scoped screen, not a tool (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote)', () => {
    expect(TOOLS.some((t) => t.to === '/devices' || t.id === ('devices' as never))).toBe(false)
    expect(isToolId('devices')).toBe(false)
  })
})

// specs/20261101-crm: the CRM is a gated tool, after Inventory.
describe('TOOLS — crm', () => {
  it('lists CRM at /crm and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'crm')).toEqual({ id: 'crm', label: 'CRM', to: '/crm' })
    expect(isToolId('crm')).toBe(true)
    expect(toolPath('crm')).toBe('/crm')
  })
})

// specs/20261104-meetings: Meetings is a gated tool, after the CRM. `/my-meetings`
// (ungated, identity-scoped; ADR 20261006-ungated-second-federated-entry-of-a-gated-remote shape) is deliberately NOT an entry.
describe('TOOLS — meetings', () => {
  it('lists Meetings at /meetings and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'meetings')).toEqual({ id: 'meetings', label: 'Meetings', to: '/meetings' })
    expect(isToolId('meetings')).toBe(true)
    expect(toolPath('meetings')).toBe('/meetings')
  })

  it('round-trips meetings through the last-tool record', () => {
    recordLastTool('meetings')
    expect(readLastToolId()).toBe('meetings')
    expect(resolveLastToolPath()).toBe('/meetings')
  })

  it('has no entry for /my-meetings — an identity-scoped screen, not a tool', () => {
    expect(TOOLS.some((t) => t.to === '/my-meetings')).toBe(false)
    expect(isToolId('my-meetings')).toBe(false)
  })
})

// specs/20261103-projects (AC-4.1): Projects is a gated tool, after CRM. The id is the
// auth catalog resource (`projects`), so the sidebar's `apps.includes(tool.id)`
// filter shows it exactly to the callers `/authz/me` reports `projects:access` for.
describe('TOOLS — projects', () => {
  it('lists Projects at /projects and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'projects')).toEqual({ id: 'projects', label: 'Projects', to: '/projects' })
    expect(isToolId('projects')).toBe(true)
    expect(toolPath('projects')).toBe('/projects')
  })

  it('round-trips projects through the last-tool record', () => {
    recordLastTool('projects')
    expect(readLastToolId()).toBe('projects')
    expect(resolveLastToolPath()).toBe('/projects')
  })

  it('is offered only to callers whose apps include projects (projects:access)', () => {
    const visibleFor = (apps: string[]) => TOOLS.filter((tool) => apps.includes(tool.id)).map((tool) => tool.id)

    expect(visibleFor(['projects'])).toEqual(['projects'])
    expect(visibleFor(['estimai', 'crm', 'projects'])).toEqual(['estimai', 'crm', 'projects'])
    // `crm:access` or any other grant is not `projects:access` (AC-4.1, D13).
    expect(visibleFor(['estimai', 'refund', 'admin', 'inventory', 'crm'])).not.toContain('projects')
    expect(visibleFor([])).toEqual([])
  })
})

// specs/20261116-letterhead-service (AC-8.1): Letterheads is a gated tool, after Projects. The id is the
// auth catalog's app id (`letterheads`), so the sidebar's `apps.includes(tool.id)` filter shows it exactly to
// the callers `/authz/me` reports `letterheads:access` for.
describe('TOOLS — letterheads', () => {
  it('lists Letterheads at /letterheads and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'letterheads')).toEqual({
      id: 'letterheads',
      label: 'Letterheads',
      to: '/letterheads',
    })
    expect(isToolId('letterheads')).toBe(true)
    expect(toolPath('letterheads')).toBe('/letterheads')
  })

  it('round-trips letterheads through the last-tool record', () => {
    recordLastTool('letterheads')
    expect(readLastToolId()).toBe('letterheads')
    expect(resolveLastToolPath()).toBe('/letterheads')
  })

  it('is offered only to callers whose apps include letterheads (letterheads:access)', () => {
    const visibleFor = (apps: string[]) => TOOLS.filter((tool) => apps.includes(tool.id)).map((tool) => tool.id)
    expect(visibleFor(['letterheads'])).toEqual(['letterheads'])
    expect(visibleFor(['estimai', 'crm', 'letterheads'])).toEqual(['estimai', 'crm', 'letterheads'])
    expect(visibleFor(['estimai', 'refund', 'admin', 'inventory', 'crm', 'projects'])).not.toContain('letterheads')
  })
})

// specs/20261119-accounting (AC-8.1, design UX-14): Accounting is a gated tool, LAST in the list (Letterheads is in the Settings
// group, so in the sidebar's main list it follows Projects). The id is the auth catalog's app id (`accounting`), which
// `/authz/me` DERIVES into `apps` for a holder of `accounting:read` or `accounting:manage` over at least one entity (ADR
// 20261117-an-app-is-reachable-… amendment A6): the shell reads `apps` as for every tool and decides nothing about entities.
describe('TOOLS — accounting', () => {
  it('lists Accounting at /accounting, last, and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'accounting')).toEqual({
      id: 'accounting',
      label: 'Accounting',
      to: '/accounting',
    })
    expect(TOOLS[TOOLS.length - 1]?.id).toBe('accounting')
    expect(isToolId('accounting')).toBe(true)
    expect(toolPath('accounting')).toBe('/accounting')
  })

  it('is a main-list tool, not a Settings-group one', () => {
    expect(SETTINGS_TOOL_IDS).not.toContain('accounting')
  })

  it('round-trips accounting through the last-tool record', () => {
    recordLastTool('accounting')
    expect(readLastToolId()).toBe('accounting')
    expect(resolveLastToolPath()).toBe('/accounting')
  })

  it('is offered only to callers whose apps include accounting', () => {
    const visibleFor = (apps: string[]) => TOOLS.filter((tool) => apps.includes(tool.id)).map((tool) => tool.id)
    expect(visibleFor(['accounting'])).toEqual(['accounting'])
    expect(visibleFor(['estimai', 'projects', 'accounting'])).toEqual(['estimai', 'projects', 'accounting'])
    // No other grant stands in for it, `refund` and `admin` included (AC-3.9, AC-8.1).
    expect(visibleFor(['estimai', 'refund', 'admin', 'inventory', 'crm', 'projects', 'letterheads'])).not.toContain(
      'accounting',
    )
  })
})
