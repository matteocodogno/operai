import type { Activity, Release, ReleaseSummary } from '../types'

export type WarningCode = 'no-profile' | 'high-risk' | 'no-activities' | 'wide-range'

export const WARNING_META: Record<WarningCode, { icon: string; colorClass: string; title: string }> = {
  'no-profile':    { icon: '⊘', colorClass: 'text-muted',  title: 'No profile assigned' },
  'high-risk':     { icon: '⚠', colorClass: 'text-org',    title: 'Risk buffer exceeds 50% of expected' },
  'no-activities': { icon: '⊘', colorClass: 'text-muted',  title: 'Release has no activities' },
  'wide-range':    { icon: '⚠', colorClass: 'text-org',    title: 'Worst case is more than 2× best case' },
}

function pertCalc(o: number, ml: number, p: number): number {
  return ((Number(o) || 0) + 4 * (Number(ml) || 0) + (Number(p) || 0)) / 6
}

export interface HealthWarnings {
  /** warnings keyed by activity id */
  activityWarnings: Map<string, WarningCode[]>
  /** warnings keyed by release id */
  releaseWarnings: Map<string, WarningCode[]>
  activityCount: number
  releaseCount: number
  totalCount: number
}

export function computeHealthWarnings(
  activities: Activity[],
  releases: Release[],
  summary: ReleaseSummary[],
): HealthWarnings {
  const activityWarnings = new Map<string, WarningCode[]>()

  for (const a of activities) {
    const ws: WarningCode[] = []
    if (!a.prof) ws.push('no-profile')
    if (Number(a.risk) > pertCalc(a.o, a.ml, a.p)) ws.push('high-risk')
    if (ws.length) activityWarnings.set(a.id, ws)
  }

  const releaseWarnings = new Map<string, WarningCode[]>()

  for (const rel of releases) {
    const ws: WarningCode[] = []
    if (!activities.some(a => a.release === rel.name)) ws.push('no-activities')
    const s = summary.find(r => r.name === rel.name)
    if (s?.res && s.res.worst > 2 * s.res.best) ws.push('wide-range')
    if (ws.length) releaseWarnings.set(rel.id, ws)
  }

  const activityCount = [...activityWarnings.values()].reduce((n, ws) => n + ws.length, 0)
  const releaseCount  = [...releaseWarnings.values()].reduce((n, ws) => n + ws.length, 0)

  return { activityWarnings, releaseWarnings, activityCount, releaseCount, totalCount: activityCount + releaseCount }
}
