/**
 * The limits of the catalog, in one module (T8, specs/20261119-accounting, plan D31, AC-1.2; T9 adds the VAT ones).
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
