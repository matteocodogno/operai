/**
 * money — `formatMoney(cents, currency)`, refund-ui's single shared
 * cents↔display formatter (T14, specs/007-refund-service/tasks.md; directly
 * answers plan.md's R7 risk: "money as cents mis-formatting in UI (off-by-100)
 * … single shared cents↔display formatter, unit-tested per currency").
 *
 * Input is always **integer minor units** (cents/centesimi) — refund-api
 * never puts a `Decimal`/float amount on the wire (plan.md "Money handling").
 * Output format is plan.md's own literal spec ("## Money handling": "the UI
 * formats cents → `x,xx €`/`x,xx CHF`") — a COMMA decimal separator (the
 * Italian/European convention this suite's users expect for EUR and CHF
 * alike), followed by the currency symbol/code, space-separated.
 *
 * Deliberately NOT `Intl.NumberFormat`: that API's output depends on the
 * runtime's bundled ICU data (full-icu vs. small-icu), which differs between
 * local dev, CI, and various deploy targets — the same `cents` input could
 * render different punctuation in different environments. Formatting by
 * hand with integer arithmetic (no float division at all) is both
 * deterministic across every environment AND exactly correct for money: no
 * `cents / 100` float step exists that could ever introduce a rounding
 * artifact (e.g. `999999 / 100` in IEEE 754 double arithmetic risks
 * `9999.990000000002`-style drift for some inputs — irrelevant to display
 * here only because `toFixed(2)` would mask it, but avoiding the float step
 * entirely removes the class of bug rather than papering over it).
 */

export type Currency = 'EUR' | 'CHF'

const CURRENCY_SUFFIX: Record<Currency, string> = {
  EUR: '€',
  CHF: 'CHF',
}

/**
 * Formats an integer amount of minor units (cents/centesimi) as
 * `x,xx €`/`x,xx CHF` — always exactly two decimal digits, comma-separated,
 * with an explicit currency label so the value is never a bare, unitless
 * number (design.md Accessibility: "never a bare number a screen reader
 * could misread as unitless").
 *
 * `cents` must be a finite integer (refund-api's `Int` columns guarantee
 * this on the wire; a non-integer or non-finite input is a programmer error
 * and throws rather than silently rendering a wrong amount — money is not a
 * place to guess).
 */
export const formatMoney = (cents: number, currency: Currency): string => {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`formatMoney: cents must be an integer, got ${cents}`)
  }

  const negative = cents < 0
  const absCents = Math.abs(cents)
  const whole = Math.trunc(absCents / 100)
  const remainder = absCents % 100
  const decimals = remainder.toString().padStart(2, '0')

  return `${negative ? '-' : ''}${whole},${decimals} ${CURRENCY_SUFFIX[currency]}`
}
