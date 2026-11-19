/**
 * `referenceSnapshot`: one Accounting answer, looked up by natural key (specs/20261119-accounting T17; plan § Components,
 * D1, D11; AC-4.5 with SA-3, AC-6.3, AC-6.8, AC-4.3; ADR 20261119-accounting-reference-data-belongs-to-accounting-api-...).
 *
 * PURE: it holds the reference data one operation read, and answers "what is the state of this number / this code".
 * Refund keeps Accounting's NATURAL keys (an account's number, a VAT code's code), never an id (D1), so a default or a
 * copy stays valid if the entry is entered again in Accounting.
 *
 * States of an entry, in the one vocabulary Refund shows everywhere (design UX-18):
 * - `active`       Accounting lists it, and it can be chosen;
 * - `deactivated`  Accounting lists it as no longer offered: kept where it was already used, never chosen again;
 * - `not_found`    Accounting does not list it at all (SA-3): treated like deactivated;
 * - `unverified`   Accounting could not be read, so nothing is known: the value as recorded is shown, unchecked, and it is
 *                  never "usable" for a new classification.
 */

import type { LedgerAccountWire, ReferenceDataWire, VatCodeWire } from "./accountingWire";

export type ReferenceState = "active" | "deactivated" | "not_found" | "unverified";

export interface AccountEntry {
  readonly number: string;
  readonly name: string;
}
export interface VatEntry {
  readonly code: string;
  readonly label: string;
  readonly rateBasisPoints: number;
}

/** What Accounting says of one account number. `active` and `deactivated` carry the entry as Accounting holds it now. */
export type AccountLookup =
  | ({ readonly state: "active" | "deactivated" } & AccountEntry)
  | { readonly state: "not_found" | "unverified" };

export type VatLookup =
  | ({ readonly state: "active" | "deactivated" } & VatEntry)
  | { readonly state: "not_found" | "unverified" };

export interface ReferenceSnapshot {
  /** `false`: Accounting could not be read; every lookup is `unverified` and no list is offered. */
  readonly available: boolean;
  lookupAccount(number: string): AccountLookup;
  lookupVat(code: string): VatLookup;
  /** The accounts that can be chosen today, by number. */
  activeAccounts(): readonly AccountEntry[];
  /** The VAT codes that can be chosen today, by code. */
  activeVatCodes(): readonly VatEntry[];
}

/** Numbers compare as numbers first (`2620.1` after `2620`, `599` before `5905`), then as text; codes as text. */
const byKey = <T>(key: (item: T) => string) => (a: T, b: T) =>
  Number(key(a)) - Number(key(b)) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** The snapshot of one entity's reference data, as Accounting answered it. */
export function referenceSnapshot(data: ReferenceDataWire): ReferenceSnapshot {
  const accounts = new Map<string, LedgerAccountWire>(data.ledgerAccounts.map((a) => [a.number, a]));
  const vatCodes = new Map<string, VatCodeWire>(data.vatCodes.map((v) => [v.code, v]));
  return {
    available: true,
    lookupAccount(number) {
      const found = accounts.get(number);
      if (!found) return { state: "not_found" };
      return { state: found.active ? "active" : "deactivated", number: found.number, name: found.name };
    },
    lookupVat(code) {
      const found = vatCodes.get(code);
      if (!found) return { state: "not_found" };
      return {
        state: found.active ? "active" : "deactivated",
        code: found.code,
        label: found.label,
        rateBasisPoints: found.rateBasisPoints,
      };
    },
    activeAccounts() {
      return data.ledgerAccounts
        .filter((a) => a.active)
        .map((a) => ({ number: a.number, name: a.name }))
        .sort(byKey((a) => a.number));
    },
    activeVatCodes() {
      return data.vatCodes
        .filter((v) => v.active)
        .map((v) => ({ code: v.code, label: v.label, rateBasisPoints: v.rateBasisPoints }))
        .sort(byKey((v) => v.code));
    },
  };
}

/** Accounting could not be read: nothing is known about any entry (AC-6.5, AC-6.9). */
export const UNVERIFIED_SNAPSHOT: ReferenceSnapshot = {
  available: false,
  lookupAccount: () => ({ state: "unverified" }),
  lookupVat: () => ({ state: "unverified" }),
  activeAccounts: () => [],
  activeVatCodes: () => [],
};
