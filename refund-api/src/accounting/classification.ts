/**
 * Pure, DB-free resolution of a WellD CH line's accounting classification
 * (T4, specs/20261118-refund-accounting-export; AC-1.3, AC-1.6, AC-2.7,
 * AC-3.1, AC-3.2, AC-3.4, AC-3.9; ADR 20261118-accounting-classification-is-
 * live-until-approval-then-frozen-...).
 *
 * THE ONE FUNCTION behind four places that must never disagree: the review
 * view (`GET /review/requests/{id}/accounting`), the approval freeze, the
 * release backfill, and the export blockers. Each of them loads the same
 * inputs (the line with its stored classification, the type defaults, the
 * foreign-currency designation, each catalog entry with its current `active`)
 * and calls this.
 *
 * Rules, per half (account, VAT code) independently:
 *
 * 1. A value STORED on the line wins: an accounting override before approval,
 *    the frozen value after it. It is returned as stored, with its own
 *    `active` flag, even if the entry was deactivated since (AC-1.3, AC-1.6:
 *    "lines already carrying it keep it unchanged"). Its `*IsDefault` flag is
 *    the stored one (`null` counts as "set by hand").
 * 2. Otherwise the LIVE default applies, marked `*IsDefault: true`:
 *    - account: the default account of the line's expense type;
 *    - VAT code: for a CHF line the default VAT code of the expense type, for
 *      any other currency the foreign-currency VAT code (AC-3.1, AC-3.2). The
 *      type's own default VAT code is NOT used for a non-CHF line.
 * 3. A default that points at an INACTIVE entry is no default (G3, AC-2.7): the
 *    half resolves to `null` and is listed in `missing`. This covers a type's
 *    default account, a type's default VAT code and the designation of the
 *    foreign-currency VAT code (unset, cleared or deactivated alike).
 *    Freezing a default at approval is a new classification, and an inactive
 *    entry can no longer be chosen for one (AC-1.3).
 * 4. `missing` lists what approval would refuse (AC-3.4): `"account"` and/or
 *    `"vatCode"`, in that order. A stored value is never missing, active or not.
 *
 * Returns `null` (no classification at all, AC-3.9) for a WellD Italia line
 * and for a rejected line, whatever is stored on them.
 */

import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";

/** A ledger account as the resolver needs it: the entry and whether it is active now. */
export interface AccountRef {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly active: boolean;
}

/** A VAT code as the resolver needs it: the entry and whether it is active now. */
export interface VatCodeRef {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly rateBasisPoints: number;
  readonly active: boolean;
}

/** The line, with the classification stored on it (null = follow the live default). */
export interface ClassifiableLine {
  readonly entity: Entity;
  readonly currency: Currency;
  readonly type: ExpenseType;
  /** `rejectionReason` is set: a rejected line has no classification. */
  readonly rejected: boolean;
  readonly ledgerAccount: AccountRef | null;
  readonly ledgerAccountIsDefault: boolean | null;
  readonly vatCode: VatCodeRef | null;
  readonly vatCodeIsDefault: boolean | null;
}

/** The current default of one expense type for WellD CH (either half may be unset). */
export interface TypeDefaults {
  readonly account: AccountRef | null;
  readonly vatCode: VatCodeRef | null;
}

/** The type defaults, keyed by expense type; a type with no entry has no default. */
export type TypeDefaultsByType = Readonly<Partial<Record<ExpenseType, TypeDefaults>>>;

export type MissingPart = "account" | "vatCode";

export interface Classification {
  readonly account: AccountRef | null;
  readonly accountIsDefault: boolean;
  readonly vatCode: VatCodeRef | null;
  readonly vatCodeIsDefault: boolean;
  readonly missing: readonly MissingPart[];
}

/**
 * @param line the line with its stored classification
 * @param defaults the current type defaults of WellD CH, each entry with its `active`
 * @param foreignCurrencyVatCode the designated foreign-currency VAT code with its
 *   `active`, or `null` when none is designated (never set, or cleared)
 */
export function resolveClassification(
  line: ClassifiableLine,
  defaults: TypeDefaultsByType,
  foreignCurrencyVatCode: VatCodeRef | null,
): Classification | null {
  if (line.entity !== "welld_ch" || line.rejected) return null;

  const typeDefaults = defaults[line.type];

  // ── Account ─────────────────────────────────────────────────────────────
  let account: AccountRef | null;
  let accountIsDefault: boolean;
  if (line.ledgerAccount !== null) {
    account = line.ledgerAccount;
    accountIsDefault = line.ledgerAccountIsDefault === true;
  } else {
    const candidate = typeDefaults?.account ?? null;
    account = candidate !== null && candidate.active ? candidate : null;
    accountIsDefault = account !== null;
  }

  // ── VAT code ────────────────────────────────────────────────────────────
  let vatCode: VatCodeRef | null;
  let vatCodeIsDefault: boolean;
  if (line.vatCode !== null) {
    vatCode = line.vatCode;
    vatCodeIsDefault = line.vatCodeIsDefault === true;
  } else {
    const candidate = line.currency === "CHF" ? (typeDefaults?.vatCode ?? null) : foreignCurrencyVatCode;
    vatCode = candidate !== null && candidate.active ? candidate : null;
    vatCodeIsDefault = vatCode !== null;
  }

  const missing: MissingPart[] = [];
  if (account === null) missing.push("account");
  if (vatCode === null) missing.push("vatCode");

  return { account, accountIsDefault, vatCode, vatCodeIsDefault, missing };
}
