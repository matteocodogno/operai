/**
 * MonthlyProcessingNote — a one-line footnote to an approved request's totals
 * (T16, specs/007-refund-service/tasks.md, design.md F4/US-4).
 *
 * WEIGHT. This used to be a bordered, accent-tinted panel with its own accent
 * heading — the loudest element on the page, while being the least important
 * thing on it. It says the same thing on every approved request forever; it is
 * standing background information, not news, and nothing about it is
 * actionable. It now reads as muted body text under the totals, which is where
 * it belongs: it answers "when does this figure get paid", so it is a footnote
 * to the total rather than an announcement of its own.
 *
 * AC-4.1 is unaffected by that change — it requires the UI to STATE the
 * monthly cadence, not to shout it, and the copy is untouched.
 *
 * AC-4.1 explicitly bans promising a cutoff date or a payout amount — the copy
 * here (`strings.ts`) is fixed and carries neither; there is no prop for a
 * date/amount to be injected, by design, so a future edit can't accidentally
 * reintroduce one.
 *
 * "Structurally absent, not hidden": callers must not render this component at
 * all for a non-`approved` request (e.g. `{status === 'approved' &&
 * <MonthlyProcessingNote />}`), never render it with `display:none`/a
 * falsy-but-present branch — this component has no internal visibility toggle
 * to misuse (AC-4.2).
 */

import { strings } from '../strings'

export default function MonthlyProcessingNote() {
  const t = strings.pages.requestDetail.monthlyNote

  return (
    <p
      data-testid="monthly-processing-note"
      className="text-[11px] leading-relaxed"
      style={{ color: 'var(--soft)' }}
    >
      {t.body}
    </p>
  )
}
