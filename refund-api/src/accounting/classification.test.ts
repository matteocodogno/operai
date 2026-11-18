/**
 * Unit tests for `resolveClassification` (T4, specs/20261118-refund-accounting-export;
 * AC-1.3, AC-1.6, AC-2.7, AC-3.1, AC-3.2, AC-3.4, AC-3.9 and the G3 reading of AC-1.3).
 */

import { describe, expect, it } from "bun:test";
import {
  resolveClassification,
  type AccountRef,
  type ClassifiableLine,
  type MissingPart,
  type TypeDefaultsByType,
  type VatCodeRef,
} from "./classification";
import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";

const account = (number: string, active = true): AccountRef => ({
  id: `acc-${number}`,
  number,
  name: `Account ${number}`,
  active,
});
const vat = (code: string, rateBasisPoints: number, active = true): VatCodeRef => ({
  id: `vat-${code}`,
  code,
  label: `VAT ${code}`,
  rateBasisPoints,
  active,
});

const ACC_TRAIN = account("5901");
const ACC_OTHER = account("6101");
const IMP81 = vat("IMP81", 810);
const NOVAT = vat("NOVAT", 0);
const IMP77 = vat("IMP77", 770);

const DEFAULTS: TypeDefaultsByType = {
  travel_train: { account: ACC_TRAIN, vatCode: IMP81 },
  postal: { account: account("6104"), vatCode: NOVAT },
  representation_gifts: { account: null, vatCode: IMP81 }, // no matching account in the register
  company_manuals: { account: ACC_OTHER, vatCode: null }, // no default VAT code
};

function line(overrides: Partial<ClassifiableLine> = {}): ClassifiableLine {
  return {
    entity: "welld_ch" as Entity,
    currency: "CHF" as Currency,
    type: "travel_train" as ExpenseType,
    rejected: false,
    ledgerAccount: null,
    ledgerAccountIsDefault: null,
    vatCode: null,
    vatCodeIsDefault: null,
    ...overrides,
  };
}

describe("CHF line: the type's defaults (AC-3.1)", () => {
  it("shows the default account and the default VAT code of its type, both marked default", () => {
    expect(resolveClassification(line(), DEFAULTS, NOVAT)).toEqual({
      account: ACC_TRAIN,
      accountIsDefault: true,
      vatCode: IMP81,
      vatCodeIsDefault: true,
      missing: [],
    });
  });

  it("ignores the foreign-currency designation entirely", () => {
    const withIt = resolveClassification(line(), DEFAULTS, IMP77);
    const without = resolveClassification(line(), DEFAULTS, null);
    expect(withIt).toEqual(without);
    expect(withIt?.vatCode).toBe(IMP81);
  });

  it("uses each type's own defaults", () => {
    const postal = resolveClassification(line({ type: "postal" }), DEFAULTS, null);
    expect(postal?.account?.number).toBe("6104");
    expect(postal?.vatCode?.code).toBe("NOVAT");
  });
});

describe("EUR / USD / GBP lines: the type's account and the foreign-currency VAT code (AC-3.2)", () => {
  for (const currency of ["EUR", "USD", "GBP"] as const) {
    it(`${currency}: type account + designation, both marked default; the type's VAT default is NOT used`, () => {
      const result = resolveClassification(line({ currency }), DEFAULTS, NOVAT);
      expect(result).toEqual({
        account: ACC_TRAIN,
        accountIsDefault: true,
        vatCode: NOVAT, // not IMP81, which is the type's own default
        vatCodeIsDefault: true,
        missing: [],
      });
    });
  }

  it("the designation is used even when the type has no default VAT code of its own", () => {
    const result = resolveClassification(line({ currency: "EUR", type: "company_manuals" }), DEFAULTS, NOVAT);
    expect(result?.vatCode).toBe(NOVAT);
    expect(result?.missing).toEqual([]);
  });
});

describe("foreign-currency VAT code not usable (AC-2.7, AC-3.4)", () => {
  for (const [label, designation] of [
    ["unset or cleared (null)", null],
    ["designated but deactivated", vat("NOVAT", 0, false)],
  ] as const) {
    it(`${label}: no VAT code, the default account stays, VAT is missing`, () => {
      const result = resolveClassification(line({ currency: "EUR" }), DEFAULTS, designation);
      expect(result).toEqual({
        account: ACC_TRAIN,
        accountIsDefault: true,
        vatCode: null,
        vatCodeIsDefault: false,
        missing: ["vatCode"],
      });
    });

    it(`${label}: a CHF line of the same type is unaffected`, () => {
      const result = resolveClassification(line({ currency: "CHF" }), DEFAULTS, designation);
      expect(result?.vatCode).toBe(IMP81);
      expect(result?.missing).toEqual([]);
    });
  }

  it("a reactivated designation is usable again with no further step (AC-1.10)", () => {
    const inactive = vat("NOVAT", 0, false);
    const reactivated = { ...inactive, active: true };
    expect(resolveClassification(line({ currency: "USD" }), DEFAULTS, inactive)?.vatCode).toBeNull();
    expect(resolveClassification(line({ currency: "USD" }), DEFAULTS, reactivated)?.vatCode).toBe(reactivated);
  });

  it("an accounting override on the line still makes the line complete", () => {
    const result = resolveClassification(
      line({ currency: "EUR", vatCode: IMP77, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
    );
    expect(result?.vatCode).toBe(IMP77);
    expect(result?.vatCodeIsDefault).toBe(false);
    expect(result?.missing).toEqual([]);
  });
});

describe("a type default that points at an inactive entry is no default (G3, AC-1.3)", () => {
  it("inactive default ACCOUNT -> account null, missing account; the VAT half is unaffected", () => {
    const defaults: TypeDefaultsByType = {
      travel_train: { account: account("5901", false), vatCode: IMP81 },
    };
    expect(resolveClassification(line(), defaults, null)).toEqual({
      account: null,
      accountIsDefault: false,
      vatCode: IMP81,
      vatCodeIsDefault: true,
      missing: ["account"],
    });
  });

  it("inactive default VAT code of the type -> a CHF line has no VAT code", () => {
    const defaults: TypeDefaultsByType = {
      travel_train: { account: ACC_TRAIN, vatCode: vat("IMP81", 810, false) },
    };
    const result = resolveClassification(line(), defaults, NOVAT);
    expect(result?.vatCode).toBeNull();
    expect(result?.missing).toEqual(["vatCode"]);
  });

  it("an inactive type VAT default is irrelevant to a non-CHF line (the designation is used)", () => {
    const defaults: TypeDefaultsByType = {
      travel_train: { account: ACC_TRAIN, vatCode: vat("IMP81", 810, false) },
    };
    const result = resolveClassification(line({ currency: "EUR" }), defaults, NOVAT);
    expect(result?.vatCode).toBe(NOVAT);
    expect(result?.missing).toEqual([]);
  });

  it("both halves inactive -> both missing, account first", () => {
    const defaults: TypeDefaultsByType = {
      travel_train: { account: account("5901", false), vatCode: vat("IMP81", 810, false) },
    };
    const result = resolveClassification(line(), defaults, null);
    expect(result?.missing).toEqual(["account", "vatCode"]);
  });
});

describe("types with no default, and no default of a half (AC-3.4)", () => {
  it("a type with no entry at all has nothing: both missing", () => {
    const result = resolveClassification(line({ type: "telephone" }), DEFAULTS, NOVAT);
    expect(result).toEqual({
      account: null,
      accountIsDefault: false,
      vatCode: null,
      vatCodeIsDefault: false,
      missing: ["account", "vatCode"],
    });
  });

  it("a type with no default account (representation_gifts) is missing the account", () => {
    const result = resolveClassification(line({ type: "representation_gifts" }), DEFAULTS, null);
    expect(result?.account).toBeNull();
    expect(result?.vatCode).toBe(IMP81);
    expect(result?.missing).toEqual(["account"]);
  });

  it("a type with no default VAT code (company_manuals) is missing the VAT code on a CHF line only", () => {
    expect(resolveClassification(line({ type: "company_manuals" }), DEFAULTS, NOVAT)?.missing).toEqual(["vatCode"]);
    expect(resolveClassification(line({ type: "company_manuals", currency: "EUR" }), DEFAULTS, NOVAT)?.missing).toEqual(
      [],
    );
  });

  it("an empty defaults table: everything is missing, no throw", () => {
    expect(resolveClassification(line(), {}, null)?.missing).toEqual(["account", "vatCode"]);
  });
});

describe("stored values are kept, exactly as stored (AC-1.3, AC-1.6, AC-3.3, AC-3.5)", () => {
  it("an override on an INACTIVE account is kept, returned with active:false, and not missing", () => {
    const retired = account("5999", false);
    const result = resolveClassification(
      line({ ledgerAccount: retired, ledgerAccountIsDefault: false }),
      DEFAULTS,
      NOVAT,
    );
    expect(result?.account).toBe(retired);
    expect(result?.account?.active).toBe(false);
    expect(result?.accountIsDefault).toBe(false);
    expect(result?.missing).toEqual([]);
  });

  it("an override on an INACTIVE VAT code is kept, active:false, not missing", () => {
    const retired = vat("OLD", 800, false);
    const result = resolveClassification(line({ vatCode: retired, vatCodeIsDefault: false }), DEFAULTS, NOVAT);
    expect(result?.vatCode).toBe(retired);
    expect(result?.vatCode?.active).toBe(false);
    expect(result?.missing).toEqual([]);
  });

  it("an override wins over the default and is not marked default", () => {
    const result = resolveClassification(
      line({ ledgerAccount: ACC_OTHER, ledgerAccountIsDefault: false, vatCode: IMP77, vatCodeIsDefault: false }),
      DEFAULTS,
      NOVAT,
    );
    expect(result).toEqual({
      account: ACC_OTHER,
      accountIsDefault: false,
      vatCode: IMP77,
      vatCodeIsDefault: false,
      missing: [],
    });
  });

  it("an override on one half leaves the other half following the live default", () => {
    const result = resolveClassification(
      line({ ledgerAccount: ACC_OTHER, ledgerAccountIsDefault: false }),
      DEFAULTS,
      NOVAT,
    );
    expect(result?.account).toBe(ACC_OTHER);
    expect(result?.accountIsDefault).toBe(false);
    expect(result?.vatCode).toBe(IMP81);
    expect(result?.vatCodeIsDefault).toBe(true);
  });

  it("an override fills a gap: a type with no default plus a chosen account/VAT code is complete", () => {
    const result = resolveClassification(
      line({ type: "telephone", ledgerAccount: ACC_OTHER, ledgerAccountIsDefault: false, vatCode: IMP81, vatCodeIsDefault: false }),
      DEFAULTS,
      null,
    );
    expect(result?.missing).toEqual([]);
  });

  it("a FROZEN classification keeps its is-default flags and ignores later changes to the defaults (AC-3.5, AC-2.3)", () => {
    const frozen = line({
      currency: "EUR",
      ledgerAccount: ACC_TRAIN,
      ledgerAccountIsDefault: true,
      vatCode: NOVAT,
      vatCodeIsDefault: true,
    });
    // The defaults changed, the designation was cleared: the line does not care.
    const changedDefaults: TypeDefaultsByType = { travel_train: { account: ACC_OTHER, vatCode: IMP77 } };
    const result = resolveClassification(frozen, changedDefaults, null);
    expect(result).toEqual({
      account: ACC_TRAIN,
      accountIsDefault: true,
      vatCode: NOVAT,
      vatCodeIsDefault: true,
      missing: [],
    });
  });

  it("a stored value whose flag is null counts as set by hand", () => {
    const result = resolveClassification(line({ ledgerAccount: ACC_OTHER }), DEFAULTS, null);
    expect(result?.accountIsDefault).toBe(false);
  });
});

describe("no classification at all (AC-3.9)", () => {
  it("a WellD Italia line -> null, in every currency, with or without stored values", () => {
    for (const currency of ["CHF", "EUR", "USD", "GBP"] as const) {
      expect(resolveClassification(line({ entity: "welld_it", currency }), DEFAULTS, NOVAT)).toBeNull();
    }
    expect(
      resolveClassification(line({ entity: "welld_it", ledgerAccount: ACC_TRAIN, vatCode: IMP81 }), DEFAULTS, NOVAT),
    ).toBeNull();
  });

  it("a rejected WellD CH line -> null, even if it carries a stored classification", () => {
    expect(resolveClassification(line({ rejected: true }), DEFAULTS, NOVAT)).toBeNull();
    expect(
      resolveClassification(
        line({ rejected: true, ledgerAccount: ACC_TRAIN, ledgerAccountIsDefault: true, vatCode: IMP81, vatCodeIsDefault: true }),
        DEFAULTS,
        NOVAT,
      ),
    ).toBeNull();
  });

  it("a rejected WellD Italia line -> null", () => {
    expect(resolveClassification(line({ entity: "welld_it", rejected: true }), DEFAULTS, NOVAT)).toBeNull();
  });
});

describe("structural guarantees", () => {
  it("`missing` is exactly the null halves, whatever the inputs", () => {
    const accounts: (AccountRef | null)[] = [null, ACC_TRAIN, account("5901", false)];
    const vats: (VatCodeRef | null)[] = [null, IMP81, vat("IMP81", 810, false)];
    for (const storedAccount of accounts) {
      for (const storedVat of vats) {
        for (const defAccount of accounts) {
          for (const defVat of vats) {
            for (const designation of vats) {
              for (const currency of ["CHF", "EUR"] as const) {
                const result = resolveClassification(
                  line({ currency, ledgerAccount: storedAccount, vatCode: storedVat }),
                  { travel_train: { account: defAccount, vatCode: defVat } },
                  designation,
                );
                expect(result).not.toBeNull();
                const expected: MissingPart[] = [
                  ...(result!.account === null ? (["account"] as const) : []),
                  ...(result!.vatCode === null ? (["vatCode"] as const) : []),
                ];
                expect(result!.missing).toEqual(expected);
                // A default is only ever an active entry; a stored value is whatever is stored.
                if (storedAccount === null && result!.account !== null) expect(result!.account.active).toBe(true);
                if (storedVat === null && result!.vatCode !== null) expect(result!.vatCode.active).toBe(true);
                // A null half is never marked default.
                if (result!.account === null) expect(result!.accountIsDefault).toBe(false);
                if (result!.vatCode === null) expect(result!.vatCodeIsDefault).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it("does not mutate its inputs", () => {
    const l = line({ currency: "EUR" });
    const d = structuredClone(DEFAULTS);
    const before = JSON.stringify([l, d]);
    resolveClassification(l, d, NOVAT);
    expect(JSON.stringify([l, d])).toBe(before);
  });
});
