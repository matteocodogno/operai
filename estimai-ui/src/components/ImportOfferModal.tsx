/**
 * ImportOfferModal — three-phase modal for the one-time legacy localStorage
 * import offer (US-5, AC-5.1, AC-5.2, AC-5.3, AC-5.4).
 *
 * Phases:
 *   1. offer      — lists found estimates; "Import all" and "Skip for now" actions
 *   2. importing  — spinner while POST /estimates/import is in-flight; Escape
 *                   suppressed, close button hidden (per design.md Screen D a11y)
 *   3. results    — per-estimate outcome table; status shown with glyph + text
 *                   (never colour alone); "Close" action
 *
 * Presentational: all data and callbacks arrive via props. The container
 * (EstimatesPage / useImportOffer) owns the logic — this component only renders.
 *
 * A11y (design.md):
 *   • role="dialog" aria-modal="true" aria-labelledby="import-modal-title"
 *   • Focus trap: on open, primary action receives focus via autoFocus
 *   • Escape = Skip during offer phase; suppressed during importing phase
 *   • aria-live="polite" results region announced once when results arrive
 *   • Status badges: glyph (✓ / !) + text, not colour alone
 *   • <table> with <th scope="col"> for results columns
 */

import { useEffect, useRef } from 'react'
import type { EstimateImportResult } from '../lib/estimatesApi'
import type { ProjectMeta } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportPhase = 'offer' | 'importing' | 'results'

export type ImportOfferModalProps = {
  /** Local estimate metadata — drives the offer count + name preview. */
  localEstimates: ProjectMeta[]
  /** Current phase of the 3-step flow. */
  phase: ImportPhase
  /** Results returned by POST /estimates/import (only non-null in "results" phase). */
  results: EstimateImportResult[] | null
  /** Called when the user clicks "Import all". */
  onAccept: () => void
  /** Called when the user clicks "Skip for now", the "×" close, or presses Escape. */
  onDecline: () => void
  /** Called when the user clicks "Close" in the results phase. */
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Single status badge — glyph + text so colour is never the only indicator. */
const StatusBadge = ({ status }: { status: 'imported' | 'failed' }) => {
  if (status === 'imported') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-grn bg-grn/10 px-1.5 py-0.5 rounded">
        <span aria-hidden="true">✓</span>
        <span>Imported</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-org bg-org/10 px-1.5 py-0.5 rounded">
      <span aria-hidden="true">!</span>
      <span>Failed</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ImportOfferModal({
  localEstimates,
  phase,
  results,
  onAccept,
  onDecline,
  onClose,
}: ImportOfferModalProps) {
  const primaryBtnRef = useRef<HTMLButtonElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const n = localEstimates.length

  // Focus management: focus the primary action on mount and on phase change.
  useEffect(() => {
    if (phase === 'offer' || phase === 'importing') {
      primaryBtnRef.current?.focus()
    } else {
      closeBtnRef.current?.focus()
    }
  }, [phase])

  // Keyboard handler: Escape = decline in offer phase; suppressed during importing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (phase === 'offer') onDecline()
      if (phase === 'results') onClose()
      // During 'importing': no action (Escape suppressed per design.md a11y spec)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onDecline, onClose])

  // Derived counts for the results phase.
  const importedCount = results?.filter((r) => r.status === 'imported').length ?? 0
  const totalCount = results?.length ?? 0
  const allSuccess = importedCount === totalCount && totalCount > 0

  // Results summary colour: green if all imported, amber otherwise.
  const summaryClass = allSuccess ? 'text-grn' : 'text-org'

  // Header title per phase.
  const title =
    phase === 'offer'
      ? 'Import your local estimates'
      : phase === 'importing'
        ? 'Importing estimates…'
        : allSuccess
          ? 'Import complete'
          : 'Import finished'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      /* Clicking the backdrop = decline (only during offer phase; during importing
         the close button is hidden so the backdrop also does nothing meaningful). */
      onClick={phase === 'offer' ? onDecline : phase === 'results' ? onClose : undefined}
      data-testid="import-offer-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-md mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-rule shrink-0">
          <h2
            id="import-modal-title"
            className="font-disp text-sm font-bold text-text"
          >
            {title}
          </h2>
          {/* Close / × button: hidden during importing to prevent premature cancel */}
          {phase !== 'importing' && (
            <button
              onClick={phase === 'offer' ? onDecline : onClose}
              className="text-muted hover:text-text text-lg leading-none transition-colors"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Body                                                             */}
        {/* ---------------------------------------------------------------- */}
        <div className="px-5 py-4 flex flex-col gap-4">

          {/* PHASE: offer */}
          {phase === 'offer' && (
            <>
              <p className="text-sm text-text leading-relaxed">
                <span className="font-semibold text-acc">{n} estimate{n !== 1 ? 's' : ''}</span>
                {' '}found in this browser that {n !== 1 ? 'are' : 'is'} not yet in your account.
                Import {n !== 1 ? 'them' : 'it'} now to access from any device.
                Your local copies are always kept.
              </p>

              {/* Name preview — up to 3 names */}
              {localEstimates.length > 0 && (
                <ul className="flex flex-col gap-0.5">
                  {localEstimates.slice(0, 3).map((p) => (
                    <li
                      key={p.id}
                      className="text-[11px] text-soft font-mono truncate"
                    >
                      · {p.name || 'Untitled'}
                    </li>
                  ))}
                  {localEstimates.length > 3 && (
                    <li className="text-[11px] text-muted font-mono">
                      + {localEstimates.length - 3} more
                    </li>
                  )}
                </ul>
              )}
            </>
          )}

          {/* PHASE: importing */}
          {phase === 'importing' && (
            <div className="flex items-center gap-3 py-2" aria-live="polite">
              <span
                className="inline-block w-4 h-4 border-2 border-acc border-t-transparent rounded-full animate-spin shrink-0"
                aria-hidden="true"
              />
              <span className="text-sm text-text">
                Importing {n} estimate{n !== 1 ? 's' : ''}…
              </span>
            </div>
          )}

          {/* PHASE: results */}
          {phase === 'results' && results && (
            <>
              {/* aria-live region — announced once when results arrive */}
              <p className={`text-sm font-medium ${summaryClass}`} aria-live="polite">
                {importedCount} of {totalCount} imported successfully.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-rule">
                      <th
                        scope="col"
                        className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider"
                      >
                        Estimate
                      </th>
                      <th
                        scope="col"
                        className="text-left py-1 px-2 text-[9px] font-mono text-soft uppercase tracking-wider"
                      >
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, idx) => {
                      // Match result back to the local estimate by localId for the name.
                      const meta = localEstimates.find((p) => p.id === r.localId)
                      const name = meta?.name || r.localId
                      return (
                        <tr key={r.localId ?? idx} className="border-b border-rule/50">
                          <td className="py-1.5 px-2 font-medium text-text max-w-[200px] truncate">
                            {name || 'Untitled'}
                          </td>
                          <td className="py-1.5 px-2">
                            <StatusBadge status={r.status} />
                            {r.status === 'failed' && r.error && (
                              <div className="text-muted text-[10px] mt-0.5 truncate max-w-[180px]">
                                {r.error}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] text-muted">
                Your local copies have not been removed.
              </p>
            </>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Footer actions                                                   */}
        {/* ---------------------------------------------------------------- */}
        <div className="px-5 pb-4 pt-2 flex items-center justify-end gap-3 shrink-0">
          {phase === 'offer' && (
            <>
              <button
                onClick={onDecline}
                className="text-sm text-muted hover:text-text transition-colors"
              >
                Skip for now
              </button>
              <button
                ref={primaryBtnRef}
                onClick={onAccept}
                autoFocus
                className="py-2 px-4 text-sm font-medium text-white bg-acc hover:bg-acc/90 transition-colors"
              >
                Import all
              </button>
            </>
          )}

          {phase === 'importing' && (
            /* Invisible placeholder to keep footer height stable */
            <span ref={primaryBtnRef as React.RefObject<HTMLSpanElement>} aria-hidden="true" />
          )}

          {phase === 'results' && (
            <button
              ref={closeBtnRef}
              onClick={onClose}
              autoFocus
              data-testid="import-results-close"
              className="py-2 px-4 text-sm font-medium border border-acc text-acc hover:bg-acc/10 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
