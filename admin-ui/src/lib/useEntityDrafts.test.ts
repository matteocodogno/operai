/**
 * @vitest-environment jsdom
 *
 * useEntityDrafts (T36, design S1 "Drafts"): one draft per entity, copied in and out, "unsaved" measured against
 * the entity as last read after normalisation, fixed page order, nothing stored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { unsavedEntities, useEntityDrafts } from './useEntityDrafts'
import { detailsOf, emptyDetails } from './legalEntityModel'
import type { LegalEntityDetails } from './legalEntityModel'

const saved = (name: string): LegalEntityDetails => ({
  ...emptyDetails(),
  legalName: name,
  address: { it: ['Via Esempio 12'], en: ['Via Esempio 12'] },
  vatNumber: 'IT00000000000',
  iban: 'IT60X0542811101000000123456',
})
const bases = { welld_it: saved('wellD S.r.l.'), welld_ch: saved('wellD AG') }

afterEach(cleanup)

describe('unsavedEntities', () => {
  it('counts a draft that changes a value, in the fixed page order whatever order they were typed', () => {
    const drafts = {
      welld_ch: { ...saved('wellD AG'), legalName: 'wellD Holding AG' },
      welld_it: { ...saved('wellD S.r.l.'), vatNumber: 'IT11111111111' },
    }
    expect(unsavedEntities(drafts, bases)).toEqual(['welld_it', 'welld_ch'])
  })

  it('does not count a draft that is the saved details once normalised (blanks, an IBAN typed with spaces and lower case, an empty line)', () => {
    const base = bases.welld_it
    const same: LegalEntityDetails = {
      ...detailsOf(base),
      legalName: '  wellD S.r.l.  ',
      iban: 'it60 x054 2811 1010 0000 0123 456',
      address: { it: ['', 'Via Esempio 12', '   '], en: ['Via Esempio 12'] },
    }
    expect(unsavedEntities({ welld_it: same }, bases)).toEqual([])
  })

  it('counts nothing for an entity that was not read (no base to measure against)', () => {
    expect(unsavedEntities({ welld_it: saved('x') }, {})).toEqual([])
  })
})

describe('useEntityDrafts', () => {
  it('starts with no draft and nothing unsaved', () => {
    const { result } = renderHook(() => useEntityDrafts(bases))
    expect(result.current.draftOf('welld_it')).toBeUndefined()
    expect(result.current.unsaved).toEqual([])
    expect(result.current.isUnsaved('welld_it')).toBe(false)
  })

  it('keeps one draft per entity, each untouched by the other', () => {
    const { result } = renderHook(() => useEntityDrafts(bases))

    act(() => result.current.setDraft('welld_it', { ...saved('wellD S.r.l.'), legalName: 'A' }))
    act(() => result.current.setDraft('welld_ch', { ...saved('wellD AG'), legalName: 'B' }))

    expect(result.current.draftOf('welld_it')?.legalName).toBe('A')
    expect(result.current.draftOf('welld_ch')?.legalName).toBe('B')
    expect(result.current.unsaved).toEqual(['welld_it', 'welld_ch'])

    act(() => result.current.discard('welld_it'))
    expect(result.current.draftOf('welld_it')).toBeUndefined()
    expect(result.current.draftOf('welld_ch')?.legalName).toBe('B')
    expect(result.current.isUnsaved('welld_it')).toBe(false)
    expect(result.current.isUnsaved('welld_ch')).toBe(true)
  })

  it('copies what it is given: the caller keeps no handle on the stored draft', () => {
    const { result } = renderHook(() => useEntityDrafts(bases))
    const typed = { ...saved('wellD S.r.l.'), legalName: 'A' }

    act(() => result.current.setDraft('welld_it', typed))
    typed.legalName = 'changed behind its back'
    typed.address.it.push('another line')

    expect(result.current.draftOf('welld_it')?.legalName).toBe('A')
    expect(result.current.draftOf('welld_it')?.address.it).toEqual(['Via Esempio 12'])
  })

  it('discarding what is not there changes nothing (no re-render storm)', () => {
    const renders = vi.fn()
    const { result } = renderHook(() => {
      renders()
      return useEntityDrafts(bases)
    })
    const before = renders.mock.calls.length

    act(() => result.current.discard('welld_ch'))
    act(() => result.current.discardAll())

    expect(renders.mock.calls.length).toBe(before)
  })

  it('drops every draft at once', () => {
    const { result } = renderHook(() => useEntityDrafts(bases))
    act(() => result.current.setDraft('welld_it', { ...saved('wellD S.r.l.'), legalName: 'A' }))
    act(() => result.current.setDraft('welld_ch', { ...saved('wellD AG'), legalName: 'B' }))

    act(() => result.current.discardAll())

    expect(result.current.unsaved).toEqual([])
    expect(result.current.draftOf('welld_it')).toBeUndefined()
  })

  it('measures against the entity as last read: a re-read that now equals the draft is no longer unsaved', () => {
    let current = bases
    const { result, rerender } = renderHook(() => useEntityDrafts(current))
    act(() => result.current.setDraft('welld_it', { ...saved('wellD S.r.l.'), legalName: 'wellD Group' }))
    expect(result.current.unsaved).toEqual(['welld_it'])

    current = { ...bases, welld_it: saved('wellD Group') }
    rerender()

    expect(result.current.unsaved).toEqual([])
  })

  it('writes nothing to storage (a draft is company data)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useEntityDrafts(bases))
    act(() => result.current.setDraft('welld_it', { ...saved('wellD S.r.l.'), legalName: 'A' }))
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})
