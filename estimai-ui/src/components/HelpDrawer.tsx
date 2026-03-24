import { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  onClose: () => void
}

export default function HelpDrawer({ onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative z-10 w-[380px] h-full bg-ink-soft border-l border-rule shadow-2xl flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-rule shrink-0">
          <div>
            <h2 className="font-disp text-sm font-bold">Model Reference</h2>
            <p className="text-[11px] text-muted mt-0.5">Formulas, calculation chain, glossary</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 text-xs text-soft leading-relaxed">

          <section>
            <h3 className="font-disp text-[10px] font-bold text-text uppercase tracking-[0.08em] mb-3">
              Calculation chain
            </h3>
            <div className="space-y-1 leading-[1.95]">
              <div><strong className="text-acc-hi">PERT</strong> = (O + 4×ML + P) / 6</div>
              <div className="text-muted pl-3 text-[10px] -mt-0.5 mb-1">
                Intermediate only — Summary uses Expected, not PERT.
              </div>
              <div><strong>Expected</strong> = PERT + Risk Buffer</div>
              <div><strong>Individual M/D</strong> = Σ Expected + QA Deploy + QA Test + PM</div>
              <div><strong>Planning</strong> = FTE × (Individual / Sprint) / 8</div>
              <div><strong>Baseline</strong> = Individual + Planning</div>
              <div><strong>Elapsed Days</strong> = ROUND(Baseline × (1 − Parallel × (FTE−1) / FTE))</div>
              <div><strong>Total Man/Days</strong> = Elapsed × FTE</div>
              <div><strong>Months</strong> = Elapsed / Working days per month</div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[10px] font-bold text-text uppercase tracking-[0.08em] mb-3">
              AI columns
            </h3>
            <div className="space-y-1 leading-[1.95]">
              <div><strong>AI-assisted days</strong> = Expected × (1 − AI Gain)</div>
              <div className="text-muted pl-3 text-[10px] -mt-0.5 mb-1">
                Resolved per activity (activity override → global default).
                Same pipeline applied to derive AI elapsed and total M/D.
              </div>
              <div><strong>AI Cost</strong> = Coefficient × FTE × Elapsed Days</div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[10px] font-bold text-text uppercase tracking-[0.08em] mb-3">
              Confidence range
            </h3>
            <div className="space-y-1 leading-[1.95]">
              <div><strong>Best case</strong> = full chain on Optimistic estimates</div>
              <div><strong>Worst case</strong> = full chain on Pessimistic estimates</div>
              <div className="text-muted pl-3 text-[10px] -mt-0.5">
                When only ML is entered: O = ML × 0.75, P = ML × 1.60
              </div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[10px] font-bold text-text uppercase tracking-[0.08em] mb-3">
              Glossary
            </h3>
            <div className="space-y-2">
              {([
                ['estimate',  'Top-level document: project + releases + activities'],
                ['release',   'Delivery milestone with a name and FTE count'],
                ['activity',  'Single unit of work — belongs to an epic and a release'],
                ['epic',      'Feature group containing multiple activities'],
                ['profile',   'Specialist role required (e.g. Backend Dev, Designer)'],
                ['elapsed',   'Calendar days for a release after parallelism adjustment'],
                ['man/days',  'Total person-days — elapsed × FTE'],
                ['ai_gain',   'Fractional productivity improvement from AI tools (0–1)'],
              ] as const).map(([term, def]) => (
                <div key={term} className="flex gap-3">
                  <code className="text-acc-hi font-mono shrink-0 w-20 text-[10px] leading-[1.6]">{term}</code>
                  <span className="text-muted text-[10px] leading-[1.6]">{def}</span>
                </div>
              ))}
            </div>
          </section>

        </div>
      </div>
    </div>,
    document.body,
  )
}
