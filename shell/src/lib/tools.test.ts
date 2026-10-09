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
    expect(TOOLS.map((t) => t.id)).toEqual(['estimai', 'refund', 'admin', 'inventory'])
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
