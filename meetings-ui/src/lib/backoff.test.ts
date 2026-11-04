import { describe, expect, it } from 'vitest'
import { delaySequence, nextDelay } from './backoff'

describe('nextDelay', () => {
  it('multiplies by the factor and rounds to whole milliseconds', () => {
    expect(nextDelay(2000, { factor: 1.5, maxMs: 30000 })).toBe(3000)
    expect(nextDelay(1001, { factor: 1.5, maxMs: 30000 })).toBe(1502)
  })

  it('never exceeds the cap', () => {
    expect(nextDelay(20000, { factor: 2, maxMs: 30000 })).toBe(30000)
    expect(nextDelay(30000, { factor: 2, maxMs: 30000 })).toBe(30000)
  })

  it('never shrinks below the current delay (a factor under 1 would busy-loop)', () => {
    expect(nextDelay(2000, { factor: 0.5, maxMs: 30000 })).toBe(2000)
  })

  it('a cap below the current delay still wins', () => {
    expect(nextDelay(5000, { factor: 2, maxMs: 4000 })).toBe(4000)
  })
})

describe('delaySequence', () => {
  it('starts at the base and grows to the cap', () => {
    expect(delaySequence({ baseMs: 2000, factor: 2, maxMs: 10000 }, 5)).toEqual([2000, 4000, 8000, 10000, 10000])
  })
})
