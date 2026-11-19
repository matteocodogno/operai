/**
 * The limits of the catalog, in one module (T8 and T9, specs/20261119-accounting, plan D31, AC-1.2, AC-1.5).
 *
 * accounting-ui's `src/lib/limits.ts` mirrors these numbers and the reason words (`empty`, `format`, `too_long`,
 * `range`); the server stays the authority and answers a refused value as `fields[{ field, reason }]`. The 20261118
 * patterns (`^[0-9]{3,6}(\.[0-9]{1,3})?$`) are gone: an account number is digits separated by single dots, 1 to 20
 * characters, so `5905`, `2620.1` and `1.2.3` are all accepted.
 *
 * Every check trims first (AC-1.2: "leading and trailing blanks are removed before the check") and returns the value
 * that is stored, so the caller never stores what it did not check. A check never throws, whatever it is given: the
 * body came off the wire.
 *
 * Where the database CHECKs sit (T5, init migration) these are never looser: a number matches the same pattern, a
 * name or label is 1 to N characters after trimming. The one stricter rule is a control character (NUL included) in
 * a free text: Postgres cannot store a NUL in a text column, so letting one through would be a 500, not a refusal.
 */

export const LIMITS = {
  ledgerNumberMax: 20,
  ledgerNameMax: 120,
  vatCodeMax: 16,
  vatLabelMax: 80,
  /** A rate is at most this many percent (0 is the lower bound); the two decimals are in the pattern. */
  vatRateMaxPercent: 100,
} as const;

/** Why a value is refused. `range` is a well-formed number outside its bounds (T9: a VAT rate). */
export type FieldReason = "empty" | "format" | "too_long" | "range";

export type LimitCheck = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: FieldReason };

const ok = (value: string): LimitCheck => ({ ok: true, value });
const refused = (reason: FieldReason): LimitCheck => ({ ok: false, reason });

/** Digits separated by single dots: `5905`, `2620.1`, `1.2.3`. Same pattern as the database CHECK. */
const LEDGER_NUMBER = /^[0-9]+(\.[0-9]+)*$/;

/** C0 controls and DEL: nothing a person types into a name or a label. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What a field holds before its check: a string, or the absence of one (missing and `null` read as empty). */
function trimmed(input: unknown): string | null {
  if (input === undefined || input === null) return "";
  return typeof input === "string" ? input.trim() : null;
}

/** An account number, as stored. Format before length: a long garbage value is not fixed by cutting it. */
export function checkLedgerNumber(input: unknown): LimitCheck {
  const value = trimmed(input);
  if (value === null) return refused("format");
  if (value === "") return refused("empty");
  if (!LEDGER_NUMBER.test(value)) return refused("format");
  if (value.length > LIMITS.ledgerNumberMax) return refused("too_long");
  return ok(value);
}

/** A free text (an account name, a VAT label): non-blank after trimming, no control character, at most `max` characters. */
export function checkText(input: unknown, max: number): LimitCheck {
  const value = trimmed(input);
  if (value === null) return refused("format");
  if (value === "") return refused("empty");
  if (CONTROL.test(value)) return refused("format");
  if (value.length > max) return refused("too_long");
  return ok(value);
}

export const checkLedgerName = (input: unknown): LimitCheck => checkText(input, LIMITS.ledgerNameMax);

export const checkVatLabel = (input: unknown): LimitCheck => checkText(input, LIMITS.vatLabelMax);

/**
 * Lower case to capital letters, `a` to `z` only. Not `toUpperCase()`: that one turns `ß` into `SS` and `ſ` into `S`,
 * which would let a character outside the code's alphabet in through the conversion. The URL's `{code}` goes through
 * the same function, so a code is found by what it is stored as.
 */
export const upperCaseCode = (input: string): string => input.replace(/[a-z]/g, (letter) => letter.toUpperCase());

/** Capital letters, digits, `_` and `-`. Same pattern as the database CHECK (the length is checked apart). */
const VAT_CODE = /^[A-Z0-9_-]+$/;

/** A VAT code, trimmed and converted to capital letters (AC-1.5): the form the database stores and every lookup uses. */
export function checkVatCode(input: unknown): LimitCheck {
  const trimmedValue = trimmed(input);
  if (trimmedValue === null) return refused("format");
  const value = upperCaseCode(trimmedValue);
  if (value === "") return refused("empty");
  if (!VAT_CODE.test(value)) return refused("format");
  if (value.length > LIMITS.vatCodeMax) return refused("too_long");
  return ok(value);
}

/** Up to three digits and up to two decimals after a dot: `8`, `8.1`, `8.10`, `100`. The range is checked after. */
const VAT_RATE = /^\d{1,3}(\.\d{1,2})?$/;

/** A VAT rate in percent as a decimal string with a dot: 0 to 100, at most two decimals. Returns the trimmed string. */
export function checkVatRatePercent(input: unknown): LimitCheck {
  const value = trimmed(input);
  if (value === null) return refused("format");
  if (value === "") return refused("empty");
  if (!VAT_RATE.test(value)) return refused("format");
  if (Number(value) > LIMITS.vatRateMaxPercent) return refused("range");
  return ok(value);
}

/** One refused field of a 422, as it travels: `fields: [{ field, reason }]`. */
export interface FieldRefusal {
  readonly field: string;
  readonly reason: FieldReason;
}

/** The sentence for a refused field. Names the value and what is wrong, never anything about the system (AC-6.10). */
export function describeRefusal({ field, reason }: FieldRefusal): string {
  switch (reason) {
    case "empty":
      return `${field} is required`;
    case "too_long":
      return `${field} is too long`;
    case "range":
      return `${field} is outside the allowed range`;
    case "format":
      return `${field} has an invalid format`;
  }
}
