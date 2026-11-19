/**
 * Unit tests for `resolveClassification` on copies and a snapshot (T4 of specs/20261118-refund-accounting-export, reworked
 * by T18 of specs/20261119-accounting, and by T60 for the 2026-11-19 sign-off: the VAT half has no default, the account is
 * the only thing approval needs; AC-4.5 with SA-3, AC-6.3, AC-6.9, AC-4.9, AC-5.3, AC-4.7, 20261118:AC-3.1, AC-3.4, AC-3.5,
 * AC-3.11, AC-3.13 and the G3 / G8a readings).
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
  type TypeDefaultsByType,
} from "./classification";
import { referenceSnapshot, UNVERIFIED_SNAPSHOT, type ReferenceSnapshot } from "./referenceSnapshot";
import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";
import { readClassifiedDetail } from "../requests/audit";

const account = (number: string, name = `Account ${number}`) => ({ number, name });
const vat = (code: string, rateBasisPoints: number) => ({ code, label: `VAT ${code}`, rateBasisPoints });

const ACC_TRAIN = account("5901");
const ACC_OTHER = account("6101");
const IPM81 = vat("IPM81", 810);
const IP00 = vat("IP00", 0);
const IPM77 = vat("IPM77", 770);

const DEFAULTS: TypeDefaultsByType = {
  travel_train: { account: ACC_TRAIN },
  postal: { account: account("6104") },
  representation_gifts: { account: null }, // no account chosen for gifts yet
  company_manuals: { account: ACC_OTHER },
};

/** Accounting as it is: every account and VAT code above, active, unless listed in `off`. `absent` entries are not listed. */
function accounting(off: string[] = [], absent: string[] = []): ReferenceSnapshot {
  const data: ReferenceDataWire = {
    entity: "welld_ch",
    ownCurrency: "CHF",
    ledgerAccounts: [ACC_TRAIN, ACC_OTHER, account("6104")]
      .filter((a) => !absent.includes(a.number))
      .map((a) => ({ ...a, active: !off.includes(a.number) })),
    vatCodes: [IPM81, IP00, IPM77]
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
    ...overrides,
  };
}

describe("CHF line: the type's default account, and no VAT code (AC-4.5, D11, 20261118:AC-3.1)", () => {
  it("shows the default account of its type, marked default, active, with Accounting's values, and no VAT code", () => {
    expect(resolveClassification(line(), DEFAULTS, LIVE)).toEqual({
      account: { number: "5901", name: "Account 5901", state: "active" },
      accountIsDefault: true,
      vatCode: null,
      bookable: { account: { number: "5901", name: "Account 5901" }, vatCode: null },
      missing: [],
    });
  });

  it("books Accounting's CURRENT name, not the recorded one (D11: a default's values taken from the snapshot)", () => {
    const renamed = referenceSnapshot({
      entity: "welld_ch",
      ownCurrency: "CHF",
      ledgerAccounts: [{ number: "5901", name: "Treno e bus", active: true }],
      vatCodes: [{ code: "IPM81", label: "IVA 8.1%", rateBasisPoints: 810, active: true }],
    });
    const result = resolveClassification(line(), DEFAULTS, renamed);
    expect(result?.bookable.account).toEqual({ number: "5901", name: "Treno e bus" });
    expect(result?.account).toMatchObject({ name: "Treno e bus", state: "active" });
  });

  it("uses each type's own default account", () => {
    expect(resolveClassification(line({ type: "postal" }), DEFAULTS, LIVE)?.account?.number).toBe("6104");
  });

  it("never carries a flag, a default or a missing part for the VAT code", () => {
    const result = resolveClassification(line(), DEFAULTS, LIVE)!;
    expect(result).not.toHaveProperty("vatCodeIsDefault");
    expect(result.vatCode).toBeNull();
    expect(result.bookable.vatCode).toBeNull();
    expect(result.missing).not.toContain("vatCode");
  });
});

describe("EUR / USD / GBP lines are classified like CHF lines: no VAT code is pre-set (20261118:AC-3.13)", () => {
  for (const currency of ["EUR", "USD", "GBP"] as const) {
    it(`${currency}: the type's account, marked default, no VAT code, nothing missing`, () => {
      expect(resolveClassification(line({ currency }), DEFAULTS, LIVE)).toEqual(resolveClassification(line(), DEFAULTS, LIVE));
      expect(resolveClassification(line({ currency }), DEFAULTS, LIVE)).toMatchObject({
        account: { number: "5901", state: "active" },
        accountIsDefault: true,
        vatCode: null,
        missing: [],
      });
    });
  }

  it("a foreign-currency line may carry any stored active code, the reverse-charge one included (AC-3.13)", () => {
    const result = resolveClassification(
      line({ currency: "EUR", vatCode: { code: "BZM81", rateBasisPoints: 810 } }),
      DEFAULTS,
      referenceSnapshot({
        entity: "welld_ch",
        ownCurrency: "CHF",
        ledgerAccounts: [{ number: "5901", name: "Treno", active: true }],
        vatCodes: [{ code: "BZM81", label: "IVA 8.1% reverse charge", rateBasisPoints: 810, active: true }],
      }),
    );
    expect(result?.vatCode).toMatchObject({ code: "BZM81", label: "IVA 8.1% reverse charge", state: "active" });
    expect(result?.missing).toEqual([]);
  });
});

describe("a default account whose entry is not active is reported, with its state, and is no default for approval (G8a, AC-4.5, SA-3)", () => {
  it("a deactivated default account: shown with state deactivated and isDefault true, never null; account is missing", () => {
    const result = resolveClassification(line(), DEFAULTS, accounting(["5901"]));
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "deactivated" },
      accountIsDefault: true,
      vatCode: null,
      missing: ["account"],
    });
    expect(result?.bookable.account).toBeNull();
  });

  it("a default no longer found in Accounting: state not_found, shown as recorded, missing (SA-3)", () => {
    const result = resolveClassification(line(), DEFAULTS, accounting([], ["5901"]));
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "not_found" },
      accountIsDefault: true,
      missing: ["account"],
    });
  });

  it("Accounting unreadable: the recorded default is shown, state unverified, never bookable (AC-6.9)", () => {
    const result = resolveClassification(line(), DEFAULTS, UNVERIFIED_SNAPSHOT);
    expect(result).toMatchObject({
      account: { number: "5901", name: "Account 5901", state: "unverified" },
      accountIsDefault: true,
      missing: ["account"],
    });
    expect(result?.bookable).toEqual({ account: null, vatCode: null });
  });

  it("reactivated, the same default is back with no further step (AC-1.9, AC-1.10)", () => {
    expect(resolveClassification(line(), DEFAULTS, accounting(["5901"]))?.missing).toEqual(["account"]);
    expect(resolveClassification(line(), DEFAULTS, accounting())?.missing).toEqual([]);
  });
});

describe("types with no default account (AC-6.3, 20261118:AC-3.4, AC-8.4)", () => {
  it("a type with no entry at all has no account: null, not a default, missing the account", () => {
    const result = resolveClassification(line({ type: "stationery" }), DEFAULTS, LIVE);
    expect(result).toMatchObject({ account: null, accountIsDefault: false, vatCode: null, missing: ["account"] });
  });

  it("a type whose default has no account (gifts) is missing the account, until one is chosen by hand", () => {
    expect(resolveClassification(line({ type: "representation_gifts" }), DEFAULTS, LIVE)?.missing).toEqual(["account"]);
    const chosen = resolveClassification(
      line({ type: "representation_gifts", account: ACC_OTHER, accountIsDefault: false }),
      DEFAULTS,
      LIVE,
    );
    expect(chosen?.missing).toEqual([]);
  });

  it("an empty defaults table: the account is missing, no throw", () => {
    expect(resolveClassification(line(), {}, LIVE)?.missing).toEqual(["account"]);
  });

  it("`missing` can only ever be [] or [\"account\"]", () => {
    const snapshots = [LIVE, accounting(["5901", "IPM81"]), accounting([], ["5901", "IPM81", "IP00"]), UNVERIFIED_SNAPSHOT];
    const stored = [{}, { account: ACC_OTHER, accountIsDefault: false }, { vatCode: { code: "IPM77", rateBasisPoints: 770 } }] as Partial<ClassifiableLine>[];
    for (const snapshot of snapshots) {
      for (const over of stored) {
        for (const currency of ["CHF", "EUR"] as const) {
          for (const type of ["travel_train", "stationery", "company_manuals", "representation_gifts"] as const) {
            const result = resolveClassification(line({ ...over, currency, type }), DEFAULTS, snapshot)!;
            expect(result.missing).toEqual(result.bookable.account === null ? ["account"] : []);
            // a bookable half is always shown; an unshown half is never bookable
            if (result.account === null) expect(result.bookable.account).toBeNull();
            if (result.vatCode === null) expect(result.bookable.vatCode).toBeNull();
          }
        }
      }
    }
  });
});

describe("stored copies are kept, exactly as stored (AC-5.3, AC-5.7, AC-1.4 of 20261118)", () => {
  it("a copy on a deactivated account is kept, bookable, shown with state deactivated, and not missing", () => {
    const result = resolveClassification(
      line({ account: account("5901", "Treno (old name)"), accountIsDefault: false }),
      DEFAULTS,
      accounting(["5901"]),
    );
    expect(result?.account).toEqual({ number: "5901", name: "Treno (old name)", state: "deactivated" });
    expect(result?.accountIsDefault).toBe(false);
    expect(result?.bookable.account).toEqual({ number: "5901", name: "Treno (old name)" });
    expect(result?.missing).toEqual([]);
  });

  it("a copy on a VAT code that vanished: kept, not_found, label unknown, not missing", () => {
    const result = resolveClassification(
      line({ account: ACC_OTHER, accountIsDefault: false, vatCode: { code: "IPM81", rateBasisPoints: 810 } }),
      DEFAULTS,
      accounting([], ["IPM81"]),
    );
    expect(result?.vatCode).toEqual({ code: "IPM81", rateBasisPoints: 810, label: null, state: "not_found" });
    expect(result?.bookable.vatCode).toEqual({ code: "IPM81", rateBasisPoints: 810 });
    expect(result?.missing).toEqual([]);
  });

  it("a copy on a deactivated VAT code is kept and bookable, shown with its label and state deactivated", () => {
    const result = resolveClassification(line({ vatCode: { code: "IPM81", rateBasisPoints: 810 } }), DEFAULTS, accounting(["IPM81"]));
    expect(result?.vatCode).toEqual({ code: "IPM81", rateBasisPoints: 810, label: "VAT IPM81", state: "deactivated" });
    expect(result?.bookable.vatCode).toEqual({ code: "IPM81", rateBasisPoints: 810 });
  });

  it("a copy is shown as stored even if Accounting now holds another name or rate for that key", () => {
    const reentered = referenceSnapshot({
      entity: "welld_ch",
      ownCurrency: "CHF",
      ledgerAccounts: [{ number: "5901", name: "Something else", active: true }],
      vatCodes: [{ code: "IPM81", label: "IVA", rateBasisPoints: 770, active: true }],
    });
    const result = resolveClassification(
      line({ account: account("5901", "Treno"), accountIsDefault: false, vatCode: { code: "IPM81", rateBasisPoints: 810 } }),
      DEFAULTS,
      reentered,
    );
    expect(result?.account).toMatchObject({ name: "Treno", state: "active" });
    expect(result?.vatCode).toMatchObject({ rateBasisPoints: 810, state: "active" });
    expect(result?.bookable).toEqual({ account: account("5901", "Treno"), vatCode: { code: "IPM81", rateBasisPoints: 810 } });
  });

  it("a copy wins over the default and is not marked default; an unreadable Accounting leaves it bookable, state unverified", () => {
    const result = resolveClassification(
      line({ account: ACC_OTHER, accountIsDefault: false, vatCode: { code: "IP00", rateBasisPoints: 0 } }),
      DEFAULTS,
      UNVERIFIED_SNAPSHOT,
    );
    expect(result).toMatchObject({
      account: { number: "6101", state: "unverified" },
      accountIsDefault: false,
      vatCode: { code: "IP00", label: null, state: "unverified" },
      missing: [],
    });
  });

  it("a VAT copy leaves the account following the live default (the halves are independent)", () => {
    const result = resolveClassification(line({ vatCode: { code: "IPM77", rateBasisPoints: 770 } }), DEFAULTS, LIVE);
    expect(result?.account).toMatchObject({ number: "5901" });
    expect(result?.accountIsDefault).toBe(true);
    expect(result?.vatCode).toMatchObject({ code: "IPM77", state: "active" });
  });

  it("an account copy on a type with no default makes it complete, with or without a VAT code", () => {
    for (const vatCode of [null, { code: "IPM77", rateBasisPoints: 770 }]) {
      const result = resolveClassification(line({ type: "stationery", account: ACC_OTHER, accountIsDefault: false, vatCode }), DEFAULTS, LIVE);
      expect(result?.missing).toEqual([]);
    }
  });

  it("an approved line (no defaults passed) never follows a default again; with no VAT code it is complete (AC-3.5, AC-3.11)", () => {
    const booked = line({ account: ACC_TRAIN, accountIsDefault: true });
    const result = resolveClassification(booked, {}, LIVE);
    expect(result?.account).toMatchObject({ number: "5901" });
    expect(result?.accountIsDefault).toBe(true);
    expect(result?.vatCode).toBeNull();
    expect(result?.missing).toEqual([]);
  });

  it("a stored copy whose flag is null counts as set by hand", () => {
    const result = resolveClassification(line({ account: ACC_OTHER, accountIsDefault: null }), DEFAULTS, LIVE);
    expect(result?.accountIsDefault).toBe(false);
  });
});

describe("no classification at all (AC-4.9)", () => {
  it("a WellD Italia line -> null, in every currency, with or without stored copies", () => {
    for (const currency of ["CHF", "EUR", "USD", "GBP"] as const) {
      expect(resolveClassification(line({ entity: "welld_it", currency }), DEFAULTS, LIVE)).toBeNull();
    }
    expect(resolveClassification(line({ entity: "welld_it", account: ACC_TRAIN }), DEFAULTS, LIVE)).toBeNull();
  });

  it("a rejected WellD CH line -> null, even if it carries a stored copy", () => {
    expect(resolveClassification(line({ rejected: true }), DEFAULTS, LIVE)).toBeNull();
    expect(resolveClassification(line({ rejected: true, account: ACC_TRAIN, accountIsDefault: false }), DEFAULTS, LIVE)).toBeNull();
  });
});

describe("structural guarantees", () => {
  it("does not mutate its inputs", () => {
    const l = line({ account: ACC_OTHER, accountIsDefault: false });
    const before = JSON.stringify([l, DEFAULTS]);
    resolveClassification(l, DEFAULTS, LIVE);
    expect(JSON.stringify([l, DEFAULTS])).toBe(before);
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
    // Still a column, no longer read (SO-2): a stray value must not leak into the resolver's input.
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
