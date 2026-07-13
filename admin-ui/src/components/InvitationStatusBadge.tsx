import type { EffectiveInvitationStatus } from '../lib/adminApi'

/**
 * InvitationStatusBadge — glyph + text + color state indicator for an
 * invitation's effective status (T12, specs/006-user-invitations, design.md
 * "InvitationStatusBadge"). Four variants: pending/accepted/expired/revoked.
 *
 * Colour is never the only signal — same convention `SystemBadge.tsx`
 * already establishes in this repo ("colour is never the only signal"):
 * each variant pairs a glyph with its label text.
 */
const CONFIG: Record<EffectiveInvitationStatus, { glyph: string; label: string; color: string }> = {
  pending: { glyph: '⏳', label: 'Pending', color: 'var(--acc)' },
  accepted: { glyph: '✓', label: 'Accepted', color: 'var(--grn)' },
  expired: { glyph: '⌛', label: 'Expired', color: 'var(--org)' },
  revoked: { glyph: '⊘', label: 'Revoked', color: 'var(--red)' },
}

export type InvitationStatusBadgeProps = {
  status: EffectiveInvitationStatus
}

export default function InvitationStatusBadge({ status }: InvitationStatusBadgeProps) {
  const { glyph, label, color } = CONFIG[status]

  return (
    <span
      data-testid="invitation-status-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
