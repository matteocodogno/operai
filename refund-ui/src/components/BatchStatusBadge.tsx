/**
 * BatchStatusBadge — glyph + text + color state indicator for a compilation
 * batch's lifecycle status (T10, specs/008-refund-monthly-processing/tasks.md;
 * design.md Component inventory: "BatchStatusBadge — NEW, small — 3 variants
 * (compiled/paid/discarded) — no existing badge models a 3-value
 * batch-lifecycle state; mirrors RequestStatusBadge's glyph+text+color
 * convention in its own file").
 *
 * Three variants, matching `BatchStatus` verbatim (`batchesApi.ts`):
 * `compiled` (the active, actionable state — a batch awaiting Mark-as-paid or
 * Discard), `paid` (terminal, successful), `discarded` (terminal, voided —
 * its requests were released back to the candidate pool).
 *
 * `paid` deliberately reuses the SAME glyph (◆) `RequestStatusBadge`'s own
 * `paid` variant uses (design.md: "Both badge families use the SAME glyph for
 * their respective terminal-settled states … reinforcing visually that
 * they're the same real-world event seen from two angles"). Color is never
 * the only signal — same convention every other badge in this suite follows
 * (`RequestStatusBadge`/`EntityBadge`/`CurrencyBadge`): every variant pairs a
 * glyph with its label text.
 *
 * Copy sourced from `strings.ts` (no hardcoded UI strings).
 */

import { strings } from '../strings'
import type { BatchStatus } from '../lib/batchesApi'

const CONFIG: Record<BatchStatus, { glyph: string; color: string }> = {
  compiled: { glyph: '▤', color: 'var(--acc)' },
  paid: { glyph: '◆', color: 'var(--grn)' },
  discarded: { glyph: '✕', color: 'var(--muted)' },
}

export type BatchStatusBadgeProps = {
  status: BatchStatus
}

export default function BatchStatusBadge({ status }: BatchStatusBadgeProps) {
  const { glyph, color } = CONFIG[status]
  const label = strings.badges.batchStatus[status]

  return (
    <span
      data-testid="batch-status-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
