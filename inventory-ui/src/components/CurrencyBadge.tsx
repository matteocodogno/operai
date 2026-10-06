/**
 * CurrencyBadge — the currency chip (T25, specs/015-hardware-inventory),
 * re-authored from refund-ui's component with the same props, limited to the
 * two currencies inventory-api carries (EUR, CHF). The visible ISO code carries
 * the accessible name; the glyph is decorative and aria-hidden.
 */

import { strings } from '../strings'
import type { Currency } from '../lib/types'

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
const CONFIG: Record<Currency, { glyph: string | null }> = {
  EUR: { glyph: '€' },
  CHF: { glyph: null },
}

/**
 * Neutral metadata weight — see the module doc on why this is not per-variant.
 *
 * `--soft` specifically, not `--muted`: measured against the 10% tint this
 * chip paints over the `--ink-soft` card, `--soft` gives 4.76:1 and `--muted`
 * 2.60:1. At 11px this is normal-size text, so 4.5:1 is the bar — `--muted`
 * would read as "more neutral" and fail it. Neutral must not mean unreadable.
 */
const NEUTRAL = 'var(--soft)'

export type CurrencyBadgeProps = {
  currency: Currency
}

export default function CurrencyBadge({ currency }: CurrencyBadgeProps) {
  const { glyph } = CONFIG[currency]
  const label = strings.common.currency[currency]

  return (
    <span
      data-testid="currency-badge"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: NEUTRAL, backgroundColor: `color-mix(in srgb, ${NEUTRAL} 10%, transparent)` }}
    >
      {glyph !== null && <span aria-hidden="true">{glyph}</span>}
      <span>{label}</span>
    </span>
  )
}
