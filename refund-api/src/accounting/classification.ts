/**
 * Pure, DB-free resolution of a WellD CH line's accounting classification, on COPIES and a snapshot of Accounting
 * (specs/20261119-accounting T18; AC-4.4, AC-4.5, AC-4.7, AC-6.3, AC-6.9, AC-3.7; D1, D13; ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-... and, as amended, ADR 20261118-accounting-
 * classification-is-live-until-approval-then-frozen-...; first written as T4 of specs/20261118-refund-accounting-export).
 *
 * THE ONE FUNCTION behind the places that must never disagree: the review view (`GET /review/requests/{id}/accounting`),
 * the approval, the release backfill and the export blockers. Each of them loads the same inputs (the line with the copies
 * stored on it, Refund's recorded defaults, a snapshot of Accounting's reference data) and calls this.
 *
 * What a line holds is a COPY, keyed by Accounting's natural key: an account's number and name, a VAT code's code and
 * rate. Refund's own recorded defaults are copies too (number, name, code, label, rate). A snapshot says what Accounting
 * holds NOW for a number or a code: `active`, `deactivated`, `not_found`, or `unverified` when Accounting cannot be read.
 *
 * Rules, per half (account, VAT code) independently:
 *
 * 1. A copy STORED on the line wins: a hand classification before approval, the booked value after it. It is returned as
 *    stored (it is what the line BOOKS: AC-5.3), and it is always bookable, whatever Accounting says of the entry now
 *    (AC-1.4 of 20261118: "lines already carrying it keep it unchanged"). Its state is Accounting's present state of
 *    the entry, for information only. Its `*IsDefault` flag is the stored one (`null` counts as "set by hand").
 * 2. Otherwise the LIVE default applies, marked `*IsDefault: true`:
 *    - account: the recorded default account of the line's expense type;
 *    - VAT code: for a CHF line the recorded default VAT code of the expense type, for any other currency the recorded
 *      foreign-currency VAT code (AC-3.1, AC-3.2 of 20261118). The type's own VAT code is NOT used for a non-CHF line.
 * 3. A default is BOOKABLE only when its entry is `active` in the snapshot. The booked values are then Accounting's
 *    current ones (D11: "a default's values taken from the snapshot"). A default whose entry is deactivated, no longer
 *    found, or unverifiable is not bookable, so the half is `missing` for approval (AC-6.3, AC-4.5 with SA-3), but it is
 *    still REPORTED, with its recorded values, its state and `isDefault: true`, never as `null`: `null` means "no default
 *    set" (G8a). When the snapshot is not available the state is `unverified`, and the recorded values are shown.
 * 4. `missing` lists what approval would refuse (AC-6.3): `"account"` and/or `"vatCode"`, in that order.
 *
 * Returns `null` (no classification at all, AC-4.9) for a WellD Italia line and for a rejected line, whatever is stored.
 */

import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";
import type { ReferenceSnapshot, ReferenceState } from "./referenceSnapshot";

/** An account copy: the number is the natural key, the name is what it was called when copied. */
export interface AccountCopy {
  readonly number: string;
  readonly name: string;
}

/** A VAT code copy: the code is the natural key, the rate is in basis points (8.1 % = 810) and never changes. */
export interface VatCopy {
  readonly code: string;
  readonly rateBasisPoints: number;
}

/** A VAT code as Refund recorded it with a default: the copy and the label it was shown with (D13). */
export interface RecordedVat extends VatCopy {
  readonly label: string;
}

/** The line, with the copies stored on it (null = follow the live default). */
export interface ClassifiableLine {
  readonly entity: Entity;
  readonly currency: Currency;
  readonly type: ExpenseType;
  /** `rejectionReason` is set: a rejected line has no classification. */
  readonly rejected: boolean;
  readonly account: AccountCopy | null;
  readonly accountIsDefault: boolean | null;
  readonly vatCode: VatCopy | null;
  readonly vatCodeIsDefault: boolean | null;
}

/** The columns of a `refund_line` row that `classifiableInput` reads. */
export interface LineCopyColumns {
  readonly entity: Entity;
  readonly currency: Currency;
  readonly type: ExpenseType;
  readonly rejectionReason: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  /** The copy of the VAT code (column `"vatCode"`); the Prisma field `vatCode` is still the old relation (T24). */
  readonly vatCodeCopy: string | null;
  readonly vatRateBasisPoints: number | null;
  readonly ledgerAccountIsDefault: boolean | null;
  readonly vatCodeIsDefault: boolean | null;
}

/** What `resolveClassification` needs of a line row: its facts and the copies stored on it. Never reads the old FK columns. */
export function classifiableInput(line: LineCopyColumns): ClassifiableLine {
  return {
    entity: line.entity,
    currency: line.currency,
    type: line.type,
    rejected: line.rejectionReason !== null,
    account: line.accountNumber !== null && line.accountName !== null ? { number: line.accountNumber, name: line.accountName } : null,
    accountIsDefault: line.ledgerAccountIsDefault,
    vatCode:
      line.vatCodeCopy !== null && line.vatRateBasisPoints !== null
        ? { code: line.vatCodeCopy, rateBasisPoints: line.vatRateBasisPoints }
        : null,
    vatCodeIsDefault: line.vatCodeIsDefault,
  };
}

/** The recorded default of one expense type for WellD CH (either half may be unset). */
export interface TypeDefaults {
  readonly account: AccountCopy | null;
  readonly vatCode: RecordedVat | null;
}

/** The recorded defaults, keyed by expense type; a type with no entry has no default. */
export type TypeDefaultsByType = Readonly<Partial<Record<ExpenseType, TypeDefaults>>>;

/** Refund's recorded defaults: the type defaults and the foreign-currency VAT code, as copies. */
export interface RecordedDefaults {
  readonly defaults: TypeDefaultsByType;
  readonly foreignCurrencyVatCode: RecordedVat | null;
}

export type MissingPart = "account" | "vatCode";

/** An account as the line shows it: the copy (or the default) and Accounting's present state of the entry. */
export interface ShownAccount extends AccountCopy {
  readonly state: ReferenceState;
}

/** A VAT code as the line shows it. `label` is Accounting's, or the recorded one of a default; `null` when neither is known. */
export interface ShownVatCode extends VatCopy {
  readonly label: string | null;
  readonly state: ReferenceState;
}

export interface Classification {
  readonly account: ShownAccount | null;
  readonly accountIsDefault: boolean;
  readonly vatCode: ShownVatCode | null;
  readonly vatCodeIsDefault: boolean;
  /**
   * What an approval books right now: the stored copy, or the CURRENT entry of an active default. `null` for a half that
   * is `missing`.
   */
  readonly bookable: { readonly account: AccountCopy | null; readonly vatCode: VatCopy | null };
  readonly missing: readonly MissingPart[];
}

/**
 * @param line the line with its stored copies
 * @param defaults the recorded defaults of WellD CH (`{}` for an approved line: it never follows a default again)
 * @param foreignCurrencyVatCode the recorded foreign-currency VAT code, or `null` when none is designated (never set, or
 *   cleared)
 * @param snapshot Accounting's reference data as one operation read it, or `UNVERIFIED_SNAPSHOT`
 */
export function resolveClassification(
  line: ClassifiableLine,
  defaults: TypeDefaultsByType,
  foreignCurrencyVatCode: RecordedVat | null,
  snapshot: ReferenceSnapshot,
): Classification | null {
  if (line.entity !== "welld_ch" || line.rejected) return null;

  const typeDefaults = defaults[line.type];

  // ── Account ─────────────────────────────────────────────────────────────
  let account: ShownAccount | null;
  let accountIsDefault: boolean;
  let bookableAccount: AccountCopy | null;
  if (line.account !== null) {
    const found = snapshot.lookupAccount(line.account.number);
    account = { ...line.account, state: found.state };
    accountIsDefault = line.accountIsDefault === true;
    bookableAccount = line.account;
  } else {
    const candidate = typeDefaults?.account ?? null;
    if (candidate === null) {
      account = null;
      bookableAccount = null;
    } else {
      const found = snapshot.lookupAccount(candidate.number);
      if (found.state === "active") {
        account = { number: found.number, name: found.name, state: "active" };
        bookableAccount = { number: found.number, name: found.name };
      } else {
        account = { number: candidate.number, name: candidate.name, state: found.state };
        bookableAccount = null;
      }
    }
    accountIsDefault = account !== null;
  }

  // ── VAT code ────────────────────────────────────────────────────────────
  let vatCode: ShownVatCode | null;
  let vatCodeIsDefault: boolean;
  let bookableVat: VatCopy | null;
  if (line.vatCode !== null) {
    const found = snapshot.lookupVat(line.vatCode.code);
    vatCode = {
      ...line.vatCode,
      label: found.state === "active" || found.state === "deactivated" ? found.label : null,
      state: found.state,
    };
    vatCodeIsDefault = line.vatCodeIsDefault === true;
    bookableVat = line.vatCode;
  } else {
    const candidate = line.currency === "CHF" ? (typeDefaults?.vatCode ?? null) : foreignCurrencyVatCode;
    if (candidate === null) {
      vatCode = null;
      bookableVat = null;
    } else {
      const found = snapshot.lookupVat(candidate.code);
      if (found.state === "active") {
        vatCode = { code: found.code, rateBasisPoints: found.rateBasisPoints, label: found.label, state: "active" };
        bookableVat = { code: found.code, rateBasisPoints: found.rateBasisPoints };
      } else {
        vatCode = { code: candidate.code, rateBasisPoints: candidate.rateBasisPoints, label: candidate.label, state: found.state };
        bookableVat = null;
      }
    }
    vatCodeIsDefault = vatCode !== null;
  }

  const missing: MissingPart[] = [];
  if (bookableAccount === null) missing.push("account");
  if (bookableVat === null) missing.push("vatCode");

  return {
    account,
    accountIsDefault,
    vatCode,
    vatCodeIsDefault,
    bookable: { account: bookableAccount, vatCode: bookableVat },
    missing,
  };
}

// ─── Display formats of the copies (pure) ────────────────────────────────────

/** 810 -> `"8.1"`, 770 -> `"7.7"`, 805 -> `"8.05"`, 0 -> `"0"`, 10000 -> `"100"`. */
export function basisPointsToPercent(basisPoints: number): string {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`basis points must be a non-negative integer, got ${String(basisPoints)}`);
  }
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** 924600 -> `"0.9246"`: the rate as a display string, at least four decimals, never more than six (as the old fx view). */
export function formatRate(rateMicros: number): string {
  const whole = Math.floor(rateMicros / 1_000_000);
  let fraction = String(rateMicros % 1_000_000).padStart(6, "0");
  while (fraction.length > 4 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

/** `"2026-03"`: the month of a `@db.Date` value (UTC midnight), which is the expense month of a line. */
export const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

/** The first day of a `YYYY-MM` month, as a `@db.Date` value. */
export const monthStart = (month: string): Date => new Date(`${month}-01T00:00:00.000Z`);
