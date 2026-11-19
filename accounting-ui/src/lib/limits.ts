/**
 * limits — the client's mirror of accounting-api's limits (specs/20261119-accounting: plan D31, design UX-6 and
 * "Implementation notes": the 20261118 patterns are wrong now). One place for every number a dialog checks before it
 * asks the server, so a refused value is told apart from a refused request:
 *
 *   ledger account  number: digits separated by single dots, 1 to 20 characters (AC-1.2, e.g. `5905`, `2620.1`);
 *                   name: 1 to 120 characters
 *   VAT code        code: capital letters, digits, `_` and `-`, 1 to 16 characters, lower case converted (AC-1.5);
 *                   label: 1 to 80 characters; rate: 0 to 100 percent, at most two decimals
 *   exchange rate   a correction: greater than 0 and below 1000, at most six decimals (AC-2.5)
 *
 * The server stays the authority. Its `fields[]` (`{field, reason}`) is mapped to the same reasons by `reasonOf`, so
 * the client check and a server refusal read the same. Leading and trailing blanks are removed before every check
 * (AC-1.2); a length is counted in code points, as the server counts it (an emoji is one character, T53). A name or label with
 * nothing to see in it (white space, zero-width and bidi marks, soft hyphen, fillers; T53 `BLANK`) is `empty`, and one with a
 * control character is `format`. No arithmetic on money or rates
 * happens here: the rate checks compare a validated decimal string to its bounds and return the string.
 *
 * Checks never throw and return the value the request must carry (trimmed, upper-cased), or the reason.
 */

/** accounting-api `src/catalog/limits.ts` and the rate bounds, as numbers. Keep in step; a test pins each. */
export const LIMITS = {
  ledgerNumberMax: 20,
  ledgerNameMax: 120,
  vatCodeMax: 16,
  vatLabelMax: 80,
  vatRateDecimals: 2,
  vatRateMaxPercent: 100,
  fxRateDecimals: 6,
  /** A correction is below this (exclusive) and above 0 (exclusive). */
  fxRateBelow: 1000,
} as const

/**
 * How many entries an entity may hold, deactivated ones included (accounting-api `CATALOG_CAPS`, T53). Not a field rule, so
 * apart from `LIMITS`: the add dialogs use it only as the fallback when a 409 `catalog_full` carries no readable `limit`.
 * The server stays the authority and a test pins each number.
 */
export const CATALOG_CAPS = {
  ledgerAccountsPerEntity: 200,
  vatCodesPerEntity: 50,
} as const

/** Why a value is refused. `range` is a well-formed number outside its bounds. */
export type LimitReason = 'empty' | 'format' | 'too_long' | 'range'

export type LimitCheck<T = string> = { ok: true; value: T } | { ok: false; reason: LimitReason }

const ok = <T>(value: T): LimitCheck<T> => ({ ok: true, value })
const refused = (reason: LimitReason): LimitCheck<never> => ({ ok: false, reason })

const LEDGER_NUMBER = /^[0-9]+(?:\.[0-9]+)*$/
const VAT_CODE = /^[A-Z0-9_-]+$/
const VAT_RATE = /^[0-9]{1,3}(?:\.[0-9]{1,2})?$/
const FX_RATE = new RegExp(`^[0-9]+(?:\\.[0-9]{1,${LIMITS.fxRateDecimals}})?$`)

/** C0 controls and DEL: nothing a person types into a name or a label (accounting-api `CONTROL`, `[\u0000-\u001f\u007f]`). */
const hasControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

/**
 * A string with nothing to see in it: white space, the invisible format characters (Unicode category Cf: zero-width space
 * and joiners, LTR/RTL marks, bidi embeddings and isolates, word joiner, soft hyphen, byte order mark) and the fillers that
 * draw nothing (Hangul fillers, Braille blank). `String.prototype.trim` removes only White_Space. Same pattern as the
 * server's `BLANK`; keep in step.
 */
const BLANK = /^[\p{White_Space}\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]*$/u

/** Characters as a person counts them: code points, not UTF-16 units (an emoji is one, a lone surrogate too: as the server counts). */
const lengthOf = (value: string): number => {
  let count = 0
  for (let index = 0; index < value.length; index++) {
    count++
    if ((value.codePointAt(index) ?? 0) > 0xffff) index++
  }
  return count
}

/** A ledger account number, as the request must carry it. Format before length: a long garbage value is not fixed by cutting it. */
export function checkLedgerNumber(input: string): LimitCheck {
  const value = input.trim()
  if (value === '') return refused('empty')
  if (!LEDGER_NUMBER.test(value)) return refused('format')
  if (value.length > LIMITS.ledgerNumberMax) return refused('too_long')
  return ok(value)
}

/**
 * A ledger account name (or any free label), the server's `checkText`: not blank after trimming (invisible characters count
 * as blank), no control character, at most `max` code points. The value is kept as typed, only its ends are trimmed.
 */
export const checkText = (input: string, max: number): LimitCheck => {
  const value = input.trim()
  if (value === '' || BLANK.test(value)) return refused('empty')
  if (hasControl(value)) return refused('format')
  if (lengthOf(value) > max) return refused('too_long')
  return ok(value)
}

export const checkLedgerName = (input: string): LimitCheck => checkText(input, LIMITS.ledgerNameMax)

/**
 * Lower case to capital letters, `a` to `z` only (accounting-api `upperCaseCode`). Not `toUpperCase()`, which turns `ß` into
 * `SS`, `ſ` into `S` and `ı` into `I`, letting a character outside the code's alphabet in through the conversion; and the
 * full-width `ａ` is not converted either. Such a character stays as typed and is refused as `format`.
 */
export const upperCaseCode = (input: string): string => input.replace(/[a-z]/g, (letter) => letter.toUpperCase())

/** A VAT code, trimmed and converted to capital letters (AC-1.5), the form the server stores and looks up. */
export function checkVatCode(input: string): LimitCheck {
  const value = upperCaseCode(input.trim())
  if (value === '') return refused('empty')
  if (!VAT_CODE.test(value)) return refused('format')
  if (value.length > LIMITS.vatCodeMax) return refused('too_long')
  return ok(value)
}

export const checkVatLabel = (input: string): LimitCheck => checkText(input, LIMITS.vatLabelMax)

/** A VAT rate in percent as a decimal string with a dot (`8.1`): 0 to 100, at most two decimals. */
export function checkVatRatePercent(input: string): LimitCheck {
  const value = input.trim()
  if (value === '') return refused('empty')
  if (!VAT_RATE.test(value)) return refused('format')
  if (Number(value) > LIMITS.vatRateMaxPercent) return refused('range')
  return ok(value)
}

/** An exchange-rate correction as a decimal string with a dot (`0.9300`): above 0, below 1000, at most six decimals. */
export function checkFxRate(input: string): LimitCheck {
  const value = input.trim()
  if (value === '') return refused('empty')
  if (!FX_RATE.test(value)) return refused('format')
  const number = Number(value)
  if (!(number > 0) || number >= LIMITS.fxRateBelow) return refused('range')
  return ok(value)
}

/**
 * The reason of a server `fields[]` entry as one of ours. The server names `empty`, `format` and `too_long`; any
 * other word reads as `format`, so a new server reason is still a refused value with a message, never a blank one.
 */
export function reasonOf(serverReason: unknown): LimitReason {
  return serverReason === 'empty' || serverReason === 'too_long' || serverReason === 'range' ? serverReason : 'format'
}
