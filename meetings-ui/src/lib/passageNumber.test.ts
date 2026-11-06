import { describe, expect, it } from 'vitest'
import { en, it as italian } from '../strings'
import { passageNumber } from './passageNumber'

describe('passageNumber', () => {
  it('the API ordinal is 0-based; people count from 1', () => {
    expect(passageNumber(0)).toBe(1)
    expect(passageNumber(4)).toBe(5)
  })

  it('the first passage reads "1" in both languages, in a citation and in the edit control', () => {
    expect(en.ask.sourcePassage(passageNumber(0))).toBe('Passage 1')
    expect(italian.ask.sourcePassage(passageNumber(0))).toBe('Passaggio 1')
    expect(en.transcript.editPassage(passageNumber(0))).toBe('Edit passage 1')
    expect(italian.transcript.editPassage(passageNumber(0))).toBe('Modifica il passaggio 1')
  })
})
