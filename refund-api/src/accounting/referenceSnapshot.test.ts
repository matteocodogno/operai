/**
 * `referenceSnapshot` vectors (T17, specs/20261119-accounting; AC-4.5 with SA-3, AC-4.3, AC-4.1). Pure: no env, no DB.
 *
 * A number active / deactivated / absent is `active` / `deactivated` / `not_found`; an unreadable Accounting is
 * `unverified` for everything; the offered lists are the active entries only, by natural order.
 */

import { describe, expect, it } from "bun:test";
import type { ReferenceDataWire } from "./accountingWire";
import { referenceSnapshot, UNVERIFIED_SNAPSHOT } from "./referenceSnapshot";

const DATA: ReferenceDataWire = {
  entity: "welld_ch",
  ownCurrency: "CHF",
  ledgerAccounts: [
    { number: "6101", name: "Spese materiale ufficio", active: true },
    { number: "5901", name: "Treno", active: true },
    { number: "5902", name: "Autostrada", active: false },
    { number: "610", name: "Spese varie", active: true },
  ],
  vatCodes: [
    { code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, active: true },
    { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true },
    { code: "IMP77", label: "IVA 7.7%", rateBasisPoints: 770, active: false },
  ],
};

describe("lookups by natural key", () => {
  const snapshot = referenceSnapshot(DATA);

  it("an active account is active, with the entry as Accounting holds it", () => {
    expect(snapshot.lookupAccount("5901")).toEqual({ state: "active", number: "5901", name: "Treno" });
  });
  it("a deactivated account is deactivated, still with its entry", () => {
    expect(snapshot.lookupAccount("5902")).toEqual({ state: "deactivated", number: "5902", name: "Autostrada" });
  });
  it("an absent number is not_found (SA-3)", () => {
    expect(snapshot.lookupAccount("9999")).toEqual({ state: "not_found" });
  });
  it("the key is exact: no trimming, no prefix, no case folding", () => {
    expect(snapshot.lookupAccount(" 5901")).toEqual({ state: "not_found" });
    expect(snapshot.lookupAccount("59")).toEqual({ state: "not_found" });
    expect(snapshot.lookupVat("imp81")).toEqual({ state: "not_found" });
  });
  it("VAT codes: active, deactivated, not found", () => {
    expect(snapshot.lookupVat("IMP81")).toEqual({ state: "active", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810 });
    expect(snapshot.lookupVat("IMP77")).toEqual({ state: "deactivated", code: "IMP77", label: "IVA 7.7%", rateBasisPoints: 770 });
    expect(snapshot.lookupVat("XYZ")).toEqual({ state: "not_found" });
  });
  it("is available", () => {
    expect(snapshot.available).toBe(true);
  });
});

describe("the options (AC-4.1): active entries only, in natural order", () => {
  const snapshot = referenceSnapshot(DATA);
  it("accounts", () => {
    expect(snapshot.activeAccounts().map((a) => a.number)).toEqual(["610", "5901", "6101"]);
    expect(snapshot.activeAccounts()[0]).toEqual({ number: "610", name: "Spese varie" });
  });
  it("VAT codes", () => {
    expect(snapshot.activeVatCodes().map((v) => v.code)).toEqual(["IMP81", "NOVAT"]);
  });
  it("an entity with no data offers nothing", () => {
    const empty = referenceSnapshot({ entity: "welld_ch", ownCurrency: "CHF", ledgerAccounts: [], vatCodes: [] });
    expect(empty.activeAccounts()).toEqual([]);
    expect(empty.activeVatCodes()).toEqual([]);
    expect(empty.lookupAccount("6101")).toEqual({ state: "not_found" });
  });
});

describe("Accounting unreadable", () => {
  it("everything is unverified and nothing is offered", () => {
    expect(UNVERIFIED_SNAPSHOT.available).toBe(false);
    expect(UNVERIFIED_SNAPSHOT.lookupAccount("6101")).toEqual({ state: "unverified" });
    expect(UNVERIFIED_SNAPSHOT.lookupVat("IMP81")).toEqual({ state: "unverified" });
    expect(UNVERIFIED_SNAPSHOT.activeAccounts()).toEqual([]);
    expect(UNVERIFIED_SNAPSHOT.activeVatCodes()).toEqual([]);
  });
});
