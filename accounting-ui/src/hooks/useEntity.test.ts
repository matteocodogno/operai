import { describe, expect, it } from 'vitest'
import { noticeAfterReread, resolveEntity } from './useEntity'
import type { Me, MeEntity } from '../lib/meApi'

const ch: MeEntity = { entity: 'welld_ch', ownCurrency: 'CHF', canManage: true, rateSource: 'bazg' }
const it_: MeEntity = { entity: 'welld_it', ownCurrency: 'EUR', canManage: false, rateSource: null }

describe('resolveEntity (design UX-12)', () => {
  it('with no ?entity= shows the first covered entity and leaves the address alone', () => {
    expect(resolveEntity([ch, it_], undefined)).toEqual({ kind: 'default', entity: ch })
    expect(resolveEntity([it_], undefined)).toEqual({ kind: 'default', entity: it_ })
    expect(resolveEntity([ch], '')).toEqual({ kind: 'default', entity: ch })
  })

  it('shows the covered entity the address names', () => {
    expect(resolveEntity([ch, it_], 'welld_it')).toEqual({ kind: 'given', entity: it_ })
    expect(resolveEntity([ch], 'welld_ch')).toEqual({ kind: 'given', entity: ch })
  })

  it('a value that is not an entity id falls back to the first covered entity, to be replaced in the address', () => {
    for (const garbage of ['xyz', 'WELLD_CH', 'welld_ch ', 'welld_it,welld_ch', '0', 7, {}, []]) {
      expect(resolveEntity([ch, it_], garbage)).toEqual({ kind: 'fallback', entity: ch })
    }
  })

  it('a known entity the person does not cover is not found, never the other one’s data', () => {
    expect(resolveEntity([ch], 'welld_it')).toEqual({ kind: 'not_found', requested: 'welld_it' })
    expect(resolveEntity([it_], 'welld_ch')).toEqual({ kind: 'not_found', requested: 'welld_ch' })
  })

  it('with no covered entity there is nothing to resolve', () => {
    expect(resolveEntity([], 'welld_ch')).toEqual({ kind: 'none' })
    expect(resolveEntity([], undefined)).toEqual({ kind: 'none' })
  })
})

describe('noticeAfterReread', () => {
  const me = (...entities: MeEntity[]): Me => ({ entities })

  it('says the entity was lost, and which one is shown now, when /v1/me no longer lists it', () => {
    expect(noticeAfterReread('gone', { entity: 'welld_it', canManage: false }, me(ch))).toEqual({
      kind: 'lost',
      was: 'welld_it',
      now: 'welld_ch',
    })
    expect(noticeAfterReread('refused', { entity: 'welld_ch', canManage: true }, me(it_))).toEqual({
      kind: 'lost',
      was: 'welld_ch',
      now: 'welld_it',
    })
  })

  it('says nothing when the entity is still covered after a 404 (a transient answer)', () => {
    expect(noticeAfterReread('gone', { entity: 'welld_ch', canManage: true }, me(ch, it_))).toBeNull()
  })

  it('says nothing when nothing is covered any more (the frame shows denied)', () => {
    expect(noticeAfterReread('gone', { entity: 'welld_ch', canManage: true }, me())).toBeNull()
  })

  it('after a refused write, says the access changed only when canManage really changed', () => {
    expect(
      noticeAfterReread('refused', { entity: 'welld_ch', canManage: true }, me({ ...ch, canManage: false })),
    ).toEqual({
      kind: 'access',
    })
    expect(noticeAfterReread('refused', { entity: 'welld_ch', canManage: true }, me(ch))).toBeNull()
  })
})
