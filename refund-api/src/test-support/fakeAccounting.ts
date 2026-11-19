/**
 * Test-only: a fake `AccountingPort` (specs/20261119-accounting T17; plan § Test strategy "int-R", D28).
 *
 * refund-api's route and script tests never touch the network: they hand the routes this fake, which holds WellD CH's
 * reference data and rates in memory and can
 * - answer like accounting-api's reader projection (accounts and VAT codes with `active`, rates in effect or missing);
 * - change between two reads (deactivate, rename, re-enter, correct a rate);
 * - be slow (`delayMs`) or fail with any of the failure kinds a real read can have (`failWith`), for every read or just
 *   the reference data or just the rates;
 * - count what was asked (`reads`, `calls`), so a test can assert "0 fake calls" (AC-6.4, AC-5.4) or "two reads" (AC-4.8).
 *
 * It is built on the same `newOperation` as the real client, so memoisation within one operation, de-duplication and
 * the 36-pair chunking behave the same; a count is one RAW read, which is what a real call would be.
 *
 * Install it with `useFakeAccounting(fake)` in `beforeEach` and `restoreAccounting()` in `afterAll`: the routes read the
 * port through `accountingPort()`. Without it every read in a test fails (the service token provider is disabled under
 * `NODE_ENV=test`), which is the "Accounting unreachable" case, deterministically.
 */

import {
  AccountingUnavailableError,
  newOperation,
  setAccountingPortForTests,
  type AccountingFailureKind,
  type AccountingOperationName,
  type AccountingPort,
  type RatePair,
} from "../accounting/accountingClient";
import type { RatePairWire, ReferenceDataWire, WireEntity } from "../accounting/accountingWire";

export interface FakeAccount {
  number: string;
  name: string;
  active: boolean;
}
export interface FakeVatCode {
  code: string;
  label: string;
  rateBasisPoints: number;
  active: boolean;
}
type FakeRate =
  | { status: "in_effect"; rateMicros: number; origin: "fetched" | "corrected"; attempted: boolean }
  | { status: "missing"; reason: "not_published" | "fetch_failed" | "no_source"; attempted: boolean };

export interface FakeCall {
  readonly operation: AccountingOperationName;
  readonly read: "referenceData" | "rates";
  readonly entity: WireEntity;
  readonly pairs?: readonly string[];
}

export interface FakeAccounting extends AccountingPort {
  /** Raw reads served or refused since the last `resetCalls()`. */
  readonly calls: readonly FakeCall[];
  readonly reads: { readonly referenceData: number; readonly rates: number; readonly total: number };
  resetCalls(): void;

  // ── data ──
  setAccount(number: string, name: string, active?: boolean): this;
  setAccountActive(number: string, active: boolean): this;
  /** The number disappears from Accounting (entered again later with `setAccount`). */
  removeAccount(number: string): this;
  setVatCode(code: string, label: string, rateBasisPoints: number, active?: boolean): this;
  setVatCodeActive(code: string, active: boolean): this;
  removeVatCode(code: string): this;
  setRate(currency: RatePair["currency"], month: string, rateMicros: number, origin?: "fetched" | "corrected"): this;
  /** The rate is not in effect, for this `reason` (default `not_published`). */
  setRateMissing(currency: RatePair["currency"], month: string, reason?: "not_published" | "fetch_failed" | "no_source"): this;
  removeRate(currency: RatePair["currency"], month: string): this;
  /** What the producer reports as `attempted` for this pair (G10). */
  setAttempted(currency: RatePair["currency"], month: string, attempted: boolean): this;
  /** Data that exists only for WellD Italia: never returned for welld_ch (AC-4.2, AC-4.3). */
  setItalianAccount(number: string, name: string): this;

  // ── behaviour ──
  /** Every read fails with this kind (`null` restores). */
  failWith(kind: AccountingFailureKind | null): this;
  /** Only the reference-data reads fail / only the rates reads fail. */
  failReferenceDataWith(kind: AccountingFailureKind | null): this;
  failRatesWith(kind: AccountingFailureKind | null): this;
  /** Each raw read takes this long. */
  setDelayMs(ms: number): this;
  /** A hook run at the start of every raw read (e.g. to change the data "while Accounting is being read"). */
  onRead(hook: ((call: FakeCall) => void | Promise<void>) | null): this;
}

export function createFakeAccounting(): FakeAccounting {
  const accounts = new Map<string, FakeAccount>();
  const vatCodes = new Map<string, FakeVatCode>();
  const rates = new Map<string, FakeRate>();
  const italianAccounts = new Map<string, string>();
  const calls: FakeCall[] = [];
  let failAll: AccountingFailureKind | null = null;
  let failReference: AccountingFailureKind | null = null;
  let failRates: AccountingFailureKind | null = null;
  let delayMs = 0;
  let hook: ((call: FakeCall) => void | Promise<void>) | null = null;
  const key = (currency: string, month: string) => `${currency}:${month}`;

  async function enter(call: FakeCall, failure: AccountingFailureKind | null): Promise<void> {
    calls.push(call);
    if (hook) await hook(call);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const kind = failAll ?? failure;
    if (kind) throw new AccountingUnavailableError(kind);
  }

  const fake: FakeAccounting = {
    get calls() {
      return calls;
    },
    get reads() {
      const referenceData = calls.filter((c) => c.read === "referenceData").length;
      const rateReads = calls.filter((c) => c.read === "rates").length;
      return { referenceData, rates: rateReads, total: calls.length };
    },
    resetCalls() {
      calls.length = 0;
    },
    setAccount(number, name, active = true) {
      accounts.set(number, { number, name, active });
      return fake;
    },
    setAccountActive(number, active) {
      const found = accounts.get(number);
      if (!found) throw new Error(`fake: no account ${number}`);
      found.active = active;
      return fake;
    },
    removeAccount(number) {
      accounts.delete(number);
      return fake;
    },
    setVatCode(code, label, rateBasisPoints, active = true) {
      vatCodes.set(code, { code, label, rateBasisPoints, active });
      return fake;
    },
    setVatCodeActive(code, active) {
      const found = vatCodes.get(code);
      if (!found) throw new Error(`fake: no VAT code ${code}`);
      found.active = active;
      return fake;
    },
    removeVatCode(code) {
      vatCodes.delete(code);
      return fake;
    },
    setRate(currency, month, rateMicros, origin = "fetched") {
      rates.set(key(currency, month), { status: "in_effect", rateMicros, origin, attempted: rates.get(key(currency, month))?.attempted ?? false });
      return fake;
    },
    setRateMissing(currency, month, reason = "not_published") {
      rates.set(key(currency, month), { status: "missing", reason, attempted: rates.get(key(currency, month))?.attempted ?? false });
      return fake;
    },
    removeRate(currency, month) {
      rates.delete(key(currency, month));
      return fake;
    },
    setAttempted(currency, month, attempted) {
      const found = rates.get(key(currency, month)) ?? { status: "missing" as const, reason: "not_published" as const, attempted };
      rates.set(key(currency, month), { ...found, attempted });
      return fake;
    },
    setItalianAccount(number, name) {
      italianAccounts.set(number, name);
      return fake;
    },
    failWith(kind) {
      failAll = kind;
      return fake;
    },
    failReferenceDataWith(kind) {
      failReference = kind;
      return fake;
    },
    failRatesWith(kind) {
      failRates = kind;
      return fake;
    },
    setDelayMs(ms) {
      delayMs = ms;
      return fake;
    },
    onRead(next) {
      hook = next;
      return fake;
    },
    begin(operation) {
      return newOperation(operation, {
        async referenceData(entity): Promise<ReferenceDataWire> {
          await enter({ operation, read: "referenceData", entity }, failReference);
          if (entity !== "welld_ch") {
            return {
              entity,
              ownCurrency: "EUR",
              ledgerAccounts: [...italianAccounts].map(([number, name]) => ({ number, name, active: true })),
              vatCodes: [],
            };
          }
          return {
            entity,
            ownCurrency: "CHF",
            ledgerAccounts: [...accounts.values()].map((a) => ({ ...a })),
            vatCodes: [...vatCodes.values()].map((v) => ({ ...v })),
          };
        },
        async ratePairs(entity, pairs): Promise<readonly RatePairWire[]> {
          await enter({ operation, read: "rates", entity, pairs: pairs.map((p) => key(p.currency, p.month)) }, failRates);
          return pairs.map((pair): RatePairWire => {
            const found = rates.get(key(pair.currency, pair.month));
            if (found?.status === "in_effect") {
              return { currency: pair.currency, month: pair.month, status: "in_effect", rateMicros: found.rateMicros, origin: found.origin, attempted: found.attempted };
            }
            return {
              currency: pair.currency,
              month: pair.month,
              status: "missing",
              attempted: found?.attempted ?? false,
              reason: found?.status === "missing" ? found.reason : "not_published",
            };
          });
        },
      });
    },
  };
  return fake;
}

/** Routes and scripts read through this fake until `restoreAccounting()`. */
export function useFakeAccounting(fake: AccountingPort): void {
  setAccountingPortForTests(fake);
}

/** Back to the real client (which, under `NODE_ENV=test`, cannot mint a token: Accounting is "unreachable"). */
export function restoreAccounting(): void {
  setAccountingPortForTests(null);
}

/** The reference data most suites share: what `seedAccountingFixtures` was in the 20261118 world. */
export const FAKE_STANDARD = {
  account: { number: "6101", name: "Spese materiale ufficio" },
  trainAccount: { number: "5901", name: "Treno" },
  vat: { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810 },
  noVat: { code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0 },
} as const;

/** A fake holding the standard accounts and VAT codes, every entry active. */
export function createStandardFakeAccounting(): FakeAccounting {
  return createFakeAccounting()
    .setAccount(FAKE_STANDARD.account.number, FAKE_STANDARD.account.name)
    .setAccount(FAKE_STANDARD.trainAccount.number, FAKE_STANDARD.trainAccount.name)
    .setVatCode(FAKE_STANDARD.vat.code, FAKE_STANDARD.vat.label, FAKE_STANDARD.vat.rateBasisPoints)
    .setVatCode(FAKE_STANDARD.noVat.code, FAKE_STANDARD.noVat.label, FAKE_STANDARD.noVat.rateBasisPoints);
}

const BY = { createdByUserId: "test-admin", createdByEmail: "admin@welld.ch" };

/**
 * Test-only: Refund's own default rows (the account copies, in the append-only table), so that a test which approves
 * WellD CH lines without being about classification still approves (AC-6.3 refuses a CH line with no usable account).
 * The account `6101` is the default of every expense type. There is no VAT default and no designation any more
 * (20261118 SO-2, SO-16): a line approved on these defaults has no VAT code unless the test sets one. Call it AFTER
 * `truncateRefundTables()`; pair it with `createStandardFakeAccounting()`.
 */
export async function seedDefaultCopies(options: { account?: { number: string; name: string } } = {}): Promise<void> {
  const { db } = await import("../lib/db");
  const { ExpenseType } = await import("../lib/generated/prisma/enums");
  const account = options.account ?? FAKE_STANDARD.account;
  for (const type of Object.values(ExpenseType)) {
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type, accountNumber: account.number, accountName: account.name, ...BY },
    });
  }
}
