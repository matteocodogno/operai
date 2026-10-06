/**
 * splitPrice (T30, specs/015-hardware-inventory; AC-1.3): each unit is the total
 * divided by N rounded down to the cent, the remaining cents go on the LAST unit,
 * so the N prices sum exactly to the total. Mirrors inventory-api's rule (task
 * T8); both assert the identical vectors in `split-vectors.json`.
 */
import { describe, expect, it } from 'vitest'
import { splitPrice } from './splitPrice'
import vectors from './split-vectors.json'

describe('splitPrice', () => {
  it.each(vectors.vectors)(
    '$totalCents / $quantity -> $eachCents each, last $lastCents (shared vector)',
    ({ totalCents, quantity, eachCents, lastCents }) => {
      const prices = splitPrice(totalCents, quantity)

      expect(prices).toHaveLength(quantity)
      expect(prices.slice(0, -1).every((price) => price === eachCents)).toBe(true)
      expect(prices.at(-1)).toBe(lastCents)
      expect(prices.reduce((sum, price) => sum + price, 0)).toBe(totalCents)
    },
  )

  it('covers the 294635 / 13 vector the spec calls out', () => {
    expect(vectors.vectors.some((v) => v.totalCents === 294635 && v.quantity === 13)).toBe(true)
  })

  it('sums exactly to the total for every quantity 1..200 over a spread of totals', () => {
    for (const total of [1, 7, 99, 100, 12345, 294635, 99999999]) {
      for (let quantity = 1; quantity <= 200; quantity += 1) {
        const prices = splitPrice(total, quantity)
        expect(prices.reduce((sum, price) => sum + price, 0)).toBe(total)
        expect(prices.at(-1)!).toBeGreaterThanOrEqual(prices[0])
      }
    }
  })

  it.each([
    [1.5, 2],
    [100, 0],
    [100, 2.5],
    [-1, 2],
    [100, -3],
    [Number.NaN, 2],
  ])('refuses %s / %s rather than invent a price', (total, quantity) => {
    expect(() => splitPrice(total, quantity)).toThrow(RangeError)
  })
})
