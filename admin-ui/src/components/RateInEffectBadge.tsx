/**
 * RateInEffectBadge — marks the mileage-rate history row that is currently
 * "in effect" (T11, specs/009-mileage-rate, design.md Screen ADM-1: "the
 * `inEffectToday` row carries the `RateInEffectBadge` in the Status column
 * (glyph+text, never color-only)").
 *
 * NEW, small component — no existing badge fits this domain (invitation
 * status ≠ system-role ≠ "currently in effect"). Clones the established
 * glyph+text+color recipe already in this repo (`SystemBadge.tsx`,
 * `InvitationStatusBadge.tsx`) — colour is never the only signal.
 */

export default function RateInEffectBadge() {
  return (
    <span
      data-testid="rate-in-effect-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: 'var(--grn)', backgroundColor: 'color-mix(in srgb, var(--grn) 10%, transparent)' }}
    >
      <span aria-hidden="true">✓</span>
      <span>In effect</span>
    </span>
  )
}
