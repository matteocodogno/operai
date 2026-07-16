/**
 * MonthlyProcessingNote — fixed-copy informational banner rendered only
 * inside an `approved` request's detail (T16, specs/007-refund-service/
 * tasks.md, design.md F4/US-4: "renders only inside an approved request's
 * detail … structurally absent — not hidden, not empty — from every
 * draft/submitted render path (AC-4.2)").
 *
 * AC-4.1 explicitly bans promising a cutoff date or a payout amount — the
 * copy here (`strings.ts`) is fixed and carries neither; there is no prop
 * for a date/amount to be injected, by design, so a future edit can't
 * accidentally reintroduce one.
 *
 * "Structurally absent, not hidden": callers must not render this component
 * at all for a non-`approved` request (e.g. `{status === 'approved' &&
 * <MonthlyProcessingNote />}`), never render it with `display:none`/a
 * falsy-but-present branch — this component has no internal visibility
 * toggle to misuse.
 *
 * Not alert-toned (unlike `ErrorBanner`, whose layout this borrows) — a
 * neutral `--acc`/`--soft` palette, since this is informational, not an
 * error (design.md Component inventory).
 */

import { strings } from '../strings'

export default function MonthlyProcessingNote() {
  const t = strings.pages.requestDetail.monthlyNote

  return (
    <div
      data-testid="monthly-processing-note"
      className="px-4 py-3 rounded-md border text-sm"
      style={{
        borderColor: 'var(--acc)',
        backgroundColor: 'color-mix(in srgb, var(--acc) 8%, transparent)',
        color: 'var(--text)',
      }}
    >
      <p className="font-medium mb-1" style={{ color: 'var(--acc)' }}>
        {t.heading}
      </p>
      <p style={{ color: 'var(--soft)' }}>{t.body}</p>
    </div>
  )
}
