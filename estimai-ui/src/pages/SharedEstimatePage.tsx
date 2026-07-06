import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { getHashData, decodeEstimate } from '../lib/shareUrl'
import { useEstimator } from '../hooks/useEstimator'
import { saveProjectData, uid } from '../lib/projects'
import MetricsBar from '../components/MetricsBar'
import { pertCalc } from '../hooks/useEstimator'
import { computeActivityNums } from '../lib/activityNums'
import type { Activity, Parameters } from '../types'

function ReadOnlyActivityTable({ activities }: { activities: Activity[] }) {
  const nums = useMemo(() => computeActivityNums(activities), [activities])

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[780px] text-[11px]">
        <thead>
          <tr className="bg-ink-mid text-[9px] font-mono text-soft uppercase tracking-[0.06em]">
            {['#', 'Epic', 'Activity', 'Profile', 'O', 'ML', 'P', 'PERT', 'Risk', 'Exp.', 'Release'].map((h, i) => (
              <th key={h} className={`py-1.5 px-2 font-normal ${i > 3 ? 'text-right' : 'text-left'} whitespace-nowrap`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {activities.map((a, idx) => {
            const pert = pertCalc(a.o, a.ml, a.p)
            const exp  = pert + (Number(a.risk) || 0)
            const risky = Number(a.risk) > pert
            return (
              <tr
                key={a.id}
                className={`border-b border-rule ${risky ? 'bg-[rgba(245,166,35,.04)]' : idx % 2 === 0 ? 'bg-ink-soft' : 'bg-ink'}`}
              >
                <td className="py-1.5 px-2 font-mono text-muted">{nums.get(a.id) ?? ''}</td>
                <td className="py-1.5 px-2 text-soft">{a.epic}</td>
                <td className="py-1.5 px-2 font-medium">{a.act}</td>
                <td className="py-1.5 px-2 text-soft">{a.prof}</td>
                <td className="py-1.5 px-2 text-right font-mono text-grn">{a.o}</td>
                <td className="py-1.5 px-2 text-right font-mono">{a.ml}</td>
                <td className="py-1.5 px-2 text-right font-mono text-red">{a.p}</td>
                <td className="py-1.5 px-2 text-right font-mono text-acc-hi">{pert.toFixed(1)}</td>
                <td className={`py-1.5 px-2 text-right font-mono ${risky ? 'text-org' : ''}`}>{a.risk}</td>
                <td className="py-1.5 px-2 text-right font-mono font-semibold">{exp.toFixed(1)}</td>
                <td className="py-1.5 px-2 text-soft">{a.release}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function SharedEstimatePage() {
  const navigate = useNavigate()
  const [imported, setImported] = useState(false)

  const data = useMemo(() => {
    const encoded = getHashData()
    if (!encoded) return null
    return decodeEstimate(encoded)
  }, [])

  const { summary, totals, byProfile } = useEstimator(
    data?.acts ?? [],
    data?.releases ?? [],
    data?.params ?? {} as Parameters,
  )

  function handleImport() {
    if (!data) return
    const newId = uid()
    saveProjectData({ ...data, id: newId })
    setImported(true)
    setTimeout(() => navigate({ to: '/estimates/$estimateId', params: { estimateId: newId } }), 800)
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-3xl mb-3 opacity-30">⚠</div>
          <p className="text-sm text-muted">Invalid or missing share data.</p>
          <button
            onClick={() => navigate({ to: '/estimates' })}
            className="mt-4 text-acc underline text-sm"
          >
            Go to My Estimates
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full w-full">
      {/* Header */}
      <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
        <div className="flex items-center h-14 gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <img src="/estimai.svg" alt="EstimAI" className="h-8 w-8 rounded-md" />
            <span className="text-[10px] font-mono text-muted hidden sm:block">Powered by EstimAI</span>
          </div>
          <div className="flex-1 flex items-center justify-center gap-3">
            <span className="text-[14px] font-medium text-text">{data.name || 'Untitled'}</span>
            {data.author && <span className="text-[12px] text-muted">{data.author}</span>}
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-rule text-muted">
              read-only
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleImport}
              disabled={imported}
              className="py-1 px-2.5 text-[11px] font-medium text-grn border border-grn/30 hover:border-grn hover:bg-grn/5 transition-colors disabled:opacity-50"
            >
              {imported ? '✓ Saved' : '↓ Save to My Estimates'}
            </button>
            <button
              onClick={() => navigate({ to: '/estimates' })}
              className="text-muted text-sm py-1 px-2.5 border border-rule hover:text-text transition-colors"
            >
              ☰ My Estimates
            </button>
          </div>
        </div>
      </header>

      <MetricsBar
        totals={totals}
        activityCount={data.acts.length}
        releaseCount={data.releases.length}
        profileCount={byProfile.length}
      />

      <main className="p-5 px-5.5">
        <h2 className="font-disp text-sm font-bold mb-3">Activities</h2>
        <ReadOnlyActivityTable activities={data.acts} />

        <h2 className="font-disp text-sm font-bold mt-6 mb-3">Release Summary</h2>
        <div className="overflow-x-auto">
          <table className="text-xs min-w-[600px]">
            <thead>
              <tr>
                {['Release', 'FTE', 'Elapsed d', 'Total M/D', 'Months', 'Best', 'Worst', 'Range'].map((h, i) => (
                  <th key={h} className={`py-2 px-2.5 text-[9px] font-mono text-soft uppercase tracking-[0.06em] border-b border-rule bg-ink-mid whitespace-nowrap ${i > 0 ? 'text-right' : 'text-left'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.map((s, idx) => (
                <tr key={s.id} className={`border-b border-rule ${idx % 2 === 0 ? 'bg-ink-soft' : 'bg-ink'}`}>
                  <td className="py-2 px-2.5 font-mono text-xs">{s.name}</td>
                  <td className="py-2 px-2.5 font-mono text-xs text-right text-soft">{s.fte}</td>
                  {s.res ? (
                    <>
                      <td className="py-2 px-2.5 font-mono text-xs text-right text-acc-hi font-semibold">{s.res.el}</td>
                      <td className="py-2 px-2.5 font-mono text-xs text-right font-semibold">{s.res.tm}</td>
                      <td className="py-2 px-2.5 font-mono text-xs text-right text-grn">{s.res.mo}</td>
                      <td className="py-2 px-2.5 font-mono text-xs text-right text-grn">{s.res.best}</td>
                      <td className="py-2 px-2.5 font-mono text-xs text-right text-red">{s.res.worst}</td>
                      <td className="py-2 px-2.5 text-right">
                        <span className="font-mono text-[11px] bg-[rgba(245,166,35,0.12)] text-org py-[3px] px-[7px] rounded">
                          {s.res.best}–{s.res.worst}d
                        </span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={6} className="py-2 px-2.5 text-center text-muted text-[11px] italic">No activities</td>
                  )}
                </tr>
              ))}
              <tr className="bg-ink-mid border-t-2 border-acc">
                <td className="py-2 px-2.5 font-disp font-bold text-[11px]">TOTAL</td>
                <td />
                <td className="py-2 px-2.5 font-mono text-xs text-right text-acc-hi font-bold">{totals.el}</td>
                <td className="py-2 px-2.5 font-mono text-xs text-right font-bold">{totals.tm}</td>
                <td className="py-2 px-2.5 font-mono text-xs text-right text-grn font-bold">{totals.mo}</td>
                <td className="py-2 px-2.5 font-mono text-xs text-right text-grn font-bold">{totals.best}</td>
                <td className="py-2 px-2.5 font-mono text-xs text-right text-red font-bold">{totals.worst}</td>
                <td className="py-2 px-2.5 text-right">
                  <span className="font-mono text-xs bg-[rgba(245,166,35,0.15)] text-org py-1 px-[9px] rounded font-semibold">
                    {totals.best}–{totals.worst}d
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
