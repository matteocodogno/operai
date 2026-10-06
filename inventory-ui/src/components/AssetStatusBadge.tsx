import { strings } from '../strings'
import type { AssetStatus } from '../lib/types'

/**
 * AssetStatusBadge — the asset lifecycle chip (T26, specs/015-hardware-
 * inventory; design.md § NEW components: "six new variants (ordered, in_stock,
 * assigned, in_repair, lost, disposed) … Same glyph + text + colour convention
 * as RequestStatusBadge").
 *
 * Status is never carried by colour alone: every variant has its own glyph
 * (aria-hidden) AND its own label, and the label is the accessible name. The
 * colours are theme tokens (`--soft`, `--acc`, `--grn`, `--org`, `--red`) over
 * a 10% tint of themselves, so both themes are served by the tokens. Two states
 * share `--soft` (ordered, disposed) on purpose — they are told apart by glyph
 * and text, and neither is a state that asks for action.
 *
 * Contrast to verify in both themes (design.md § Accessibility): the badge text
 * on its 10% tint, notably `--soft` and `--org`, at 4.5:1.
 *
 * A status a newer server adds (outside the six) renders as its raw value with
 * no glyph rather than throwing, so a deploy skew never blanks a list.
 */

const CONFIG: Record<AssetStatus, { glyph: string; color: string }> = {
  ordered: { glyph: '⇢', color: 'var(--soft)' },
  in_stock: { glyph: '▢', color: 'var(--acc)' },
  assigned: { glyph: '●', color: 'var(--grn)' },
  in_repair: { glyph: '⚙', color: 'var(--org)' },
  lost: { glyph: '⚠', color: 'var(--red)' },
  disposed: { glyph: '⌀', color: 'var(--soft)' },
}

export type AssetStatusBadgeProps = {
  status: AssetStatus
}

export default function AssetStatusBadge({ status }: AssetStatusBadgeProps) {
  const known = (CONFIG as Partial<Record<string, { glyph: string; color: string }>>)[status]
  const { glyph, color } = known ?? { glyph: null, color: 'var(--soft)' }
  const label = (strings.badges.assetStatus as Partial<Record<string, string>>)[status] ?? status

  return (
    <span
      data-testid="asset-status-badge"
      data-status={status}
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {glyph !== null && <span aria-hidden="true">{glyph}</span>}
      <span>{label}</span>
    </span>
  )
}
