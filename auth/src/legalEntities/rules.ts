/**
 * The rules of a legal-entity save (specs/20261117-legal-entities, plan § "Normalisation and rules of a save",
 * amendments E1, E5, E6). Pure: no database, no clock, no I/O. One module serves the save, the restore, and the
 * `invalid` / `missing` / `complete` members of a read, so a value is judged by the same rules everywhere.
 *
 * Contract notes a caller relies on:
 * - `problems` / `invalid` / `missing` judge the value AFTER normalisation (NFC, then trim), but report `line` as the
 *   0-based position in the array handed in (E5: the submitted array, before blank lines are removed; E6: the stored
 *   array on a read). They never mutate their input.
 * - A save must persist `normalise(details)`, never the raw body: `sameDetails` and `changedFields` also compare
 *   after normalisation, so a body equivalent to the current details is a no-op (AC-2.1).
 * - Limits count Unicode code points (an emoji is 1), not UTF-16 units.
 */

/** The closed set of fields (`changedFields`, `problems[].field`, `missing[]`). Order is the display order. */
export const FIELDS = [
  "legalName",
  "address.it",
  "address.en",
  "vatNumber",
  "iban",
  "contacts.it",
  "contacts.en",
] as const;
export type Field = (typeof FIELDS)[number];

/** Values AC-1.2 requires (⊂ FIELDS). */
export const REQUIRED_FIELDS = ["legalName", "address.it", "address.en", "vatNumber"] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export const REASONS = [
  "required",
  "too_long",
  "too_many_lines",
  "line_break",
  "control_character",
  "iban_format",
  "iban_check_digits",
] as const;
export type Reason = (typeof REASONS)[number];

/** AC-1.3 limits, in Unicode code points (the IBAN's is after removing whitespace). */
export const LIMITS = {
  legalName: 200,
  addressLine: 120,
  addressLines: 4,
  vatNumber: 40,
  iban: 34,
  contacts: 200,
} as const;

export interface LegalDetails {
  legalName: string;
  address: { it: string[]; en: string[] };
  vatNumber: string;
  /** Electronic form: upper case, no whitespace; "" = empty. */
  iban: string;
  contacts: { it: string; en: string };
}

/** `{ field, line?, reason, limit? }` of plan § API contracts. `line` only on a per-line address reason. */
export interface Problem {
  field: Field;
  line?: number;
  reason: Reason;
  limit?: number;
}

export const EMPTY_DETAILS: LegalDetails = Object.freeze({
  legalName: "",
  address: Object.freeze({ it: [] as string[], en: [] as string[] }),
  vatNumber: "",
  iban: "",
  contacts: Object.freeze({ it: "", en: "" }),
}) as LegalDetails;

// ---------------------------------------------------------------------------------------------------------------
// Characters

/** U+000A, U+000D, U+0085, U+2028, U+2029 (AC-1.3 "line break"). */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/u;
/**
 * "Any other Unicode Cc" (tab, NUL, DEL, C1 …). Line-break characters that are Cc are excluded by the caller
 * checking line breaks first and stripping them (see `scan`).
 */
const CONTROL = /\p{Cc}/u;
const LINE_BREAK_G = /[\n\r\u0085\u2028\u2029]/gu;

/** A lone (unpaired) surrogate: with the `u` flag a paired one is a single code point and does not match. */
function hasLoneSurrogate(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) return true;
  }
  return false;
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** NFC, then trim. (`toWellFormed` is deliberately not used: a lone surrogate must be refused, not repaired.) */
function clean(s: string): string {
  return s.normalize("NFC").trim();
}

interface Scan {
  lineBreak: boolean;
  control: boolean;
}

function scan(s: string): Scan {
  const lineBreak = LINE_BREAK.test(s);
  // A line break is not also reported as a control character, whatever its category (U+000A, U+000D, U+0085 are Cc).
  const control = CONTROL.test(s.replace(LINE_BREAK_G, "")) || hasLoneSurrogate(s);
  return { lineBreak, control };
}

// ---------------------------------------------------------------------------------------------------------------
// IBAN

/**
 * Electronic form of an IBAN: every whitespace removed (including U+0085 and U+00A0, so a pasted line wrap or a
 * non-breaking space is not an error), ASCII letters upper-cased. Only ASCII is case-folded: `toUpperCase` would turn
 * "ß" into "SS" and make a different text look valid. Nothing else is touched, so a refused IBAN stays recognisable.
 */
export function normaliseIban(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\s\u0085]+/gu, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** ISO 7064 mod 97-10 over the rearranged IBAN; the caller has checked `^[A-Z0-9]+$`. */
export function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch; // A=10 … Z=35
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const IBAN_FORMAT = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

/** `ibanPrint`: the electronic form in groups of four separated by one space; "" when empty (D2). */
export function ibanPrint(iban: string): string {
  const chars = Array.from(iban);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4).join(""));
  return groups.join(" ");
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation

function normaliseLines(lines: readonly string[]): string[] {
  return lines.map(clean).filter((l) => l !== "");
}

/** The form a save persists: NFC + trim everywhere, blank address lines removed, IBAN in electronic form. */
export function normalise(d: LegalDetails): LegalDetails {
  return {
    legalName: clean(d.legalName),
    address: { it: normaliseLines(d.address.it), en: normaliseLines(d.address.en) },
    vatNumber: clean(d.vatNumber),
    iban: normaliseIban(clean(d.iban)),
    contacts: { it: clean(d.contacts.it), en: clean(d.contacts.en) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Problems

function oneLine(field: Field, value: string, limit: number, out: Problem[]): void {
  const { lineBreak, control } = scan(value);
  if (lineBreak) out.push({ field, reason: "line_break" });
  if (control) out.push({ field, reason: "control_character" });
  if (codePointLength(value) > limit) out.push({ field, reason: "too_long", limit });
}

function addressProblems(field: "address.it" | "address.en", submitted: readonly string[], out: Problem[]): void {
  let nonBlank = 0;
  submitted.forEach((raw, line) => {
    const value = clean(raw);
    if (value === "") return;
    nonBlank++;
    const { lineBreak, control } = scan(value);
    if (lineBreak) out.push({ field, line, reason: "line_break" });
    if (control) out.push({ field, line, reason: "control_character" });
    if (codePointLength(value) > LIMITS.addressLine) {
      out.push({ field, line, reason: "too_long", limit: LIMITS.addressLine });
    }
  });
  if (nonBlank === 0) out.push({ field, reason: "required" });
  else if (nonBlank > LIMITS.addressLines) {
    out.push({ field, reason: "too_many_lines", limit: LIMITS.addressLines });
  }
}

function ibanProblems(raw: string, out: Problem[]): void {
  const iban = normaliseIban(clean(raw));
  if (iban === "") return; // optional
  // A control character (anything left after whitespace removal) or a lone surrogate: not an IBAN, and the more
  // useful answer than "format".
  if (CONTROL.test(iban) || hasLoneSurrogate(iban)) {
    out.push({ field: "iban", reason: "control_character" });
    return;
  }
  if (codePointLength(iban) > LIMITS.iban) {
    out.push({ field: "iban", reason: "too_long", limit: LIMITS.iban });
    return;
  }
  if (!IBAN_FORMAT.test(iban)) {
    out.push({ field: "iban", reason: "iban_format" });
    return;
  }
  if (!ibanChecksumOk(iban)) out.push({ field: "iban", reason: "iban_check_digits" });
}

/**
 * Every problem of a set of details, at once (AC-1.2 – AC-1.4), in `FIELDS` order; within an address, per-line
 * problems in line order, then the count-based one. `line` is the position in the array passed in (E5).
 */
export function problems(d: LegalDetails): Problem[] {
  const out: Problem[] = [];
  const required = (field: RequiredField, value: string): boolean => {
    if (value === "") {
      out.push({ field, reason: "required" });
      return false;
    }
    return true;
  };

  const legalName = clean(d.legalName);
  if (required("legalName", legalName)) oneLine("legalName", legalName, LIMITS.legalName, out);
  addressProblems("address.it", d.address.it, out);
  addressProblems("address.en", d.address.en, out);
  const vat = clean(d.vatNumber);
  if (required("vatNumber", vat)) oneLine("vatNumber", vat, LIMITS.vatNumber, out);
  ibanProblems(d.iban, out);
  oneLine("contacts.it", clean(d.contacts.it), LIMITS.contacts, out);
  oneLine("contacts.en", clean(d.contacts.en), LIMITS.contacts, out);
  return out;
}

/**
 * `LegalEntity.invalid` of a read (E6): the same rules over what is stored, without `required` (that is `missing`).
 * `line` is the index in the stored array.
 */
export function invalid(stored: LegalDetails): Problem[] {
  return problems(stored).filter((p) => p.reason !== "required");
}

/** `LegalEntity.missing`: the required values that are empty after normalisation, in `REQUIRED_FIELDS` order. */
export function missing(d: LegalDetails): RequiredField[] {
  const n = normalise(d);
  return REQUIRED_FIELDS.filter((f) => {
    switch (f) {
      case "legalName":
        return n.legalName === "";
      case "address.it":
        return n.address.it.length === 0;
      case "address.en":
        return n.address.en.length === 0;
      case "vatNumber":
        return n.vatNumber === "";
    }
  });
}

/** `LegalEntity.complete`: all required values present (AC-1.2). */
export function complete(d: LegalDetails): boolean {
  return missing(d).length === 0;
}

/** E1: the version passes today's rules (complete and nothing invalid) — what a restore would be allowed to do. */
export function restorable(d: LegalDetails): boolean {
  return problems(d).length === 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

function value(d: LegalDetails, f: Field): string | string[] {
  switch (f) {
    case "legalName":
      return d.legalName;
    case "address.it":
      return d.address.it;
    case "address.en":
      return d.address.en;
    case "vatNumber":
      return d.vatNumber;
    case "iban":
      return d.iban;
    case "contacts.it":
      return d.contacts.it;
    case "contacts.en":
      return d.contacts.en;
  }
}

function sameValue(a: string | string[], b: string | string[]): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * The fields whose value differs, in `FIELDS` order, comparing after normalisation (so it is empty exactly when
 * `sameDetails`). `prev === null` is the first version: every non-empty field.
 */
export function changedFields(prev: LegalDetails | null, next: LegalDetails): Field[] {
  const a = normalise(prev ?? EMPTY_DETAILS);
  const b = normalise(next);
  return FIELDS.filter((f) => !sameValue(value(a, f), value(b, f)));
}

/**
 * G2: the details whose change is shown to the person before it is saved and noticed to others after (AC-9.1,
 * AC-9.8). In `FIELDS` order.
 */
export const PROTECTED_FIELDS = ["legalName", "vatNumber", "iban"] as const satisfies readonly Field[];
export type ProtectedField = (typeof PROTECTED_FIELDS)[number];

/**
 * The protected fields among `changed` (what `changedFields` returned: after normalisation, so a different spacing or
 * case of the same IBAN is not in it), in `PROTECTED_FIELDS` order. A protected change is a non-empty answer;
 * filling an empty value and emptying a filled one count (they differ from "" after normalisation).
 */
export function protectedChanged(changed: readonly Field[]): ProtectedField[] {
  return PROTECTED_FIELDS.filter((f) => changed.includes(f));
}

/** AC-2.1: equal after normalisation (IBAN spaces/case, trailing blanks, blank address lines, NFD vs NFC). */
export function sameDetails(a: LegalDetails, b: LegalDetails): boolean {
  return changedFields(a, b).length === 0;
}
