/**
 * SubmitValidationSummary — lists the expense lines a `422 POST
 * /requests/:id/submit` named as incomplete (T16, specs/007-refund-service/
 * tasks.md, AC-1.6; design.md F2 step 1: "a SubmitValidationSummary banner
 * lists exactly the offending line ids the response body names, each entry
 * a jump link that scrolls to and focuses the corresponding ExpenseLineRow —
 * the draft stays fully editable, nothing is lost").
 *
 * Presentational: `RequestDetailPage` resolves each offending line id to a
 * short, human-readable label (date · motivo, or a bare-id fallback if the
 * line can't be found — defensive, should not happen in practice) and
 * supplies `onJump`, which is responsible for both scrolling the
 * corresponding `ExpenseLineRow` into view AND moving focus to it (the two
 * together — scroll alone would leave a screen-reader/keyboard user without
 * a landing point).
 *
 * A11y: `role="alert"` — mirrors `ErrorBanner`'s "announce immediately"
 * contract, since a blocked submit is exactly that kind of failure. Each
 * jump link is a real `<button>` (not a bare `<a href="#…">`) since it
 * performs a focus-move side effect, not real in-page navigation.
 */

import { strings } from '../strings'

export type SubmitValidationSummaryItem = {
  lineId: string
  /** Short human-readable label for the line, e.g. "16 Jul 2026 · Client visit". */
  label: string
}

export type SubmitValidationSummaryProps = {
  items: readonly SubmitValidationSummaryItem[]
  onJump: (lineId: string) => void
}

export default function SubmitValidationSummary({ items, onJump }: SubmitValidationSummaryProps) {
  const t = strings.pages.requestDetail.validationSummary

  if (items.length === 0) return null

  return (
    <div
      role="alert"
      data-testid="submit-validation-summary"
      className="px-4 py-3 rounded-md border text-sm"
      style={{
        borderColor: 'var(--org)',
        backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
        color: 'var(--org)',
      }}
    >
      <p className="font-medium mb-2">{t.heading}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.lineId}>
            <button
              type="button"
              onClick={() => onJump(item.lineId)}
              data-testid={`submit-validation-summary-jump-${item.lineId}`}
              className="text-sm underline underline-offset-2 transition-opacity hover:opacity-80"
              style={{ color: 'var(--org)' }}
            >
              {t.jumpLinkLabel(item.label)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
