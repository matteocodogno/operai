import type { Totals } from '../types'

interface MetricProps {
  label: string
  val: string | number
  sub?: string
  colorClass: string
}

function Metric({ label, val, sub, colorClass }: MetricProps) {
  return (
    <div className="bg-ink-soft border border-rule rounded-[10px] py-[13px] px-4 flex-1 min-w-[120px]">
      <div className="text-[10px] text-soft font-mono tracking-[0.06em] uppercase mb-[5px]">{label}</div>
      <div className={`font-mono text-[22px] font-medium leading-none ${colorClass}`}>{val}</div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  )
}

interface MetricsBarProps {
  totals: Totals
  activityCount: number
  releaseCount: number
  profileCount: number
}

export default function MetricsBar({ totals, activityCount, releaseCount, profileCount }: MetricsBarProps) {
  return (
    <div className="bg-ink-soft border-b border-rule py-2.5 px-[22px] flex gap-2.5 flex-wrap">
      <Metric label="Total Man/Days" val={totals.tm} sub="across all releases" colorClass="text-acc-hi" />
      <Metric label="Elapsed Calendar" val={`${totals.el}d`} sub={`≈ ${totals.mo} months`} colorClass="text-grn" />
      <Metric
        label="Confidence Range"
        val={`${totals.best}–${totals.worst}`}
        sub="days (best – worst case)"
        colorClass="text-org"
      />
      <Metric
        label="AI Cost (total)"
        val={totals.aiCost.toLocaleString()}
        sub="coeff × FTE × elapsed days"
        colorClass="text-[#b47fff]"
      />
      <Metric
        label="AI-assisted Elapsed"
        val={`${totals.aiElapsed}d`}
        sub={`vs ${totals.el}d standard (−${totals.el - totals.aiElapsed}d)`}
        colorClass="text-[#b47fff]"
      />
      <Metric
        label="Activities"
        val={activityCount}
        sub={`${releaseCount} releases · ${profileCount} profiles`}
        colorClass="text-soft"
      />
    </div>
  )
}
