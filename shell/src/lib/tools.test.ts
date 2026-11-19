/**
 * @vitest-environment jsdom
 *
 * Tests for the tool registry (specs/20261006-hardware-inventory, T42, AC-4.1/AC-9.6).
 * `inventory` is a gated tool; `/devices` (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote) is deliberately NOT one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  LAST_TOOL_STORAGE_KEY,
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

// specs/20261112-time-tracking (AC-5.1, ADR 20261112-hours-ui-ungated-remote): Hours is deliberately NOT a tool. Every signed-in user
// records and reads their own hours, so it has no `access` grant to filter the sidebar on; listing it
// in TOOLS behind an `hours:access` grant would recreate the zero-grant lockout (ADR 20260804-shell-identity-scoped-non-tool-screens-account-route's test).
describe('TOOLS — hours is not a tool (ADR 20261112-hours-ui-ungated-remote)', () => {
  it('has no entry for /hours — a self-service screen, mounted on a shell-owned ungated route', () => {
    expect(TOOLS.some((t) => t.to === '/hours' || t.to.startsWith('/hours/'))).toBe(false)
    expect(TOOLS.some((t) => t.id === ('hours' as never))).toBe(false)
  })

  it('does not recognise hours as a tool id, so it can never be recorded as the last tool', () => {
    expect(isToolId('hours')).toBe(false)
    // A tampered `operai_last_tool` naming it is ignored like any other unknown value.
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, 'hours')
    expect(readLastToolId()).toBeNull()
    expect(resolveLastToolPath()).toBe('/estimai')
  })

  it('is offered to no caller through the sidebar filter, whatever apps they hold', () => {
    const visibleFor = (apps: string[]) => TOOLS.filter((tool) => apps.includes(tool.id)).map((tool) => tool.id)

    expect(visibleFor(['hours'])).toEqual([])
    expect(visibleFor(['estimai', 'hours'])).toEqual(['estimai'])
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
