import type { Activity } from '../types'

/**
 * Derives a "epic.activity" number for every activity based on their position
 * in the flat list. Epic index = first-appearance order (1-based); activity
 * index = position within that epic (1-based).
 *
 * Example: 2nd epic, 3rd activity → "2.3"
 */
export function computeActivityNums(activities: Activity[]): Map<string, string> {
  const epicOrder: string[] = []
  const seen = new Set<string>()
  for (const a of activities) {
    if (!seen.has(a.epic)) {
      seen.add(a.epic)
      epicOrder.push(a.epic)
    }
  }

  const groups = new Map<string, Activity[]>()
  for (const a of activities) {
    if (!groups.has(a.epic)) groups.set(a.epic, [])
    groups.get(a.epic)!.push(a)
  }

  const nums = new Map<string, string>()
  epicOrder.forEach((epicKey, ei) => {
    groups.get(epicKey)!.forEach((a, ai) => {
      nums.set(a.id, `${ei + 1}.${ai + 1}`)
    })
  })
  return nums
}
