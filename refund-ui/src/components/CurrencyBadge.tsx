/**
 * CurrencyBadge — glyph + text + color chip identifying an expense line/
 * subtotal's currency, independent of `EntityBadge` (post-close change,
 * specs/007-refund-service — currency became a separately-stored,
 * independently-selectable field, no longer 1:1-derived from entity; see
 * `EntityBadge.tsx`'s own doc comment for the split rationale).
 *
 * Mirrors `EntityBadge`'s glyph+text+color chip convention (ported from
 * `admin-ui/src/components/ConditionChip.tsx`) rather than introducing a new
 * badge shape: a currency symbol (aria-hidden glyph) paired with the
 * currency's ISO code as the visible, accessible-name-carrying text — never
 * color-only, same as every other badge in this suite. A currency with no
 * symbol distinct from its code renders the code alone (see `CONFIG`).
 *
 * Used wherever a currency needs to be shown separately from — and possibly
 * alongside — an `EntityBadge`: `ExpenseLineRow`'s read-only renders and
 * `SubtotalsPanel`'s per-currency cards (subtotals are grouped by currency
 * only, not entity, so `SubtotalsPanel` renders ONLY this badge, no
 * `EntityBadge`).
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings).
 */

import { strings } from '../strings'
import type { Currency } from '../lib/money'

/**
 * `glyph` is the DECORATIVE currency symbol (aria-hidden); the visible ISO
 * code beside it is what carries the accessible name.
 *
 * `null` means "this currency has no symbol distinct from its ISO code".
 * The Swiss franc is the only such case here: it has no single-character
 * sign in common use (Swiss practice writes `Fr.`/`SFr.`, and U+20A3 ₣ is
 * the FRENCH franc sign, not a Swiss one), so it previously carried the
 * literal string `'CHF'` as its glyph — which rendered the chip as
 * "CHF CHF", the code printed twice. Rendering the code alone is the honest
 * result; do NOT reintroduce a symbol here just to fill the slot.
 */
const CONFIG: Record<Currency, { glyph: string | null; color: string }> = {
  EUR: { glyph: '€', color: 'var(--acc)' },
  CHF: { glyph: null, color: 'var(--grn)' },
  USD: { glyph: '$', color: 'var(--org)' },
  GBP: { glyph: '£', color: 'var(--red)' },
}

export type CurrencyBadgeProps = {
  currency: Currency
}

export default function CurrencyBadge({ currency }: CurrencyBadgeProps) {
  const { glyph, color } = CONFIG[currency]
  const label = strings.badges.currency[currency]

  return (
    <span
      data-testid="currency-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {glyph !== null && <span aria-hidden="true">{glyph}</span>}
      <span>{label}</span>
    </span>
  )
}
