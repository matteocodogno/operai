/**
 * Exact conversion of a spreadsheet number to integer cents, rounded half-up
 * (AC-12.2). Spreadsheet cells are IEEE doubles, often the result of a formula
 * (`28.3333333333333`), so `Math.round(x * 100)` is wrong in both directions
 * (`1.005 * 100 === 100.49999999999999`). Instead the number is written out to
 * eight decimals - far below double precision at the magnitudes of a hardware
 * register, far above any rounding noise - and the decimal string is rounded
 * with integer arithmetic.
 */

export function toCents(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const negative = value < 0;
  const text = Math.abs(value).toFixed(8); // "1234.56789012"
  const [whole, fraction = ""] = text.split(".") as [string, string?];
  const cents = Number(whole) * 100 + Number(fraction.slice(0, 2));
  // Half-up on the digits after the cent: the first dropped digit decides.
  const roundUp = Number(fraction.charAt(2)) >= 5;
  const result = cents + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(result)) throw new RangeError(`amount out of range: ${value}`);
  return negative ? -result : result;
}
