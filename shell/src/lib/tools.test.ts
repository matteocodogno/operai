/**
 * @vitest-environment jsdom
 *
 * Tests for the tool registry (specs/015-hardware-inventory, T42, AC-4.1/AC-9.6).
 * `inventory` is a gated tool; `/devices` (ADR-0045) is deliberately NOT one.
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
    expect(TOOLS.map((t) => t.id)).toEqual(['estimai', 'refund', 'admin', 'inventory', 'crm', 'meetings'])
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

  it('has no entry for /devices — an identity-scoped screen, not a tool (ADR-0045)', () => {
    expect(TOOLS.some((t) => t.to === '/devices' || t.id === ('devices' as never))).toBe(false)
    expect(isToolId('devices')).toBe(false)
  })
})

// specs/017-crm: the CRM is a gated tool, after Inventory.
describe('TOOLS — crm', () => {
  it('lists CRM at /crm and resolves it as a tool id', () => {
    expect(TOOLS.find((t) => t.id === 'crm')).toEqual({ id: 'crm', label: 'CRM', to: '/crm' })
    expect(isToolId('crm')).toBe(true)
    expect(toolPath('crm')).toBe('/crm')
  })
})

// specs/021-meetings: Meetings is a gated tool, after the CRM. `/my-meetings`
// (ungated, identity-scoped; ADR-0045 shape) is deliberately NOT an entry.
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
