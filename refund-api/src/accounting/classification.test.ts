/**
 * Unit tests for `resolveClassification` on copies and a snapshot (T4 of specs/20261118-refund-accounting-export, reworked
 * by T18 of specs/20261119-accounting; AC-4.5 with SA-3, AC-6.3, AC-6.9, AC-4.9, AC-5.3, AC-4.7 and the G3 / G8a readings).
 *
 * Pure: no DB, no env. The snapshot is built from wire data, so "active / deactivated / absent / unreadable" are the real
 * states the real client yields.
 */

import { describe, expect, it } from "bun:test";
import type { ReferenceDataWire } from "./accountingWire";
import {
  basisPointsToPercent,
  classifiableInput,
  formatRate,
  resolveClassification,
  type ClassifiableLine,
  type RecordedVat,
  type TypeDefaultsByType,
} from "./classification";
import { referenceSnapshot, UNVERIFIED_SNAPSHOT, type ReferenceSnapshot } from "./referenceSnapshot";
import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";
import { readClassifiedDetail } from "../requests/audit";

const account = (number: string, name = `Account ${number}`) => ({ number, name });
const recVat = (code: string, rateBasisPoints: number): RecordedVat => ({ code, label: `VAT ${code}`, rateBasisPoints });

const ACC_TRAIN = account("5901");
const ACC_OTHER = account("6101");
const IMP81 = recVat("IMP81", 810);
const NOVAT = recVat("NOVAT", 0);
const IMP77 = recVat("IMP77", 770);

const DEFAULTS: TypeDefaultsByType = {
  travel_train: { account: ACC_TRAIN, vatCode: IMP81 },
  postal: { account: account("6104"), vatCode: NOVAT },
  representation_gifts: { account: null, vatCode: IMP81 }, // no matching account in the register
  company_manuals: { account: ACC_OTHER, vatCode: null }, // no default VAT code
};

/** Accounting as it is: every account and VAT code above, active, unless listed in `off`. `absent` entries are not listed. */
function accounting(off: string[] = [], absent: string[] = []): ReferenceSnapshot {
  const data: ReferenceDataWire = {
    entity: "welld_ch",
    ownCurrency: "CHF",
    ledgerAccounts: [ACC_TRAIN, ACC_OTHER, account("6104")]
      .filter((a) => !absent.includes(a.number))
      .map((a) => ({ ...a, active: !off.includes(a.number) })),
    vatCodes: [IMP81, NOVAT, IMP77]
      .filter((v) => !absent.includes(v.code))
      .map((v) => ({ code: v.code, label: v.label, rateBasisPoints: v.rateBasisPoints, active: !off.includes(v.code) })),
  };
  return referenceSnapshot(data);
}
const LIVE = accounting();

function line(overrides: Partial<ClassifiableLine> = {}): ClassifiableLine {
  return {
    entity: "welld_ch" as Entity,
    currency: "CHF" as Currency,
    type: "travel_train" as ExpenseType,
    rejected: false,
    account: null,
    accountIsDefault: null,
    vatCode: null,
    vatCodeIsDefault: null,
    ...overrides,
  };
}

describe("CHF line: the type's defaults (AC-4.5, D11)", () => {
  it("shows the default account and VAT code of its type, both marked default, active, with Accounting's values", () => {
    expect(resolveClassification(line(), DEFAULTS, NOVAT, LIVE)).toEqual({
      account: { number: "5901", name: "Account 5901", state: "active" },
      accountIsDefault: true,
      vatCode: { code: "IMP81", rateBasisPoints: 810, label: "VAT IMP81", state: "active" },
      vatCodeIsDefault: true,
      bookable: { account: { number: "5901", name: "Account 5901" }, vatCode: { code: "IMP81", rateBasisPoints: 810 } },
      missing: [],
    });
  });

  it("books Accounting's CURRENT name, not the recorded one (D11: a default's values taken from the snapshot)", () => {
    const renamed = referenceSnapshot({
      entity: "welld_ch",
      ownCurrency: "CHF",
      ledgerAccounts: [{ number: "5901", name: "Treno e bus", active: true }],
      vatCodes: [{ code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true }],
    });
    const result = resolveClassification(line(), DEFAULTS, null, renamed);
    expect(result?.bookable.account).toEqual({ number: "5901", name: "Treno e bus" });
    expect(result?.account).toMatchObject({ name: "Treno e bus", state: "active" });
    expect(result?.vatCode).toMatchObject({ label: "IVA 8.1%" });
  });

  it("ignores the foreign-currency designation entirely", () => {
    expect(resolveClassification(line(), DEFAULTS, IMP77, LIVE)).toEqual(resolveClassification(line(), DEFAULTS, null, LIVE));
  });

  it("uses each type's own defaults", () => {
    const postal = resolveClassification(line({ type: "postal" }), DEFAULTS, null, LIVE);
    expect(postal?.account?.number).toBe("6104");
    expect(postal?.vatCode?.code).toBe("NOVAT");
  });
});

describe("EUR / USD / GBP lines: the type's account and the foreign-currency VAT code (AC-3.2 of 20261118)", () => {
  for (const currency of ["EUR", "USD", "GBP"] as const) {
    it(`${currency}: type account + designation, both marked default; the type's own VAT default is NOT used`, () => {
      const result = resolveClassification(line({ currency }), DEFAULTS, NOVAT, LIVE);
      expect(result).toMatchObject({
        account: { number: "5901", state: "active" },
        accountIsDefault: true,
        vatCode: { code: "NOVAT", rateBasisPoints: 0, state: "active" },
        vatCodeIsDefault: true,
        missing: [],
      });
    });
  }

  it("the designation is used even when the type has no default VAT code of its own", () => {
    const result = resolveClassification(line({ currency: "EUR", type: "company_manuals" }), DEFAULTS, NOVAT, LIVE);
    expect(result?.vatCode?.code).toBe("NOVAT");
    expect(result?.missing).toEqual([]);
  });
});

describe("a default whose entry is not active is reported, with its state, and is no default for approval (G8a, AC-4.5, SA-3)", () => {
  it("a deactivated default account: shown with state deactivated and isDefault true, never null; account is missing", () => {
    const result = resolveClassification(line(), DEFAULTS, null, accounting(["5901"]));
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "deactivated" },
      accountIsDefault: true,
      vatCode: { code: "IMP81", state: "active" },
      vatCodeIsDefault: true,
      missing: ["account"],
    });
    expect(result?.bookable.account).toBeNull();
    expect(result?.bookable.vatCode).toEqual({ code: "IMP81", rateBasisPoints: 810 });
  });

  it("a default no longer found in Accounting: state not_found, shown as recorded, missing (SA-3)", () => {
    const result = resolveClassification(line(), DEFAULTS, null, accounting([], ["5901", "IMP81"]));
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "not_found" },
      vatCode: { code: "IMP81", label: "VAT IMP81", rateBasisPoints: 810, state: "not_found" },
      accountIsDefault: true,
      vatCodeIsDefault: true,
      missing: ["account", "vatCode"],
    });
  });

  it("Accounting unreadable: the recorded default is shown, state unverified, never bookable (AC-6.9)", () => {
    const result = resolveClassification(line(), DEFAULTS, null, UNVERIFIED_SNAPSHOT);
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "unverified" },
      vatCode: { code: "IMP81", label: "VAT IMP81", state: "unverified" },
      accountIsDefault: true,
      vatCodeIsDefault: true,
      missing: ["account", "vatCode"],
    });
    expect(result?.bookable).toEqual({ account: null, vatCode: null });
  });

  it("a deactivated VAT code default: a CHF line has the code shown deactivated and missing; an EUR line uses the designation", () => {
    const snapshot = accounting(["IMP81"]);
    expect(resolveClassification(line(), DEFAULTS, NOVAT, snapshot)).toMatchObject({
      vatCode: { code: "IMP81", state: "deactivated" },
      missing: ["vatCode"],
    });
    expect(resolveClassification(line({ currency: "EUR" }), DEFAULTS, NOVAT, snapshot)).toMatchObject({
      vatCode: { code: "NOVAT", state: "active" },
      missing: [],
    });
  });

  for (const [label, designation, snapshot, state] of [
    ["unset or cleared (null)", null, LIVE, null],
    ["designated but deactivated", NOVAT, accounting(["NOVAT"]), "deactivated"],
    ["designated but no longer found", NOVAT, accounting([], ["NOVAT"]), "not_found"],
  ] as const) {
    it(`foreign-currency designation ${label}: the account stays, the VAT code is missing${state ? `, shown ${state}` : ", null"}`, () => {
      const result = resolveClassification(line({ currency: "EUR" }), DEFAULTS, designation, snapshot);
      expect(result?.missing).toEqual(["vatCode"]);
      expect(result?.account).toMatchObject({ number: "5901", state: "active" });
      if (state === null) {
        expect(result?.vatCode).toBeNull();
        expect(result?.vatCodeIsDefault).toBe(false);
      } else {
        expect(result?.vatCode).toMatchObject({ code: "NOVAT", state });
        expect(result?.vatCodeIsDefault).toBe(true);
      }
    });
  }

  it("reactivated, the same default is back with no further step (AC-1.9, AC-1.10)", () => {
    expect(resolveClassification(line(), DEFAULTS, null, accounting(["5901"]))?.missing).toEqual(["account"]);
    expect(resolveClassification(line(), DEFAULTS, null, accounting())?.missing).toEqual([]);
  });

  it("both halves unusable -> both missing, account first", () => {
    expect(resolveClassification(line(), DEFAULTS, null, accounting(["5901", "IMP81"]))?.missing).toEqual(["account", "vatCode"]);
  });
});

describe("types with no default, and no default of a half (AC-6.3)", () => {
  it("a type with no entry at all has nothing: both null, both missing", () => {
    const result = resolveClassification(line({ type: "stationery" }), DEFAULTS, NOVAT, LIVE);
    expect(result).toMatchObject({ account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false, missing: ["account", "vatCode"] });
  });

  it("a type with no default account is missing the account only", () => {
    const result = resolveClassification(line({ type: "representation_gifts" }), DEFAULTS, null, LIVE);
    expect(result?.missing).toEqual(["account"]);
    expect(result?.vatCode?.code).toBe("IMP81");
  });

  it("a type with no default VAT code is missing the VAT code on a CHF line only", () => {
    expect(resolveClassification(line({ type: "company_manuals" }), DEFAULTS, NOVAT, LIVE)?.missing).toEqual(["vatCode"]);
    expect(resolveClassification(line({ type: "company_manuals", currency: "USD" }), DEFAULTS, NOVAT, LIVE)?.missing).toEqual([]);
  });

  it("an empty defaults table: everything is missing, no throw", () => {
    expect(resolveClassification(line(), {}, null, LIVE)?.missing).toEqual(["account", "vatCode"]);
  });
});

describe("stored copies are kept, exactly as stored (AC-5.3, AC-5.7, AC-1.4 of 20261118)", () => {
  it("a copy on a deactivated account is kept, bookable, shown with state deactivated, and not missing", () => {
    const result = resolveClassification(
      line({ account: account("5901", "Treno (old name)"), accountIsDefault: false }),
      DEFAULTS,
      null,
      accounting(["5901"]),
    );
    expect(result?.account).toEqual({ number: "5901", name: "Treno (old name)", state: "deactivated" });
    expect(result?.accountIsDefault).toBe(false);
    expect(result?.bookable.account).toEqual({ number: "5901", name: "Treno (old name)" });
    expect(result?.missing).toEqual([]);
  });

  it("a copy on a VAT code that vanished: kept, not_found, label unknown, not missing", () => {
    const result = resolveClassification(
      line({ vatCode: { code: "IMP81", rateBasisPoints: 810 }, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
      accounting([], ["IMP81"]),
    );
    expect(result?.vatCode).toEqual({ code: "IMP81", rateBasisPoints: 810, label: null, state: "not_found" });
    expect(result?.missing).toEqual([]);
  });

  it("a copy is shown as stored even if Accounting now holds another name or rate for that key", () => {
    const reentered = referenceSnapshot({
      entity: "welld_ch",
      ownCurrency: "CHF",
      ledgerAccounts: [{ number: "5901", name: "Something else", active: true }],
      vatCodes: [{ code: "IMP81", label: "IVA", rateBasisPoints: 770, active: true }],
    });
    const result = resolveClassification(
      line({ account: account("5901", "Treno"), accountIsDefault: false, vatCode: { code: "IMP81", rateBasisPoints: 810 }, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
      reentered,
    );
    expect(result?.account).toMatchObject({ name: "Treno", state: "active" });
    expect(result?.vatCode).toMatchObject({ rateBasisPoints: 810, state: "active" });
    expect(result?.bookable).toEqual({ account: account("5901", "Treno"), vatCode: { code: "IMP81", rateBasisPoints: 810 } });
  });

  it("a copy wins over the default and is not marked default; an unreadable Accounting leaves it bookable, state unverified", () => {
    const result = resolveClassification(
      line({ account: ACC_OTHER, accountIsDefault: false, vatCode: { code: "NOVAT", rateBasisPoints: 0 }, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
      UNVERIFIED_SNAPSHOT,
    );
    expect(result).toMatchObject({
      account: { number: "6101", state: "unverified" },
      accountIsDefault: false,
      vatCode: { code: "NOVAT", label: null, state: "unverified" },
      vatCodeIsDefault: false,
      missing: [],
    });
  });

  it("a copy on one half leaves the other half following the live default", () => {
    const result = resolveClassification(line({ account: ACC_OTHER, accountIsDefault: false }), DEFAULTS, null, LIVE);
    expect(result?.account).toMatchObject({ number: "6101" });
    expect(result?.accountIsDefault).toBe(false);
    expect(result?.vatCode?.code).toBe("IMP81");
    expect(result?.vatCodeIsDefault).toBe(true);
  });

  it("a copy fills a gap: a type with no default plus a chosen account and VAT code is complete", () => {
    const result = resolveClassification(
      line({ type: "stationery", account: ACC_OTHER, accountIsDefault: false, vatCode: { code: "IMP77", rateBasisPoints: 770 }, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
      LIVE,
    );
    expect(result?.missing).toEqual([]);
  });

  it("an approved line (no defaults passed) never follows a default again, and a half left unset stays missing", () => {
    const booked = line({ account: ACC_TRAIN, accountIsDefault: true });
    const result = resolveClassification(booked, {}, null, LIVE);
    expect(result?.account).toMatchObject({ number: "5901" });
    expect(result?.accountIsDefault).toBe(true);
    expect(result?.vatCode).toBeNull();
    expect(result?.missing).toEqual(["vatCode"]);
  });

  it("a stored copy whose flag is null counts as set by hand", () => {
    const result = resolveClassification(line({ account: ACC_OTHER, accountIsDefault: null }), DEFAULTS, null, LIVE);
    expect(result?.accountIsDefault).toBe(false);
  });
});

describe("no classification at all (AC-4.9)", () => {
  it("a WellD Italia line -> null, in every currency, with or without stored copies", () => {
    for (const currency of ["CHF", "EUR", "USD", "GBP"] as const) {
      expect(resolveClassification(line({ entity: "welld_it", currency }), DEFAULTS, NOVAT, LIVE)).toBeNull();
    }
    expect(resolveClassification(line({ entity: "welld_it", account: ACC_TRAIN }), DEFAULTS, NOVAT, LIVE)).toBeNull();
  });

  it("a rejected WellD CH line -> null, even if it carries a stored copy", () => {
    expect(resolveClassification(line({ rejected: true }), DEFAULTS, NOVAT, LIVE)).toBeNull();
    expect(resolveClassification(line({ rejected: true, account: ACC_TRAIN, accountIsDefault: false }), DEFAULTS, NOVAT, LIVE)).toBeNull();
  });
});

describe("structural guarantees", () => {
  it("`missing` is exactly the halves with nothing bookable, whatever the inputs", () => {
    const snapshots = [LIVE, accounting(["5901", "IMP81"]), accounting([], ["5901", "IMP81", "NOVAT"]), UNVERIFIED_SNAPSHOT];
    const stored = [
      {},
      { account: ACC_OTHER, accountIsDefault: false },
      { vatCode: { code: "IMP77", rateBasisPoints: 770 }, vatCodeIsDefault: false },
    ] as Partial<ClassifiableLine>[];
    for (const snapshot of snapshots) {
      for (const over of stored) {
        for (const currency of ["CHF", "EUR"] as const) {
          for (const type of ["travel_train", "stationery", "company_manuals"] as const) {
            for (const designation of [null, NOVAT]) {
              const result = resolveClassification(line({ ...over, currency, type }), DEFAULTS, designation, snapshot)!;
              const expected = [result.bookable.account === null ? "account" : null, result.bookable.vatCode === null ? "vatCode" : null].filter(Boolean);
              expect(result.missing).toEqual(expected as never);
              // a bookable half is always shown; an unshown half is never bookable
              if (result.account === null) expect(result.bookable.account).toBeNull();
              if (result.vatCode === null) expect(result.bookable.vatCode).toBeNull();
            }
          }
        }
      }
    }
  });

  it("does not mutate its inputs", () => {
    const l = line({ account: ACC_OTHER, accountIsDefault: false });
    const before = JSON.stringify([l, DEFAULTS, NOVAT]);
    resolveClassification(l, DEFAULTS, NOVAT, LIVE);
    expect(JSON.stringify([l, DEFAULTS, NOVAT])).toBe(before);
  });
});

describe("classifiableInput reads the copy columns, never the old foreign keys", () => {
  const row = {
    entity: "welld_ch" as Entity,
    currency: "EUR" as Currency,
    type: "postal" as ExpenseType,
    rejectionReason: null,
    accountNumber: "6104",
    accountName: "Porto",
    vatCodeCopy: "IMP81",
    vatRateBasisPoints: 810,
    ledgerAccountIsDefault: false,
    vatCodeIsDefault: true,
  };

  it("maps the copies", () => {
    expect(classifiableInput(row)).toEqual({
      entity: "welld_ch",
      currency: "EUR",
      type: "postal",
      rejected: false,
      account: { number: "6104", name: "Porto" },
      accountIsDefault: false,
      vatCode: { code: "IMP81", rateBasisPoints: 810 },
      vatCodeIsDefault: true,
    });
  });

  it("a half with no copy is null; a rejection reason makes the line rejected", () => {
    const empty = classifiableInput({ ...row, accountNumber: null, accountName: null, vatCodeCopy: null, vatRateBasisPoints: null, rejectionReason: "no receipt" });
    expect(empty.account).toBeNull();
    expect(empty.vatCode).toBeNull();
    expect(empty.rejected).toBe(true);
  });

  it("the old foreign-key fields of a row are ignored", () => {
    const withFk = { ...row, ledgerAccountId: "old-id", vatCodeId: "old-vat", ledgerAccount: { id: "x", number: "9999", name: "old" } };
    expect(classifiableInput(withFk).account).toEqual({ number: "6104", name: "Porto" });
  });
});

describe("display formats", () => {
  it("basis points as a percentage", () => {
    expect([810, 770, 805, 0, 10000].map(basisPointsToPercent)).toEqual(["8.1", "7.7", "8.05", "0", "100"]);
    expect(() => basisPointsToPercent(-1)).toThrow(RangeError);
  });
  it("a rate has four to six decimals", () => {
    expect([924600, 1_063_500, 780_800, 1_234_567, 5].map(formatRate)).toEqual(["0.9246", "1.0635", "0.7808", "1.234567", "0.000005"]);
  });
});

describe("audit detail v2 and its readers (D34, AC-5.1, AC-5.2)", () => {
  const v2 = {
    v: 2,
    cause: "approval",
    account: { from: null, to: { number: "5901", name: "Treno" }, fromDefault: true, toDefault: true },
    vatCode: { from: null, to: { code: "IMP81", rateBasisPoints: 810 }, fromDefault: true, toDefault: true },
    fxRate: { rateMicros: 924600, month: "2026-03" },
  };

  it("reads a v2 row as it is, with its fx rate or its pending marker", () => {
    expect(readClassifiedDetail(v2)).toEqual({
      v: 2,
      cause: "approval",
      account: { from: null, to: { number: "5901", name: "Treno" }, fromDefault: true, toDefault: true },
      vatCode: { from: null, to: { code: "IMP81", rateBasisPoints: 810 }, fromDefault: true, toDefault: true },
      fxRate: { rateMicros: 924600, month: "2026-03" },
    });
    expect(readClassifiedDetail({ ...v2, fxRate: "pending" })?.fxRate).toBe("pending");
    const { fxRate: _omitted, ...withoutFx } = v2;
    expect(readClassifiedDetail(withoutFx)).not.toHaveProperty("fxRate");
  });

  it("accepts a v1 row of 20261118 (ids, no name, no version): the number is kept, the name is unknown", () => {
    const v1 = {
      cause: "review",
      account: { from: { id: "x", number: "5901" }, to: { id: "y", number: "6101" }, fromDefault: true, toDefault: false },
      vatCode: { from: { id: "v", code: "IMP81", rateBasisPoints: 810 }, to: { id: "v", code: "IMP81", rateBasisPoints: 810 }, fromDefault: true, toDefault: true },
    };
    expect(readClassifiedDetail(v1)).toEqual({
      v: 1,
      cause: "review",
      account: { from: { number: "5901", name: null }, to: { number: "6101", name: null }, fromDefault: true, toDefault: false },
      vatCode: { from: { code: "IMP81", rateBasisPoints: 810 }, to: { code: "IMP81", rateBasisPoints: 810 }, fromDefault: true, toDefault: true },
    });
  });

  it("is null, never a throw, for anything that is not a classification detail", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { cause: "review" }, { cause: 1, account: {}, vatCode: {} }]) {
      expect(readClassifiedDetail(bad)).toBeNull();
    }
  });
});
