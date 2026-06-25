import { describe, expect, it } from 'vitest'

/**
 * Trivial vitest smoke test — proves the runner is wired correctly.
 *
 * The PERT formula is central to the estimation model (see AGENTS.md):
 *   PERT = (Optimistic + 4 × MostLikely + Pessimistic) / 6
 */
const pert = (o: number, ml: number, p: number): number => (o + 4 * ml + p) / 6

describe('pert', () => {
  it('computes the weighted average correctly', () => {
    expect(pert(1, 4, 7)).toBe(4)
  })

  it('returns MostLikely when all three values are equal', () => {
    expect(pert(3, 3, 3)).toBe(3)
  })
})
