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
 * EVERY VARIANT IS NEUTRAL, and deliberately identical. Each used to carry its
 * own colour (CHF `--grn`, EUR `--acc`, USD `--org`, GBP `--red`), which put
 * four meaning-bearing colours on a chip that means nothing beyond "this is
 * the currency". Worst of all, a CHF row showed the green chip immediately
 * beside the green APPROVED figure, so the one colour on the row that carried
 * a decision was competing with one that carried none. Currency is neutral
 * metadata, so it now looks it — the ISO code was always what told the reader
 * which currency this was, and it still is.
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
const CONFIG: Record<Currency, { glyph: string | null }> = {
  EUR: { glyph: '€' },
  CHF: { glyph: null },
  USD: { glyph: '$' },
  GBP: { glyph: '£' },
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
  const label = strings.badges.currency[currency]

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
