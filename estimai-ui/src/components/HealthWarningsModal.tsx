import { useEffect } from 'react'
import type { Activity, Release } from '../types'
import { type WarningCode, WARNING_META } from '../lib/healthWarnings'
import { computeActivityNums } from '../lib/activityNums'

interface Props {
  activityWarnings: Map<string, WarningCode[]>
  releaseWarnings: Map<string, WarningCode[]>
  activities: Activity[]
  releases: Release[]
  onClose: () => void
}

function WarnBadge({ code }: { code: WarningCode }) {
  const m = WARNING_META[code]
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${m.colorClass}`}>
      <span>{m.icon}</span>
      <span>{m.title}</span>
    </span>
  )
}

export default function HealthWarningsModal({
  activityWarnings, releaseWarnings, activities, releases, onClose,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activityNums = computeActivityNums(activities)
  const warnedActivities = activities.filter(a => activityWarnings.has(a.id))
  const warnedReleases   = releases.filter(r => releaseWarnings.has(r.id))
  const totalCount = [...activityWarnings.values()].reduce((n, ws) => n + ws.length, 0)
                   + [...releaseWarnings.values()].reduce((n, ws) => n + ws.length, 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-rule shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="font-disp text-sm font-bold">Health Warnings</h2>
            {totalCount > 0 && (
              <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-org/20 text-org">
                {totalCount}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none transition-colors">×</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4">
          {totalCount === 0 ? (
            <div className="text-center py-10">
              <div className="text-2xl mb-2">✓</div>
              <p className="text-sm text-grn font-medium">All clear — no warnings</p>
              <p className="text-[11px] text-muted mt-1">Every activity and release looks healthy.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Activity warnings */}
              {warnedActivities.length > 0 && (
                <section>
                  <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-2">
                    Activities ({[...activityWarnings.values()].reduce((n, ws) => n + ws.length, 0)})
                  </p>
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-rule">
                        <th className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider w-8">#</th>
                        <th className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider">Activity</th>
                        <th className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider">Warning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {warnedActivities.map(a => {
                        const codes = activityWarnings.get(a.id)!
                        return codes.map((code, ci) => (
                          <tr key={`${a.id}-${code}`} className="border-b border-rule/50">
                            {ci === 0 && (
                              <>
                                <td className="py-1.5 px-2 font-mono text-muted" rowSpan={codes.length}>
                                  {activityNums.get(a.id) ?? '—'}
                                </td>
                                <td className="py-1.5 px-2" rowSpan={codes.length}>
                                  <div className="font-medium text-text truncate max-w-[160px]">{a.act || '(unnamed)'}</div>
                                  {a.epic && <div className="text-[10px] text-muted">{a.epic}</div>}
                                </td>
                              </>
                            )}
                            <td className="py-1.5 px-2">
                              <WarnBadge code={code} />
                            </td>
                          </tr>
                        ))
                      })}
                    </tbody>
                  </table>
                </section>
              )}

              {/* Release warnings */}
              {warnedReleases.length > 0 && (
                <section>
                  <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-2">
                    Releases ({[...releaseWarnings.values()].reduce((n, ws) => n + ws.length, 0)})
                  </p>
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-rule">
                        <th className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider">Release</th>
                        <th className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider">Warning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {warnedReleases.map(r => {
                        const codes = releaseWarnings.get(r.id)!
                        return codes.map((code, ci) => (
                          <tr key={`${r.id}-${code}`} className="border-b border-rule/50">
                            {ci === 0 && (
                              <td className="py-1.5 px-2 font-medium text-text" rowSpan={codes.length}>
                                {r.name || '(unnamed)'}
                              </td>
                            )}
                            <td className="py-1.5 px-2">
                              <WarnBadge code={code} />
                            </td>
                          </tr>
                        ))
                      })}
                    </tbody>
                  </table>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
