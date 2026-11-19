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

/**
 * How many entries one entity may hold, deactivated ones included (entries are never deleted, so this is a cap on rows;
 * security-review F-01, plan sync pending). Separate from `LIMITS` because accounting-ui does not mirror it: it is the server's
 * protection of a consumer, not a field rule.
 *
 * WHY THESE NUMBERS. Refund reads an entity's WHOLE catalog in one body and refuses anything over its own
 * `ACCOUNTING_MAX_BODY_BYTES` (256 KiB) as `too_large`, which turns every approve, classify and release into a 503. The largest
 * answer the field limits allow is 538 bytes per account (20-digit number, 120 four-byte characters) and 397 per VAT code (16-character
 * code, 80 four-byte characters), so 200 accounts and 50 VAT codes come to about 127.8 KB: under HALF of that cap, with the
 * rest as room for the envelope, a larger limit of the consumer's own, and a limit raised here by mistake (the cross-package
 * test `catalog.cap.cross-package.test.ts` fails first). A real chart of accounts of a small company is far below it (the WellD CH seed
 * holds a handful); an accountant who needs more raises it together with that test and with Refund's reading side.
 */
export const CATALOG_CAPS = {
  ledgerAccountsPerEntity: 200,
  vatCodesPerEntity: 50,
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

/**
 * A string with nothing to see in it: white space and the invisible format characters (Unicode category Cf: zero-width
 * space and joiners, left-to-right and right-to-left marks, the bidi embeddings and isolates, word joiner, soft hyphen,
 * byte order mark), plus the three fillers that draw nothing (Hangul fillers, Braille blank). `String.trim()` removes
 * only White_Space, so a name of U+200B alone survived it (QE D-6, AC-1.2 "only blanks").
 */
const BLANK = /^[\p{White_Space}\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]*$/u;

/** Characters as a person counts them: code points, not UTF-16 units (an emoji is one, and the database CHECK counts them so too). */
const lengthOf = (value: string): number => {
  let count = 0;
  for (const _ of value) count++;
  return count;
};

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
  if (value === "" || BLANK.test(value)) return refused("empty");
  if (CONTROL.test(value)) return refused("format");
  if (lengthOf(value) > max) return refused("too_long");
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

/**
 * The lookup keys of the URL (`{number}`, `{code}`): exactly what an entry can be stored as, no trimming and no repair. A key
 * that fails is an entry that cannot exist, which the routes answer as 404 without asking the database (a NUL byte there
 * is a value Postgres cannot even compare: it was a 500, QE D-1).
 */
export const isLedgerNumberKey = (key: string): boolean => key.length <= LIMITS.ledgerNumberMax && LEDGER_NUMBER.test(key);

/** `key` is already upper-cased (`upperCaseCode`). */
export const isVatCodeKey = (key: string): boolean => key.length <= LIMITS.vatCodeMax && VAT_CODE.test(key);

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
