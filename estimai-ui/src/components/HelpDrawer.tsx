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
            className="w-8 h-8 flex items-center justify-center rounded text-muted hover:text-text hover:bg-ink-mid transition-colors text-xl leading-none shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 text-xs text-soft">

          <section>
            <h3 className="font-disp text-[12px] font-bold text-text uppercase tracking-[0.08em] mb-4">
              Calculation chain
            </h3>
            <div className="flex flex-col gap-3">
              <div className="leading-relaxed"><strong className="text-acc-hi">PERT</strong> = (O + 4×ML + P) / 6</div>
              <div className="pl-3 py-1.5 border-l-2 border-acc/40 bg-[rgba(91,106,247,0.07)] rounded-r text-[11px] text-soft leading-relaxed">
                Intermediate only — Summary uses <strong>Expected</strong>, not PERT.
              </div>
              <div className="leading-relaxed"><strong>Expected</strong> = PERT + Risk Buffer</div>
              <div className="leading-relaxed"><strong>Individual M/D</strong> = Σ Expected + QA Deploy + QA Test + PM</div>
              <div className="leading-relaxed"><strong>Planning</strong> = FTE × (Individual / Sprint) / 8</div>
              <div className="leading-relaxed"><strong>Baseline</strong> = Individual + Planning</div>
              <div className="leading-relaxed"><strong>Elapsed Days</strong> = ROUND(Baseline × (1 − Parallel × (FTE−1) / FTE))</div>
              <div className="leading-relaxed"><strong>Total Man/Days</strong> = Elapsed × FTE</div>
              <div className="leading-relaxed"><strong>Months</strong> = Elapsed / Working days per month</div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[12px] font-bold text-text uppercase tracking-[0.08em] mb-4">
              AI columns
            </h3>
            <div className="flex flex-col gap-3">
              <div className="leading-relaxed"><strong>AI-assisted days</strong> = Expected × (1 − AI Gain)</div>
              <div className="pl-3 py-1.5 border-l-2 border-acc/40 bg-[rgba(91,106,247,0.07)] rounded-r text-[11px] text-soft leading-relaxed">
                Resolved per activity (activity override → global default).
                Same pipeline applied for AI elapsed and total M/D.
              </div>
              <div className="leading-relaxed"><strong>AI Cost</strong> = Coefficient × FTE × Elapsed Days</div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[12px] font-bold text-text uppercase tracking-[0.08em] mb-4">
              Confidence range
            </h3>
            <div className="flex flex-col gap-3">
              <div className="leading-relaxed"><strong>Best case</strong> = full chain on Optimistic estimates</div>
              <div className="leading-relaxed"><strong>Worst case</strong> = full chain on Pessimistic estimates</div>
              <div className="pl-3 py-1.5 border-l-2 border-acc/40 bg-[rgba(91,106,247,0.07)] rounded-r text-[11px] text-soft leading-relaxed">
                When only ML is entered: O = ML × 0.75, P = ML × 1.60
              </div>
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <h3 className="font-disp text-[12px] font-bold text-text uppercase tracking-[0.08em] mb-4">
              Glossary
            </h3>
            <div className="flex flex-col gap-3">
              {([
                ['estimate',  'Top-level document: project + releases + activities'],
                ['release',   'Delivery milestone with a name and FTE count'],
                ['activity',  'Single unit of work — belongs to an epic and a release'],
                ['epic',      'Feature group containing multiple activities'],
                ['profile',   'Specialist role required (e.g. Backend Dev, Designer)'],
                ['elapsed',   'Calendar days for a release after parallelism adjustment'],
                ['man/days',  'Total person-days — elapsed × FTE'],
                ['ai_gain',   'Fractional productivity improvement from AI tools (0–1). e.g. 0.30 = 30% effort reduction'],
              ] as const).map(([term, def]) => (
                <div key={term} className="flex gap-3">
                  <code className="text-acc-hi font-mono shrink-0 w-20 text-[11px] leading-relaxed">{term}</code>
                  <span className="text-muted text-[11px] leading-relaxed">{def}</span>
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
