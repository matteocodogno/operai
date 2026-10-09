/**
 * EntityBadge — the wellD legal-entity chip (T25, specs/015-hardware-inventory),
 * re-authored from refund-ui's component with the same props: a flag glyph
 * (aria-hidden) plus the entity name, never colour alone. Every entity chip is
 * the same neutral colour: an entity is metadata, not a status, so it must not
 * borrow a semantic colour.
 */

import { strings } from '../strings'
import type { Entity } from '../lib/types'

/**
 * Neutral metadata weight — see the module doc on why this is not per-variant.
 *
 * `--soft` specifically, not `--muted`: measured against the 10% tint this
 * chip paints over the `--ink-soft` card, `--soft` gives 4.76:1 and `--muted`
 * 2.60:1. At 11px this is normal-size text, so 4.5:1 is the bar — `--muted`
 * would read as "more neutral" and fail it. Neutral must not mean unreadable.
 */
const NEUTRAL = 'var(--soft)'

const CONFIG: Record<Entity, { glyph: string }> = {
  welld_it: { glyph: '🇮🇹' },
  welld_ch: { glyph: '🇨🇭' },
}

export type EntityBadgeProps = {
  entity: Entity
}

export default function EntityBadge({ entity }: EntityBadgeProps) {
  const { glyph } = CONFIG[entity]
  const label = strings.common.entity[entity]

  return (
    <span
      data-testid="entity-badge"
      className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: NEUTRAL, backgroundColor: `color-mix(in srgb, ${NEUTRAL} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
