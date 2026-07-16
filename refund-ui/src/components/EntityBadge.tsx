/**
 * EntityBadge — glyph + text + color chip identifying which legal entity an
 * expense line/request belongs to (T15, specs/007-refund-service/tasks.md;
 * Component inventory: "EntityBadge (WellD Italia·EUR / WellD CH·CHF chip) —
 * NEW, small — Glyph+text+color convention ported from ConditionChip.tsx").
 *
 * Two variants, matching `RefundLine.entity`/`RefundRequest` subtotal
 * grouping verbatim (plan.md "## Data model": `enum Entity { welld_it
 * welld_ch }` — "currency is never stored — it is derived from entity …
 * welld_it → EUR, welld_ch → CHF"). The label always spells out BOTH the
 * entity name and its derived currency ("WellD Italia · EUR") so the
 * currency is never left for the reader to infer from the entity alone —
 * this mirrors plan.md's own "line entity is the single source of truth"
 * framing at the UI layer too.
 *
 * Colour is never the only signal — same convention `admin-ui/src/components/
 * ConditionChip.tsx` already establishes in this suite (that component pairs
 * several chip "kinds" with the SAME color, differentiated only by
 * glyph+text — precedent this badge follows for its own two variants): each
 * variant pairs a country-flag glyph with its full "Entity · Currency" label
 * text, so a colorblind/low-vision/screen-reader user never has to infer the
 * entity from color alone.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings).
 */

import { strings } from '../strings'

export type Entity = 'welld_it' | 'welld_ch'

const CONFIG: Record<Entity, { glyph: string; color: string }> = {
  welld_it: { glyph: '🇮🇹', color: 'var(--acc)' },
  welld_ch: { glyph: '🇨🇭', color: 'var(--grn)' },
}

export type EntityBadgeProps = {
  entity: Entity
}

export default function EntityBadge({ entity }: EntityBadgeProps) {
  const { glyph, color } = CONFIG[entity]
  const label = strings.badges.entity[entity]

  return (
    <span
      data-testid="entity-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
