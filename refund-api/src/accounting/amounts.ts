/**
 * Pure, DB-free CHF and VAT amounts of an expense line
 * (T3, specs/20261118-refund-accounting-export; AC-3.8, AC-6.3, AC-6.4,
 * AC-6.12; ADR 20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-
 * micros-and-basis-points-rounded-once-half-up-and-never-stored).
 *
 * Both figures are DERIVED ON READ and never stored: the rate in effect can
 * be corrected after approval (AC-5.3), so a stored figure would go stale.
 * Callers (the accounting view, the export) all go through these two
 * functions, so a screen and a file cannot disagree by a cent.
 *
 * Integer arithmetic only, in `BigInt`, with exactly ONE rounding per
 * figure, half up (never an intermediate rounding, never a float):
 *
 *   chfCents = round(amountCents * rateMicros / 1_000_000)
 *              (a CHF line is `amountCents` itself, with no rate)
 *   vatCents = round(chfCents * bp / (10_000 + bp))
 *              = the VAT contained in a gross CHF amount, computed from the
 *                ROUNDED CHF amount so the file's VAT is always consistent
 *                with the file's CHF column
 *
 * Examples (the golden vectors, `amounts-vectors.json`):
 *   1040 EUR cents at 0.9246 (924600 micros) = 961.584 -> 962   (AC-6.3)
 *   2080 CHF cents at 8.1 % (810 bp)          = 155.86  -> 156   (AC-6.4)
 *
 * A MISSING INPUT IS `null`, NEVER A DEFAULT (ADR decision 5): no rate gives a
 * `null` CHF amount (not 0, not a rate of 1); an unknown CHF amount or no VAT
 * code gives a `null` VAT amount. Callers turn `null` into `rateMissing` /
 * a blocker, never into a number.
 *
 * Amounts are 0 or greater (a line approved at 0 yields 0 and 0, AC-6.12), so
 * half-up on non-negative integers is `floor((2n + d) / 2d)`. An input that is
 * not a non-negative safe integer is a programming error and throws a
 * `RangeError`, because silently rounding or clamping money would hide it.
 */

/** 1 unit of a foreign currency in CHF, times 1e6: 0.9246 CHF per EUR is 924600. */
const MICROS_PER_UNIT = 1_000_000n;
/** 100 % in basis points. */
const BASIS_POINTS_FULL = 10_000n;

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/** Half up on a non-negative numerator and a positive denominator. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function toSafeNumber(name: string, value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return Number(value);
}

/**
 * The CHF amount in cents of a line.
 *
 * - `currency === "CHF"`: `amountCents` itself; `rateMicros` is ignored.
 * - any other currency: `round(amountCents * rateMicros / 1e6)`, or `null`
 *   when no rate is in effect (`rateMicros === null`).
 *
 * @param amountCents the line's approved amount (`approvedTotalCents ??
 *   requestedAmountCents` before approval) in the line's own currency
 * @param rateMicros CHF per 1 unit of `currency`, times 1e6, or `null` when
 *   no rate is in effect for (currency, month of the line's date)
 */
export function chfCents(
  amountCents: number,
  currency: string,
  rateMicros: number | null,
): number | null {
  assertNonNegativeSafeInteger("amountCents", amountCents);
  if (currency === "CHF") return amountCents;
  if (rateMicros === null) return null;
  assertNonNegativeSafeInteger("rateMicros", rateMicros);
  if (rateMicros === 0) {
    // A rate of 0 is not a rate (the table forbids it, CHECK > 0); treating
    // it as one would turn a missing input into a plausible 0.
    throw new RangeError("rateMicros must be greater than 0");
  }
  const converted = divideRoundHalfUp(BigInt(amountCents) * BigInt(rateMicros), MICROS_PER_UNIT);
  return toSafeNumber("chfCents", converted);
}

/**
 * The VAT contained in a gross CHF amount, in cents.
 *
 * `null` when the CHF amount is unknown (no rate, AC-3.8) or the line has no
 * VAT code: unknown stays unknown, it is never 0.
 *
 * @param chf the CHF amount in cents, as returned by {@link chfCents}
 * @param rateBasisPoints the frozen VAT code's rate: 8.1 % is 810
 */
export function vatCents(chf: number | null, rateBasisPoints: number | null): number | null {
  if (chf === null || rateBasisPoints === null) return null;
  assertNonNegativeSafeInteger("chfCents", chf);
  assertNonNegativeSafeInteger("rateBasisPoints", rateBasisPoints);
  if (rateBasisPoints > Number(BASIS_POINTS_FULL)) {
    throw new RangeError(`rateBasisPoints must be 0..10000, got ${rateBasisPoints}`);
  }
  const bp = BigInt(rateBasisPoints);
  const contained = divideRoundHalfUp(BigInt(chf) * bp, BASIS_POINTS_FULL + bp);
  return toSafeNumber("vatCents", contained);
}
