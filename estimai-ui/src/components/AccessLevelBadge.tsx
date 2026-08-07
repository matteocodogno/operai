/**
 * AccessLevelBadge — glyph + text chip identifying a collaborator's access
 * level on a shared estimate (T14, specs/013-estimate-sharing/tasks.md;
 * design.md Component inventory: "AccessLevelBadge (Viewer/Editor chip) —
 * NEW, small — pattern ported from refund-ui/EntityBadge.tsx (glyph + text +
 * color, never color-only)"). Reused, unmodified, across the collaborators
 * dialog (owner and member modes) and the estimates list's shared-row
 * indicator (design.md "## Component inventory": "reused across S2/S3/S6
 * rather than reinventing per screen").
 *
 * design.md's Accessibility section fixes the shape: "glyph + text together,
 * never color alone … both aria-hidden, with the visible text label carrying
 * the actual accessible name" — same rule `EntityBadge.tsx` already
 * establishes in this suite. Matches `EntityBadge`'s exact a11y contract: the
 * accessible name comes from ordinary, always-rendered text (not
 * `aria-label`), so a colorblind or screen-reader user gets the same
 * information a sighted color-only signal would give.
 */

import { strings } from '../strings'

export type AccessLevel = 'viewer' | 'editor'

const CONFIG: Record<AccessLevel, { glyph: string; label: string; color: string }> = {
  editor: { glyph: '✎', label: strings.sharing.dialog.levelEditor, color: 'var(--acc)' },
  viewer: { glyph: '👁', label: strings.sharing.dialog.levelViewer, color: 'var(--soft)' },
}

export type AccessLevelBadgeProps = {
  level: AccessLevel
}

export default function AccessLevelBadge({ level }: AccessLevelBadgeProps) {
  const { glyph, label, color } = CONFIG[level]

  return (
    <span
      data-testid="access-level-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
