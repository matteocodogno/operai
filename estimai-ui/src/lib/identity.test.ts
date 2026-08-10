/**
 * Tests for formatIdentity (T14, specs/013-estimate-sharing/tasks.md).
 *
 * Covers the three wire statuses `auth POST /authz/users/identities` can
 * return, plus the defensive "active but blank name" edge case — the rule
 * being that the function NEVER returns a blank string, a raw id, or `null`
 * (AC-10.5).
 */

import { describe, expect, it } from 'vitest'
import { formatIdentity } from './identity'
import { strings } from '../strings'

describe('formatIdentity', () => {
  it('renders the resolved name for an active identity', () => {
    expect(formatIdentity({ id: 'usr_1', status: 'active', name: 'Ada Lovelace' })).toBe('Ada Lovelace')
  })

  it('renders the "Former wellD member" placeholder for a deleted identity', () => {
    expect(formatIdentity({ id: 'usr_2', status: 'deleted', name: null })).toBe(strings.sharing.identity.deleted)
    // A deleted identity's name is authoritatively null on the wire, but even
    // if a stray name were present the placeholder still wins — deleted
    // means deleted, never a lingering active-looking name (AC-10.5).
    expect(formatIdentity({ id: 'usr_2', status: 'deleted', name: 'Stale Name' })).toBe(
      strings.sharing.identity.deleted,
    )
  })

  it('renders the "Unknown wellD member" placeholder for an unknown identity', () => {
    expect(formatIdentity({ id: 'usr_3', status: 'unknown', name: null })).toBe(strings.sharing.identity.unknown)
  })

  it('falls back to the unknown placeholder rather than blank for a malformed active identity', () => {
    expect(formatIdentity({ id: 'usr_4', status: 'active', name: null })).toBe(strings.sharing.identity.unknown)
    expect(formatIdentity({ id: 'usr_5', status: 'active', name: '' })).toBe(strings.sharing.identity.unknown)
    expect(formatIdentity({ id: 'usr_6', status: 'active', name: '   ' })).toBe(strings.sharing.identity.unknown)
  })

  it('never returns a raw id in place of a name', () => {
    const id = 'clx1a2b3c4d5e6f7g8h9'
    for (const status of ['active', 'deleted', 'unknown'] as const) {
      const result = formatIdentity({ id, status, name: null })
      expect(result).not.toBe(id)
      expect(result.length).toBeGreaterThan(0)
    }
  })
})
