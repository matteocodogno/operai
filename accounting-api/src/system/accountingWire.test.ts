/**
 * The shared wire schema `accountingWire` (T7, specs/20261119-accounting; AC-3.8, AC-6.8; D23, ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-… point 7).
 *
 * What is proved: the schemas accept the two 200 bodies of plan § API contracts exactly, and refuse
 * everything else, because a consumer that reads a wire "leniently" turns a provider bug into a
 * plausible decision (AC-6.8: an answer that does not fit is "Accounting unavailable", never a guess).
 * Strict both ways: an extra key, a missing member, a wrong type, an integer that is not one, a month
 * in another shape, a natural key twice. And the copy refund-api parses with is the same code.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { checkGroups, SHARED_COPIES } from "../../../scripts/check-shared-copies";
import {
  WIRE_RATE_PAIRS_MAX,
  accountingWire,
  inEffectRateWire,
  ledgerAccountWire,
  missingRateWire,
  referenceDataWire,
  ratesWire,
  vatCodeWire,
  type RatesWire,
  type ReferenceDataWire,
} from "./accountingWire";

// ─── The bodies of the plan, as the routes will send them ─────────────────────

const referenceData: ReferenceDataWire = {
  entity: "welld_ch",
  ownCurrency: "CHF",
  ledgerAccounts: [
    { number: "5910", name: "Spese rimborsi chilometrici", active: true },
    { number: "6.1.2", name: "Trasferte", active: false },
  ],
  vatCodes: [
    { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true },
    { code: "EXP0", label: "Esente", rateBasisPoints: 0, active: false },
  ],
};

const rates: RatesWire = {
  entity: "welld_ch",
  rates: [
    { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924_600, origin: "fetched", attempted: false },
    { currency: "USD", month: "2026-11", status: "missing", attempted: true, reason: "not_published" },
    { currency: "GBP", month: "2026-02", status: "in_effect", rateMicros: 1_150_000, origin: "corrected", attempted: true },
    { currency: "EUR", month: "2026-04", status: "missing", attempted: true, reason: "fetch_failed" },
    { currency: "EUR", month: "2026-05", status: "missing", attempted: false, reason: "no_source" },
  ],
};

const clone = <T>(value: T): T => structuredClone(value);

// ─── reference data ───────────────────────────────────────────────────────────

describe("referenceDataWire", () => {
  it("accepts the 200 body of the plan, and returns it unchanged", () => {
    expect(referenceDataWire.parse(referenceData)).toEqual(referenceData);
    expect(accountingWire.referenceData).toBe(referenceDataWire);
  });

  it("accepts an entity with nothing entered yet: empty lists are not an error (AC-8.3)", () => {
    const empty: ReferenceDataWire = { entity: "welld_it", ownCurrency: "EUR", ledgerAccounts: [], vatCodes: [] };
    expect(referenceDataWire.parse(empty)).toEqual(empty);
  });

  it("refuses a key it does not list, at every level (an id, who added, a history)", () => {
    const top = { ...clone(referenceData), extra: 1 };
    expect(referenceDataWire.safeParse(top).success).toBe(false);

    const account = clone(referenceData);
    (account.ledgerAccounts[0] as Record<string, unknown>)["id"] = "cm1";
    expect(referenceDataWire.safeParse(account).success).toBe(false);

    const vat = clone(referenceData);
    (vat.vatCodes[0] as Record<string, unknown>)["createdByEmail"] = "a@welld.ch";
    expect(referenceDataWire.safeParse(vat).success).toBe(false);

    const history = clone(referenceData);
    (history.vatCodes[0] as Record<string, unknown>)["statusChanges"] = [];
    expect(referenceDataWire.safeParse(history).success).toBe(false);

    expect(ledgerAccountWire.safeParse({ ...referenceData.ledgerAccounts[0], ratePercent: "8.1" }).success).toBe(false);
    expect(vatCodeWire.safeParse({ ...referenceData.vatCodes[0], ratePercent: "8.1" }).success).toBe(false);
  });

  it("refuses a body that lacks any one of its members", () => {
    for (const key of Object.keys(referenceData)) {
      const body = clone(referenceData) as Record<string, unknown>;
      delete body[key];
      expect(referenceDataWire.safeParse(body).success, `top-level ${key}`).toBe(false);
    }
    for (const key of ["number", "name", "active"]) {
      const body = clone(referenceData);
      delete (body.ledgerAccounts[0] as Record<string, unknown>)[key];
      expect(referenceDataWire.safeParse(body).success, `ledger account ${key}`).toBe(false);
    }
    for (const key of ["code", "label", "rateBasisPoints", "active"]) {
      const body = clone(referenceData);
      delete (body.vatCodes[0] as Record<string, unknown>)[key];
      expect(referenceDataWire.safeParse(body).success, `VAT code ${key}`).toBe(false);
    }
  });

  it("refuses a rate in basis points that is not an integer between 0 and 10000", () => {
    const withRate = (rateBasisPoints: unknown) => ({
      ...clone(referenceData),
      vatCodes: [{ code: "X", label: "x", rateBasisPoints, active: true }],
    });
    for (const good of [0, 1, 810, 10_000]) expect(referenceDataWire.safeParse(withRate(good)).success, String(good)).toBe(true);
    for (const bad of [8.1, 810.5, -1, 10_001, "810", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(referenceDataWire.safeParse(withRate(bad)).success, String(bad)).toBe(false);
    }
  });

  it("refuses an `active` that is not a boolean (a string \"false\" is truthy: it must not be read as one)", () => {
    for (const bad of ["false", "true", 0, 1, null]) {
      const body = clone(referenceData);
      (body.ledgerAccounts[0] as Record<string, unknown>)["active"] = bad;
      expect(referenceDataWire.safeParse(body).success, String(bad)).toBe(false);
    }
  });

  it("refuses an entity or an own currency the wire does not know", () => {
    for (const entity of ["welld_xx", "WELLD_CH", "", null, 1]) {
      expect(referenceDataWire.safeParse({ ...clone(referenceData), entity }).success, String(entity)).toBe(false);
    }
    for (const ownCurrency of ["USD", "GBP", "chf", "", null]) {
      expect(referenceDataWire.safeParse({ ...clone(referenceData), ownCurrency }).success, String(ownCurrency)).toBe(false);
    }
  });

  it("refuses an empty number, name, code or label", () => {
    for (const patch of [{ number: "" }, { name: "" }]) {
      const body = clone(referenceData);
      Object.assign(body.ledgerAccounts[0]!, patch);
      expect(referenceDataWire.safeParse(body).success).toBe(false);
    }
    for (const patch of [{ code: "" }, { label: "" }]) {
      const body = clone(referenceData);
      Object.assign(body.vatCodes[0]!, patch);
      expect(referenceDataWire.safeParse(body).success).toBe(false);
    }
  });

  it("refuses a number or a code that appears twice (the wire names an entry by it)", () => {
    const twiceNumber = clone(referenceData);
    twiceNumber.ledgerAccounts.push({ number: "5910", name: "Another", active: true });
    expect(referenceDataWire.safeParse(twiceNumber).success).toBe(false);

    const twiceCode = clone(referenceData);
    twiceCode.vatCodes.push({ code: "IMP81", label: "Another", rateBasisPoints: 770, active: true });
    expect(referenceDataWire.safeParse(twiceCode).success).toBe(false);

    // The same text under the other kind of entry is two different keys.
    const sameText = clone(referenceData);
    sameText.vatCodes[0]!.code = "5910";
    expect(referenceDataWire.safeParse(sameText).success).toBe(true);
  });

  it("refuses what is not a body at all", () => {
    for (const bad of [null, undefined, "", "{}", [], 0, true]) expect(referenceDataWire.safeParse(bad).success, String(bad)).toBe(false);
  });
});

// ─── rates ────────────────────────────────────────────────────────────────────

describe("ratesWire", () => {
  it("accepts the 200 body of the plan, in_effect and missing mixed, and returns it unchanged", () => {
    expect(ratesWire.parse(rates)).toEqual(rates);
    expect(accountingWire.rates).toBe(ratesWire);
  });

  it("accepts a rate in effect of either origin and a missing pair for each reason", () => {
    for (const origin of ["fetched", "corrected"] as const) {
      expect(inEffectRateWire.safeParse({ currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 1, origin, attempted: true }).success).toBe(true);
    }
    for (const reason of ["not_published", "fetch_failed", "no_source"] as const) {
      expect(missingRateWire.safeParse({ currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason }).success).toBe(true);
    }
  });

  it("refuses a key it does not list, at the top and on either kind of pair", () => {
    expect(ratesWire.safeParse({ ...clone(rates), lastFetch: null }).success).toBe(false);

    for (const index of [0, 1]) {
      const body = clone(rates);
      (body.rates[index] as Record<string, unknown>)["id"] = "cm1";
      expect(ratesWire.safeParse(body).success, `pair ${index}`).toBe(false);
    }
    // A missing pair carries no rate and an in-effect pair carries no reason: they are two shapes, not one with holes.
    const missingWithRate = clone(rates);
    (missingWithRate.rates[1] as Record<string, unknown>)["rateMicros"] = 924_600;
    expect(ratesWire.safeParse(missingWithRate).success).toBe(false);
    const inEffectWithReason = clone(rates);
    (inEffectWithReason.rates[0] as Record<string, unknown>)["reason"] = "not_published";
    expect(ratesWire.safeParse(inEffectWithReason).success).toBe(false);
  });

  it("refuses a pair that lacks any one of its members", () => {
    for (const key of ["currency", "month", "status", "rateMicros", "origin", "attempted"]) {
      const body = clone(rates);
      delete (body.rates[0] as Record<string, unknown>)[key];
      expect(ratesWire.safeParse(body).success, `in_effect ${key}`).toBe(false);
    }
    for (const key of ["currency", "month", "status", "attempted", "reason"]) {
      const body = clone(rates);
      delete (body.rates[1] as Record<string, unknown>)[key];
      expect(ratesWire.safeParse(body).success, `missing ${key}`).toBe(false);
    }
    for (const key of ["entity", "rates"]) {
      const body = clone(rates) as Record<string, unknown>;
      delete body[key];
      expect(ratesWire.safeParse(body).success, `top-level ${key}`).toBe(false);
    }
  });

  it("refuses a rateMicros that is not an integer in 1..999999999 (0 < rate < 1000, AC-2.5)", () => {
    const withMicros = (rateMicros: unknown) => {
      const body = clone(rates);
      (body.rates[0] as Record<string, unknown>)["rateMicros"] = rateMicros;
      return body;
    };
    for (const good of [1, 924_600, 999_999_999]) expect(ratesWire.safeParse(withMicros(good)).success, String(good)).toBe(true);
    for (const bad of [924_600.5, 0.9246, 0, -1, 1_000_000_000, 2_147_483_648, "924600", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ratesWire.safeParse(withMicros(bad)).success, String(bad)).toBe(false);
    }
  });

  it("refuses a month that is not YYYY-MM", () => {
    const withMonth = (month: unknown) => {
      const body = clone(rates);
      (body.rates[0] as Record<string, unknown>)["month"] = month;
      return body;
    };
    for (const good of ["2026-03", "2000-01", "2026-12"]) expect(ratesWire.safeParse(withMonth(good)).success, good).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-3", "2026-03-01", "26-03", " 2026-03", "2026-03 ", "2026/03", "2026-03\n", "March 2026", "", 202603, null]) {
      expect(ratesWire.safeParse(withMonth(bad)).success, String(bad)).toBe(false);
    }
  });

  it("refuses a currency, an origin, a reason or a status it does not know", () => {
    const patched = (index: number, key: string, value: unknown) => {
      const body = clone(rates);
      (body.rates[index] as Record<string, unknown>)[key] = value;
      return body;
    };
    // The own currency has no rate; neither does a currency the source does not carry.
    for (const currency of ["CHF", "JPY", "eur", "", null]) {
      expect(ratesWire.safeParse(patched(0, "currency", currency)).success, String(currency)).toBe(false);
    }
    for (const origin of ["manual", "Fetched", "", null]) expect(ratesWire.safeParse(patched(0, "origin", origin)).success, String(origin)).toBe(false);
    for (const reason of ["unknown", "NOT_PUBLISHED", "", null]) expect(ratesWire.safeParse(patched(1, "reason", reason)).success, String(reason)).toBe(false);
    for (const status of ["in-effect", "ok", "fetched", "", null]) expect(ratesWire.safeParse(patched(0, "status", status)).success, String(status)).toBe(false);
  });

  it("refuses an `attempted` that is not a boolean", () => {
    for (const bad of ["true", 1, null, undefined]) {
      const body = clone(rates);
      (body.rates[0] as Record<string, unknown>)["attempted"] = bad;
      expect(ratesWire.safeParse(body).success, String(bad)).toBe(false);
    }
  });

  it("holds each (currency, month) once, 1 to 36 pairs", () => {
    const pair = (i: number): RatesWire["rates"][number] => ({
      currency: (["EUR", "USD", "GBP"] as const)[i % 3]!,
      month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      status: "missing",
      attempted: false,
      reason: "not_published",
    });
    expect(WIRE_RATE_PAIRS_MAX).toBe(36);
    const of = (n: number) => ({ entity: "welld_ch", rates: Array.from({ length: n }, (_, i) => pair(i)) });
    expect(ratesWire.safeParse(of(1)).success).toBe(true);
    expect(ratesWire.safeParse(of(36)).success).toBe(true);
    expect(ratesWire.safeParse(of(0)).success).toBe(false);
    expect(ratesWire.safeParse(of(37)).success).toBe(false);

    const twice = clone(rates);
    twice.rates.push({ ...twice.rates[0]! });
    expect(ratesWire.safeParse(twice).success).toBe(false);
    // The same month in another currency, or the same currency in another month, is another pair.
    const other = clone(rates);
    other.rates.push({ currency: "GBP", month: "2026-03", status: "missing", attempted: false, reason: "not_published" });
    expect(ratesWire.safeParse(other).success).toBe(true);
  });

  it("refuses an in-effect pair and a missing pair for the same key, as two answers to one question", () => {
    const body = clone(rates);
    body.rates.push({ currency: "EUR", month: "2026-03", status: "missing", attempted: true, reason: "fetch_failed" });
    expect(ratesWire.safeParse(body).success).toBe(false);
  });
});

// ─── one wire, two sides ──────────────────────────────────────────────────────

describe("the shared copy", () => {
  it("is registered, and refund-api's region is byte-identical to this one (the check `mise run shared:check` runs in CI)", () => {
    const group = SHARED_COPIES.find((g) => g.name === "accountingWire");
    expect(group?.files).toEqual(["accounting-api/src/system/accountingWire.ts", "refund-api/src/accounting/accountingWire.ts"]);
    expect(checkGroups(group ? [group] : [], join(import.meta.dir, "..", "..", ".."))).toEqual([]);
  });
});
