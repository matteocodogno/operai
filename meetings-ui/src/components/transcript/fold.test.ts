import { describe, expect, it } from 'vitest'
import { findMatches, fold } from './fold'

describe('fold (AC-6.4: ignore case and accents)', () => {
  it('folds case and accents so "perché" matches "PERCHE"', () => {
    expect(fold('perché')).toBe(fold('PERCHE'))
    expect(fold('Café')).toBe('cafe')
  })

  it('folds a decomposed accent the same as a precomposed one', () => {
    expect(fold('é')).toBe(fold('é'))
  })
})

describe('findMatches', () => {
  it('returns the ranges of the ORIGINAL text, whatever the case and accents of query and text', () => {
    const text = 'Perché the CAFÉ, perche?'
    expect(findMatches(text, 'PERCHE')).toEqual([
      { start: 0, end: 6 },
      { start: 17, end: 23 },
    ])
    expect(findMatches(text, 'café').map((m) => text.slice(m.start, m.end))).toEqual(['CAFÉ'])
  })

  it('a decomposed accent in the text is covered whole by the match', () => {
    const text = 'café ok'
    const [m] = findMatches(text, 'cafe')
    expect(text.slice(m!.start, m!.end)).toBe('café')
  })

  it('counts non-overlapping matches', () => {
    expect(findMatches('aaaa', 'aa')).toHaveLength(2)
  })

  it('an empty or blank query matches nothing', () => {
    expect(findMatches('abc', '')).toEqual([])
    expect(findMatches('abc', '   ')).toEqual([])
  })

  it('treats the query literally (no regular-expression meaning)', () => {
    expect(findMatches('a.c abc', 'a.c')).toEqual([{ start: 0, end: 3 }])
  })
})
