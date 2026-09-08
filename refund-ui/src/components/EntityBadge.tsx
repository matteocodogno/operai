/**
 * EntityBadge — glyph + text + color chip identifying which legal entity an
 * expense line/request belongs to (T15, specs/007-refund-service/tasks.md;
 * Component inventory: "EntityBadge (WellD Italia·EUR / WellD CH·CHF chip) —
 * NEW, small — Glyph+text+color convention ported from ConditionChip.tsx").
 *
 * Two variants, matching `RefundLine.entity` verbatim (plan.md "## Data
 * model": `enum Entity { welld_it welld_ch }`).
 *
 * Post-close change (specs/007): currency was originally *derived* from
 * entity 1:1 (`welld_it → EUR`, `welld_ch → CHF`), so this badge used to
 * spell out both in one label ("WellD Italia · EUR"). Currency is now a
 * separately-stored, independently-selectable field on each line (any
 * entity/currency pair is valid) — this badge shows the ENTITY ONLY;
 * `CurrencyBadge` (./CurrencyBadge.tsx) renders the currency as its own,
 * separate chip wherever both are shown together.
 *
 * Colour is never the only signal — same convention `admin-ui/src/components/
 * ConditionChip.tsx` already establishes in this suite (that component pairs
 * several chip "kinds" with the SAME color, differentiated only by
 * glyph+text): each variant pairs a country-flag glyph with its entity-name
 * label text, so a colorblind/low-vision/screen-reader user never has to
 * infer the entity from color alone.
 *
 * BOTH VARIANTS ARE NEUTRAL, and deliberately identical. `welld_ch` used to
 * be `--grn` and `welld_it` `--acc`, which overloaded two colours that carry
 * MEANING elsewhere on the very same row: green marks an approved amount and
 * the accent marks an interactive/primary element. A reader scanning a line
 * saw green on the entity chip and green on the approved figure and had to
 * learn that only one of them meant anything. An entity is neutral metadata —
 * it is not good, not actionable, just true — so it now reads as metadata,
 * and green is left to mean "approved" alone.
 *
 * Following ConditionChip's precedent exactly: two kinds, one colour, told
 * apart by glyph and text. Nothing is lost, because colour was never doing
 * that work here.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings).
 */

import { strings } from '../strings'

export type Entity = 'welld_it' | 'welld_ch'

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
  const label = strings.badges.entity[entity]

  return (
    <span
      data-testid="entity-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: NEUTRAL, backgroundColor: `color-mix(in srgb, ${NEUTRAL} 10%, transparent)` }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}
