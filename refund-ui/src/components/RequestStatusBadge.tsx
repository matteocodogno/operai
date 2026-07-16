/**
 * RequestStatusBadge — glyph + text + color state indicator for a refund
 * request's status (T15, specs/007-refund-service/tasks.md; design.md F3
 * step 2: 'submitted — a RequestStatusBadge reading "Awaiting decision"
 * (glyph ⏳, --acc) so it never reads as approved/rejected (AC-3.4)';
 * Component inventory: "RequestStatusBadge — NEW, small — Glyph+text+color
 * convention ported from InvitationStatusBadge.tsx/SystemBadge.tsx — 4
 * variants (draft/submitted/approved/rejected)").
 *
 * Four variants, matching `RefundRequest.status` verbatim (plan.md "## Data
 * model"): `draft`/`submitted`/`approved`/`rejected`. Colour is never the
 * only signal — same convention `admin-ui/src/components/
 * InvitationStatusBadge.tsx`/`SystemBadge.tsx` already establish in this
 * suite: every variant pairs a glyph with its label text, so a
 * colorblind/low-vision/screen-reader user gets the same information a
 * sighted user gets from color alone. `submitted` is deliberately labelled
 * "Awaiting decision", not "Submitted" (AC-3.4's exact requirement) — it
 * must never be visually or textually confusable with `approved`/`rejected`.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings).
 */

import { strings } from '../strings'

export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected'

const CONFIG: Record<RequestStatus, { glyph: string; color: string }> = {
  draft: { glyph: '✎', color: 'var(--soft)' },
  submitted: { glyph: '⏳', color: 'var(--acc)' },
  approved: { glyph: '✓', color: 'var(--grn)' },
  rejected: { glyph: '✕', color: 'var(--red)' },
}

export type RequestStatusBadgeProps = {
  status: RequestStatus
}

export default function RequestStatusBadge({ status }: RequestStatusBadgeProps) {
  const { glyph, color } = CONFIG[status]
  const label = strings.badges.requestStatus[status]

  return (
    <span
      data-testid="request-status-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
