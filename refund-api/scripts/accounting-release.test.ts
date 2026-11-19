/**
 * The release script against real Postgres (T11, specs/20261118-refund-accounting-export; AC-2.5, AC-7.1, AC-7.2, AC-7.3; plan D2,
 * D6, D13, IS-1; rewritten by T22, specs/20261119-accounting: AC-7.4, AC-7.5, AC-6.8, D20; plan § Release scripts).
 *
 * Accounting is a FAKE `AccountingPort` (no network): the script reads it first, and a fake that cannot be read proves what the
 * script writes then (nothing). The rows covered:
 *   AC-7.4  Accounting unreachable (each kind, reference data or rates, dry run too): the run ends with `AccountingUnavailableError`
 *           (the CLI maps it to exit 2) and NO number, copy, default, designation, counter, audit row or marker exists; a rerun with
 *           Accounting back works. The read comes first (the database is untouched when Accounting is asked), rates in chunks of 6
 *           months, one deadline per chunk. Legacy lines get the COPY of the default's entry as Accounting holds it now, and the rate
 *           copy when one is in effect, else "rate pending" (reported). A line that appears while the release runs is refused, not guessed.
 *   AC-7.5  Accounting holds no WellD CH entries: every legacy line is numbered and listed unclassified, and a later approval is 409.
 *   AC-2.5  Refund's defaults and designation are seeded by natural key, only where Refund holds no row and only for an active
 *           entry (else skipped and reported); the catalog is never seeded (it is Accounting's).
 *   AC-7.1/7.2/7.3 of 20261118: numbering, unclassified lines and WellD Italia lines unchanged. SR-3, SR-4, D-1, offsets, dry run.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveResponse } from "../src/authz/resolveClient";
import { truncateRefundTables } from "../src/test-support/dbCleanup";
import { setupTestAuth } from "../src/test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../src/lib/db");
const { ACCOUNTING_FAILURE_KINDS, AccountingUnavailableError } = await import("../src/accounting/accountingClient");
const { loadRecordedDefaults } = await import("../src/accounting/defaults.repo");
const { isAccountingReleased } = await import("../src/accounting/release");
const { createFakeAccounting, restoreAccounting, useFakeAccounting } = await import("../src/test-support/fakeAccounting");
const { __resetAuthzCacheForTests } = await import("../src/auth/authz.middleware");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster (testAuth.ts, "no shared router specifier")
const { decideRouter } = (await import("../src/review/decide.routes?release-script")) as typeof import("../src/review/decide.routes");
const {
  ACCOUNTING_UNREADABLE_MESSAGE,
  chunkByMonths,
  DEFAULT_DEFAULTS_PATH,
  formatReport,
  maskEmail,
  offsetsPathWarning,
  parseDefaults,
  parseOffsetsCsv,
  RATE_CHUNK_MONTHS,
  describeReleaseFailure,
  ReleaseError,
  runAccountingRelease,
} = await import("./accounting-release");

const NOW = new Date("2026-11-20T08:00:00.000Z");

/** What WellD CH's Accounting holds on release day: the 15 accounts and 3 VAT codes of the signed-off list. */
const ACCOUNTS: readonly [string, string][] = [
  ["5901", "Spese viaggi in treno"],
  ["5904", "Spese viaggi altri mezzi pubblici"],
  ["5905", "Spese rimborsi chilometrici (viaggi)"],
  ["5906", "Spese autostrade (viaggi)"],
  ["5907", "Spese parcheggio (viaggi)"],
  ["5909", "Spese di alloggio (viaggi)"],
  ["5999", "Altre spese di viaggio"],
  ["5808", "Contributo aziendale abbonamento mezzi pubblici personale"],
  ["6101", "Spese materiale ufficio"],
  ["6102", "Spese telefoniche, fax, internet"],
  ["6104", "Spese postali"],
  ["6405", "Spese licenze software"],
  ["6701", "Spese pranzi e cene con clienti"],
  ["6720", "Spese pranzi e cene di lavoro (interni)"],
  ["7122", "Spese anticipate per / succursali / altre società del gruppo"],
];
function fullAccounting() {
  const accounting = createFakeAccounting();
  for (const [number, name] of ACCOUNTS) accounting.setAccount(number, name);
  return accounting.setVatCode("IMP81", "IVA 8.1%", 810).setVatCode("IMP77", "IVA 7.7%", 770).setVatCode("NOVAT", "Senza IVA", 0);
}
type Fake = ReturnType<typeof createFakeAccounting>;
let fake: Fake = fullAccounting();

const admin = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

beforeEach(async () => {
  await truncateRefundTables({ released: false });
  fake = fullAccounting();
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables({ released: false });
});

interface L {
  id: string;
  date: string;
  type?: string;
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  entity?: "welld_ch" | "welld_it";
  rejected?: boolean;
  createdAt?: string;
}

async function request(owner: string, lines: L[], opts: { status?: "draft" | "submitted" | "approved" | "paid" | "rejected"; name?: string | null; email?: string } = {}) {
  const r = await db.refundRequest.create({
    data: {
      ownerUserId: owner,
      ownerEmail: opts.email ?? `${owner}@welld.ch`,
      ownerName: opts.name === undefined ? "Matteo Codogno" : opts.name,
      status: opts.status ?? "approved",
      submittedAt: new Date("2026-03-01"),
    },
  });
  for (const l of lines) {
    await db.refundLine.create({
      data: {
        id: l.id,
        requestId: r.id,
        date: new Date(l.date),
        type: (l.type ?? "travel_train") as any,
        motivo: "m",
        entity: l.entity ?? "welld_ch",
        currency: l.currency ?? "CHF",
        requestedAmountCents: 1000,
        approvedTotalCents: 1000,
        ...(l.createdAt ? { createdAt: new Date(l.createdAt) } : {}),
        ...(l.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x" } : {}),
      },
    });
  }
  return r;
}

const run = (over: Parameters<typeof runAccountingRelease>[0] = {}) =>
  runAccountingRelease({ now: () => NOW, accounting: { begin: (name) => fake.begin(name) }, ...over });
const line = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });

/** Everything a release writes, counted: nothing of it may exist after a run that stopped (AC-7.4). */
async function snapshot() {
  return {
    typeDefaults: await db.expenseTypeAccountingDefault.count(),
    designations: await db.foreignCurrencyVatDesignation.count(),
    settings: await db.refundSetting.count(),
    counters: JSON.stringify(await db.receiptCounter.findMany({ orderBy: { year: "asc" } })),
    lines: JSON.stringify(
      await db.refundLine.findMany({
        orderBy: { id: "asc" },
        select: { id: true, receiptNumber: true, accountNumber: true, accountName: true, vatCodeCopy: true, vatRateBasisPoints: true, fxRateMicros: true, fxRateMonth: true },
      }),
    ),
    audit: await db.refundAuditEntry.count(),
  };
}

describe("the defaults file", () => {
  it("is valid, and is the plan's D1 draft: twelve types, NOVAT designated; every number and code it names is in the signed-off list", () => {
    const defaults = parseDefaults(JSON.parse(readFileSync(DEFAULT_DEFAULTS_PATH, "utf8")));
    expect(Object.keys(defaults.typeDefaults)).toHaveLength(12);
    expect(defaults.typeDefaults.travel_km).toEqual({ ledgerAccount: "5905", vatCode: "NOVAT" });
    expect(defaults.typeDefaults.representation_gifts).toEqual({ ledgerAccount: null, vatCode: "IMP81" });
    expect(defaults.typeDefaults.company_manuals).toEqual({ ledgerAccount: "6101", vatCode: null });
    expect(defaults.foreignCurrencyVatCode).toBe("NOVAT");
    const numbers = new Set(ACCOUNTS.map(([number]) => number));
    const codes = new Set(["IMP81", "IMP77", "NOVAT"]);
    for (const entry of Object.values(defaults.typeDefaults)) {
      if (entry.ledgerAccount !== null) expect(numbers.has(entry.ledgerAccount)).toBe(true);
      if (entry.vatCode !== null) expect(codes.has(entry.vatCode)).toBe(true);
    }
  });

  it("refuses a file with an unknown type, an empty key, or a wrong shape; accepts none and an empty map", () => {
    const base = { typeDefaults: {}, foreignCurrencyVatCode: null };
    expect(() => parseDefaults({ ...base, typeDefaults: { not_a_type: { ledgerAccount: null, vatCode: null } } })).toThrow(ReleaseError);
    expect(() => parseDefaults({ ...base, typeDefaults: { postal: { ledgerAccount: "", vatCode: null } } })).toThrow(ReleaseError);
    expect(() => parseDefaults({ ...base, typeDefaults: { postal: { ledgerAccount: 6104, vatCode: null } } })).toThrow(ReleaseError);
    expect(() => parseDefaults({ ...base, foreignCurrencyVatCode: "" })).toThrow(ReleaseError);
    expect(() => parseDefaults({ typeDefaults: {} })).toThrow(ReleaseError);
    expect(parseDefaults(base)).toBeTruthy();
    expect(parseDefaults({ typeDefaults: { postal: { ledgerAccount: " 6104 ", vatCode: "NOVAT" } }, foreignCurrencyVatCode: "NOVAT" }).typeDefaults.postal).toEqual({ ledgerAccount: "6104", vatCode: "NOVAT" });
  });
});

describe("parseOffsetsCsv", () => {
  it("reads email,year,lastIssuedSeq with or without a header, blanks and comments", () => {
    expect(parseOffsetsCsv("email,year,lastIssuedSeq\nmatteo@welld.ch,2026,81\n\n# a note\n\"anna@welld.ch\", 2026 , 12\r\n")).toEqual([
      { email: "matteo@welld.ch", year: 2026, lastIssuedSeq: 81 },
      { email: "anna@welld.ch", year: 2026, lastIssuedSeq: 12 },
    ]);
    expect(parseOffsetsCsv("a@b.ch,2026,1")).toHaveLength(1);
  });

  it("refuses malformed rows and duplicates, naming the line", () => {
    for (const bad of ["a@b.ch,2026", "nope,2026,1", "a@b.ch,26,1", "a@b.ch,2026,0", "a@b.ch,2026,x", "a@b.ch,2026,100000", "a@b.ch,2026,1\nA@b.ch,2026,2"]) {
      expect(() => parseOffsetsCsv(bad)).toThrow(ReleaseError);
    }
    expect(() => parseOffsetsCsv("a@b.ch,2026,x")).toThrow(/line 1/);
  });
});

describe("chunkByMonths", () => {
  const pair = (month: string, currency: "EUR" | "USD" | "GBP" = "EUR") => ({ currency, month });

  it("groups the pairs by at most six distinct months, oldest first, keeping every currency of a month together", () => {
    const pairs = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].flatMap((m) => [pair(m), pair(m, "USD")]);
    const chunks = chunkByMonths(pairs);
    expect(RATE_CHUNK_MONTHS).toBe(6);
    expect(chunks.map((c) => [...new Set(c.map((p) => p.month))])).toEqual([
      ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
      ["2026-07", "2026-08"],
    ]);
    expect(chunks.flat()).toHaveLength(16);
  });

  it("is empty for no pair, one chunk for six months, two for seven", () => {
    expect(chunkByMonths([])).toEqual([]);
    expect(chunkByMonths(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((m) => pair(m)))).toHaveLength(1);
    expect(chunkByMonths(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"].map((m) => pair(m)))).toHaveLength(2);
  });
});

describe("Accounting is read first (AC-7.4, AC-6.8)", () => {
  async function legacy() {
    await request("u1", [
      { id: "chf", date: "2026-03-02" },
      { id: "eur", date: "2026-03-05", currency: "EUR" },
    ]);
    await request("u2", [{ id: "paid", date: "2026-02-10", type: "office_material" }], { status: "paid", name: "Anna Rossi" });
  }

  it("with Accounting unreachable, whatever the kind: the run stops with AccountingUnavailableError, and not a number, copy, default, designation, counter, audit row or marker exists", async () => {
    await legacy();
    const before = await snapshot();
    for (const kind of ACCOUNTING_FAILURE_KINDS) {
      fake.failWith(kind);
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccountingUnavailableError);
      expect((error as InstanceType<typeof AccountingUnavailableError>).kind).toBe(kind);
      expect(await snapshot()).toEqual(before);
    }
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
    expect(before.typeDefaults + before.designations + before.settings + before.audit).toBe(0);
  });

  it("the reference data failing alone, or the rates failing alone, is the same; a dry run stops too", async () => {
    await legacy();
    const before = await snapshot();
    fake.failReferenceDataWith("timeout");
    await expect(run()).rejects.toBeInstanceOf(AccountingUnavailableError);
    fake.failReferenceDataWith(null).failRatesWith("schema");
    await expect(run()).rejects.toBeInstanceOf(AccountingUnavailableError);
    await expect(run({ dryRun: true })).rejects.toBeInstanceOf(AccountingUnavailableError);
    expect(await snapshot()).toEqual(before);
  });

  it("a rerun once Accounting is back works, and numbers exactly what the first attempt would have", async () => {
    await legacy();
    fake.failWith("network");
    await expect(run()).rejects.toBeInstanceOf(AccountingUnavailableError);
    fake.failWith(null).setRate("EUR", "2026-03", 924_600);
    const report = await run();
    expect(report.markerWritten).toBe(true);
    expect(report.lines.map((l) => l.receiptNumber).sort()).toEqual(["AR26/001", "MC26/001", "MC26/002"]);
    expect((await line("eur")).fxRateMicros).toBe(924_600);
  });

  it("asks Accounting BEFORE the first write: when it is read, the database holds no marker, counter, default or number", async () => {
    await legacy();
    const seen: number[] = [];
    fake.onRead(async () => {
      seen.push(
        (await db.refundSetting.count()) +
          (await db.receiptCounter.count()) +
          (await db.expenseTypeAccountingDefault.count()) +
          (await db.foreignCurrencyVatDesignation.count()) +
          (await db.refundLine.count({ where: { receiptNumber: { not: null } } })),
      );
    });
    await run();
    expect(seen.length).toBeGreaterThanOrEqual(2); // the reference data and at least one rates read
    expect(seen.every((n) => n === 0)).toBe(true);
  });

  it("asks the reference data once and the rates of the legacy foreign-currency lines only, as the operation `release`", async () => {
    await request("u1", [
      { id: "a", date: "2026-03-05", currency: "EUR" },
      { id: "b", date: "2026-03-09", currency: "EUR" }, // same pair: asked once
      { id: "c", date: "2026-03-09", currency: "USD" },
      { id: "chf", date: "2026-03-09" }, // CHF: no rate
      { id: "rej", date: "2025-01-09", currency: "GBP", rejected: true }, // rejected: never classified
      { id: "it", date: "2025-02-09", currency: "EUR", entity: "welld_it" }, // WellD Italia: never touched
    ]);
    await request("u1", [{ id: "sub", date: "2025-03-09", currency: "EUR" }], { status: "submitted" });
    await run({ dryRun: true });
    expect(fake.calls.map((c) => [c.operation, c.read, c.pairs])).toEqual([
      ["release", "referenceData", undefined],
      ["release", "rates", ["EUR:2026-03", "USD:2026-03"]],
    ]);
  });

  it("with no legacy foreign-currency line it asks no rate at all", async () => {
    await request("u1", [{ id: "chf", date: "2026-03-09" }]);
    await run();
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 });
  });

  it("(F-02) a legacy foreign-currency line dated before Accounting's 2000-01 floor is not asked about and does not fail the read: it is numbered, rate pending, and reported", async () => {
    await request("u1", [
      { id: "old", date: "1999-12-30", currency: "EUR" },
      { id: "ok", date: "2026-03-09", currency: "EUR" },
    ]);
    fake.setRate("EUR", "2026-03", 924_600);
    const report = await run();
    expect(fake.calls.filter((c) => c.read === "rates").map((c) => c.pairs)).toEqual([["EUR:2026-03"]]);
    expect(report.lines).toHaveLength(2);
    expect(report.ratePending.map((l) => l.lineId)).toEqual(["old"]);
    expect(report.accounting.ratePairsAsked).toBe(2);
    expect(await isAccountingReleased(db as never)).toBe(true);
  });

  it("asks the rates in chunks of six months: 14 months, three reads of 6, 6 and 2 months, each its own operation", async () => {
    const months = Array.from({ length: 14 }, (_, i) => `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
    await request("u1", months.map((month, i) => ({ id: `m${i}`, date: `${month}-10`, currency: "EUR" as const })));
    await run({ dryRun: true });
    const rateReads = fake.calls.filter((c) => c.read === "rates");
    expect(rateReads.map((c) => new Set(c.pairs!.map((p) => p.split(":")[1])).size)).toEqual([6, 6, 2]);
    expect(rateReads.flatMap((c) => c.pairs!)).toHaveLength(14);
    expect(fake.calls.every((c) => c.operation === "release")).toBe(true);
  });

  it("a legacy line that appears while Accounting is being read was not asked about: the run is refused and rolled back, never guessed", async () => {
    await request("u1", [{ id: "known", date: "2026-03-05", currency: "EUR" }]);
    fake.setRate("EUR", "2026-03", 924_600);
    const before = await snapshot();
    fake.onRead(async (call) => {
      if (call.read !== "rates") return;
      fake.onRead(null);
      await request("u1", [{ id: "late", date: "2026-05-05", currency: "EUR" }]);
    });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseError);
    expect((error as InstanceType<typeof ReleaseError>).code).toBe("legacy_lines_changed");
    const after = await snapshot();
    expect({ ...after, lines: "" }).toEqual({ ...before, lines: "" });
    expect((await line("known")).receiptNumber).toBeNull();
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
  });

  it("the message of AC-7.4 says what was and was not done", () => {
    expect(ACCOUNTING_UNREADABLE_MESSAGE).toBe("Accounting cannot be read: nothing was numbered or classified; run again later");
  });
});

describe("backfill (AC-7.1, AC-7.4)", () => {
  it("classifies CHF lines with the type defaults and EUR lines with the type account plus the foreign-currency VAT code, as COPIES, and numbers by expense date across requests", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    await request("u1", [{ id: "a-late", date: "2026-03-20", type: "travel_train" }, { id: "a-eur", date: "2026-03-05", type: "travel_train", currency: "EUR" }]);
    await request("u1", [{ id: "a-early", date: "2026-02-10", type: "office_material" }], { status: "paid" });
    const report = await run();

    expect(await Promise.all(["a-early", "a-eur", "a-late"].map(async (id) => (await line(id)).receiptNumber))).toEqual(["MC26/001", "MC26/002", "MC26/003"]);
    const chf = await line("a-late");
    expect([chf.accountNumber, chf.accountName, chf.vatCodeCopy, chf.vatRateBasisPoints]).toEqual(["5901", "Spese viaggi in treno", "IMP81", 810]);
    expect([chf.ledgerAccountIsDefault, chf.vatCodeIsDefault]).toEqual([true, true]);
    const eur = await line("a-eur");
    expect([eur.accountNumber, eur.vatCodeCopy, eur.vatRateBasisPoints]).toEqual(["5901", "NOVAT", 0]);
    const early = await line("a-early");
    expect([early.accountNumber, early.vatCodeCopy]).toEqual(["6101", "IMP81"]);

    const audit = await db.refundAuditEntry.findMany({ where: { action: { in: ["line_classified", "receipt_number_assigned"] } } });
    expect(audit).toHaveLength(6);
    expect(audit.every((a) => a.actorUserId === "system:accounting-release" && a.actorEmail === "system-accounting-release@welld.ch")).toBe(true);
    expect(audit.every((a) => (a.detail as any).cause === "release")).toBe(true);

    expect(report.lines.map((l) => l.receiptNumber)).toEqual(["MC26/001", "MC26/002", "MC26/003"]);
    expect(report.numbered).toEqual([{ employee: "u1@welld.ch", employeeRef: "MC · u1", year: 2026, count: 3, first: "MC26/001", last: "MC26/003" }]);
    expect(report.unclassified).toEqual([]);
    expect(report.markerWritten).toBe(true);
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(true);
  });

  it("the copy holds the entry as Accounting holds it NOW (the default's values come from the read), not as it was when the default was chosen", async () => {
    fake.setAccount("5901", "Treno (nuovo nome)");
    await request("u1", [{ id: "x", date: "2026-03-20", type: "travel_train" }]);
    await run();
    expect((await line("x")).accountName).toBe("Treno (nuovo nome)");
  });

  it("a foreign-currency line gets the copy of the rate in effect for its expense month; one with no rate stays PENDING, is reported, and is audited as pending", async () => {
    fake.setRate("EUR", "2026-03", 924_600).setRate("GBP", "2026-02", 1_063_500).setRateMissing("USD", "2026-03", "not_published");
    await request("u1", [
      { id: "eur", date: "2026-03-05", currency: "EUR" },
      { id: "usd", date: "2026-03-06", currency: "USD" },
      { id: "gbp", date: "2026-02-10", currency: "GBP" },
    ]);
    const report = await run();

    const eur = await line("eur");
    expect([eur.fxRateMicros, eur.fxRateMonth?.toISOString(), eur.fxRateCopiedAt !== null]).toEqual([924_600, "2026-03-01T00:00:00.000Z", true]);
    const gbp = await line("gbp");
    expect([gbp.fxRateMicros, gbp.fxRateMonth?.toISOString().slice(0, 7)]).toEqual([1_063_500, "2026-02"]);
    const usd = await line("usd");
    expect([usd.fxRateMicros, usd.fxRateMonth, usd.fxRateCopiedAt]).toEqual([null, null, null]);
    // The numbering is the same either way: pending is not a refusal.
    expect([usd.receiptNumber, usd.accountNumber, usd.vatCodeCopy]).toEqual(["MC26/003", "5901", "NOVAT"]);

    const detailOf = async (id: string) =>
      (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: id, action: "line_classified" } })).detail as Record<string, any>;
    expect((await detailOf("eur"))["fxRate"]).toEqual({ rateMicros: 924_600, month: "2026-03" });
    expect((await detailOf("usd"))["fxRate"]).toBe("pending");

    expect(report.ratePending.map((l) => [l.lineId, l.rate])).toEqual([["usd", "pending"]]);
    expect(report.lines.find((l) => l.lineId === "eur")!.rate).toBe("0.9246");
    expect(report.unclassified).toEqual([]);
    const text = formatReport(report);
    expect(text).toContain("Rate pending: 1 lines");
    expect(text).toContain("Left unclassified, account or VAT code missing (0)");
  });

  it("(IS-1) classifies and numbers a legacy line of a PAID request, which the database then locks", async () => {
    await request("u1", [{ id: "p1", date: "2026-03-02" }], { status: "paid" });
    await run();
    const l = await line("p1");
    expect([l.receiptNumber, l.accountNumber, l.vatCodeCopy]).toEqual(["MC26/001", "5901", "IMP81"]);
    // T16 (specs/20261119-accounting): guard v2 watches the COPY columns, no longer the old FK columns.
    await expect(
      Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_line" SET "accountNumber" = '9999', "accountName" = 'x' WHERE id = 'p1'`)),
    ).rejects.toThrow(/locked/);
  });

  it("numbers each employee in their own sequence, two years as two sequences, initials from the name", async () => {
    await request("u1", [{ id: "x1", date: "2025-12-30" }, { id: "x2", date: "2026-01-02" }]);
    await request("u2", [{ id: "y1", date: "2026-03-02" }], { name: "Marco Cattaneo" });
    await request("u3", [{ id: "z1", date: "2026-03-02" }], { name: null, email: "anna.rossi@welld.ch" });
    await run();
    expect(await Promise.all(["x1", "x2", "y1", "z1"].map(async (id) => (await line(id)).receiptNumber))).toEqual(["MC25/001", "MC26/001", "MC26/001", "AR26/001"]);
  });

  it("(AC-7.2) numbers but leaves unclassified a type without a default and an EUR line whose designation is inactive, and reports them", async () => {
    // NOVAT is deactivated in Accounting: it is neither designated nor seeded as a default, and the EUR line has no VAT code
    fake.setVatCodeActive("NOVAT", false).setRate("EUR", "2026-03", 924_600);
    await request("u1", [
      { id: "gift", date: "2026-03-02", type: "representation_gifts" },
      { id: "manual", date: "2026-03-03", type: "company_manuals" },
      { id: "eur", date: "2026-03-04", type: "travel_train", currency: "EUR" },
      { id: "ok", date: "2026-03-05", type: "travel_train" },
    ]);
    const report = await run();
    expect(report.seeded.warnings.join("\n")).toContain("NOVAT");
    expect(report.seeded.foreignCurrencyVatCode).toBeNull();

    const gift = await line("gift");
    expect([gift.receiptNumber, gift.accountNumber, gift.vatCodeCopy]).toEqual(["MC26/001", null, "IMP81"]);
    const manual = await line("manual");
    expect([manual.receiptNumber, manual.accountNumber, manual.vatCodeCopy]).toEqual(["MC26/002", "6101", null]);
    const eur = await line("eur");
    expect([eur.receiptNumber, eur.accountNumber, eur.vatCodeCopy]).toEqual(["MC26/003", "5901", null]);
    // The rate is copied all the same: a line missing its VAT code still has the rate of its month.
    expect(eur.fxRateMicros).toBe(924_600);
    expect((await line("ok")).vatCodeCopy).toBe("IMP81");

    expect(report.unclassified.map((l) => [l.lineId, l.missing])).toEqual([
      ["gift", ["account"]],
      ["manual", ["vatCode"]],
      ["eur", ["vatCode"]],
    ]);
    expect(formatReport(report)).toContain("missing vatCode");
  });

  it("(AC-7.2) a default whose account was deactivated in Accounting after Refund recorded it is numbered, left without that account, and reported", async () => {
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Spese viaggi in treno", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...admin },
    });
    fake.setAccountActive("5901", false);
    await request("u1", [{ id: "t", date: "2026-03-02", type: "travel_train" }]);
    const report = await run();
    const l = await line("t");
    expect([l.receiptNumber, l.accountNumber, l.vatCodeCopy]).toEqual(["MC26/001", null, "IMP81"]);
    expect(report.unclassified.map((u) => [u.lineId, u.missing, u.account, u.vatCode])).toEqual([["t", ["account"], null, "IMP81"]]);
  });

  it("(AC-7.3) leaves WellD Italia lines without number, classification, audit row or counter, and counts them", async () => {
    await request("u1", [{ id: "it", date: "2026-03-02", entity: "welld_it", currency: "EUR" }], { status: "paid" });
    const report = await run();
    expect(report.itLinesLeftUnnumbered).toBe(1);
    const l = await line("it");
    expect([l.receiptNumber, l.accountNumber, l.vatCodeCopy, l.fxRateMicros]).toEqual([null, null, null, null]);
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    await run();
    expect((await line("it")).receiptNumber).toBeNull();
  });

  it("skips rejected lines, and requests that are not approved or paid", async () => {
    await request("u1", [{ id: "rej", date: "2026-03-02", rejected: true }, { id: "fine", date: "2026-03-03" }]);
    await request("u1", [{ id: "sub", date: "2026-03-04" }], { status: "submitted" });
    await request("u1", [{ id: "dra", date: "2026-03-05" }], { status: "draft" });
    await request("u1", [{ id: "rjr", date: "2026-03-06" }], { status: "rejected" });
    await run();
    expect((await line("fine")).receiptNumber).toBe("MC26/001");
    for (const id of ["rej", "sub", "dra", "rjr"]) expect((await line(id)).receiptNumber).toBeNull();
  });
});

describe("Accounting holds no WellD CH entries (AC-7.5)", () => {
  const perms: ResolveResponse = {
    sub: "",
    epoch: 1,
    permissions: [
      { resource: "refund", action: "access", conditions: null },
      { resource: "request", action: "review", conditions: null },
      { resource: "request", action: "approve", conditions: null },
    ],
    entity: null,
    jobTitle: null,
  };

  it("every legacy line is numbered and listed unclassified, nothing is seeded, the report says why; a later approval of a WellD CH request is refused 409 classification_missing", async () => {
    fake = createFakeAccounting();
    await request("u1", [
      { id: "chf", date: "2026-03-02" },
      { id: "eur", date: "2026-03-03", currency: "EUR" },
      { id: "it", date: "2026-03-04", entity: "welld_it" },
    ]);
    const report = await run();

    expect(report.markerWritten).toBe(true);
    expect(report.lines.map((l) => l.receiptNumber)).toEqual(["MC26/001", "MC26/002"]);
    expect(report.unclassified.map((l) => [l.lineId, l.missing])).toEqual([
      ["chf", ["account", "vatCode"]],
      ["eur", ["account", "vatCode"]],
    ]);
    expect(report.seeded.typeDefaults).toEqual([]);
    expect(report.seeded.foreignCurrencyVatCode).toBeNull();
    expect(report.seeded.warnings.length).toBeGreaterThan(0);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
    const text = formatReport(report);
    expect(text).toContain("Accounting holds no active WellD CH ledger accounts or VAT codes");
    expect(text).toContain("Left unclassified, account or VAT code missing (2)");
    const l = await line("chf");
    expect([l.accountNumber, l.vatCodeCopy]).toEqual([null, null]);

    // The marker is set, so approvals are accepted again; a CH line then has nothing to be booked with.
    useFakeAccounting(fake);
    __resetAuthzCacheForTests();
    harness.setResolve(async () => perms);
    const submitted = await db.refundRequest.create({
      data: { ownerUserId: "u9", ownerEmail: "u9@welld.ch", ownerName: "Anna Rossi", status: "submitted", submittedAt: new Date("2026-11-20") },
    });
    await db.refundLine.create({
      data: { requestId: submitted.id, date: new Date("2026-11-10"), type: "travel_train", motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 1000 },
    });
    const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
    const res = await decideRouter.request(`/review/requests/${submitted.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("classification_missing");
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: submitted.id } })).status).toBe("submitted");
  });
});

describe("Refund's defaults and designation (AC-2.5, D20)", () => {
  it("seeds the twelve type defaults where the file gave an answer and designates NOVAT, as COPIES by natural key, with the system actor", async () => {
    const report = await run();
    expect(report.seeded.typeDefaults).toHaveLength(12);
    const km = await db.expenseTypeAccountingDefault.findFirstOrThrow({ where: { type: "travel_km" } });
    expect(km).toMatchObject({
      entity: "welld_ch",
      accountNumber: "5905",
      accountName: "Spese rimborsi chilometrici (viaggi)",
      vatCode: "NOVAT",
      vatLabel: "Senza IVA",
      vatRateBasisPoints: 0,
      createdByUserId: "system:accounting-seed",
      createdByEmail: "system-accounting-seed@welld.ch",
    });
    const gifts = await db.expenseTypeAccountingDefault.findFirstOrThrow({ where: { type: "representation_gifts" } });
    expect([gifts.accountNumber, gifts.accountName, gifts.vatCode]).toEqual([null, null, "IMP81"]);

    const recorded = await loadRecordedDefaults();
    expect(recorded.foreignCurrencyVatCode).toEqual({ code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0 });
    const designations = await db.foreignCurrencyVatDesignation.findMany();
    expect(designations).toHaveLength(1);
    expect(designations[0]).toMatchObject({ entity: "welld_ch", vatCode: "NOVAT", createdByUserId: "system:accounting-seed", createdByEmail: "system-accounting-seed@welld.ch" });
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "foreign_currency_vat_designation" SET "vatCode" = NULL WHERE id = $1`, designations[0]!.id))).rejects.toThrow();
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "expense_type_accounting_default" SET "accountNumber" = NULL WHERE id = $1`, km.id))).rejects.toThrow();
  });

  it("never creates anything in Accounting: it only reads (a reader's projection has no write at all)", async () => {
    await run();
    expect(fake.calls.every((c) => c.read === "referenceData" || c.read === "rates")).toBe(true);
  });

  it("an earlier designation row of Refund (even a cleared one) is never overridden, though the rest is still seeded", async () => {
    await db.foreignCurrencyVatDesignation.create({ data: { entity: "welld_ch", vatCode: "IMP77", vatLabel: "IVA 7.7%", vatRateBasisPoints: 770, ...admin } });
    const report = await run();
    expect(report.seeded.foreignCurrencyVatCode).toBeNull();
    expect(report.seeded.typeDefaults).toHaveLength(12);
    expect((await loadRecordedDefaults()).foreignCurrencyVatCode?.code).toBe("IMP77");
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(1);
  });

  it("an admin's earlier choice for a type (even an explicit none) is kept, and nothing is appended for it", async () => {
    await db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "postal", ...admin } });
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "telephone", accountNumber: "5901", accountName: "My own name", ...admin },
    });
    const report = await run();
    expect(report.seeded.typeDefaults).not.toContain("postal");
    expect(report.seeded.typeDefaults).not.toContain("telephone");
    expect(await db.expenseTypeAccountingDefault.count({ where: { type: "postal" } })).toBe(1);
    const telephone = await db.expenseTypeAccountingDefault.findMany({ where: { type: "telephone" } });
    expect(telephone).toHaveLength(1);
    expect(telephone[0]!.accountName).toBe("My own name");
  });

  it("does not seed a default whose entry is deactivated or missing in Accounting, keeps the other half, and says so", async () => {
    fake.setAccountActive("6104", false).removeVatCode("IMP77");
    const report = await run();
    expect(report.seeded.warnings.join("\n")).toContain("6104");
    expect(report.seeded.warnings.join("\n")).toContain("deactivated");
    const postal = await db.expenseTypeAccountingDefault.findFirstOrThrow({ where: { type: "postal" } });
    expect([postal.accountNumber, postal.vatCode]).toEqual([null, "NOVAT"]);

    // An entry the file names that Accounting does not hold at all is "not found" in the warning.
    await truncateRefundTables({ released: false });
    fake = fullAccounting();
    fake.removeAccount("5905").setVatCodeActive("NOVAT", false);
    const second = await run();
    expect(second.seeded.warnings.join("\n")).toMatch(/5905 is not found/);
    expect(second.seeded.warnings.join("\n")).toMatch(/NOVAT is deactivated/);
    expect(second.seeded.foreignCurrencyVatCode).toBeNull();
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
    const km = await db.expenseTypeAccountingDefault.count({ where: { type: "travel_km" } });
    expect(km).toBe(0); // both halves were unusable: no row at all
  });
});

describe("idempotence and dry run", () => {
  it("a second run changes nothing, not even a second marker", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-03", currency: "EUR" }]);
    await request("u2", [{ id: "l3", date: "2026-03-04", type: "postal" }], { name: "Anna Rossi" });
    await run();
    const before = await snapshot();
    const second = await run();
    expect(await snapshot()).toEqual(before);
    expect(second).toMatchObject({ alreadyReleased: true, markerWritten: false, lines: [], unclassified: [], ratePending: [] });
    expect(second.seeded).toMatchObject({ typeDefaults: [], foreignCurrencyVatCode: null });
    expect(await db.refundSetting.count({ where: { key: "accounting-release-completed-at" } })).toBe(1);
  });

  it("--dry-run reads Accounting, writes nothing and reports exactly what the real run then does, rates included", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-01", type: "postal" }, { id: "l3", date: "2026-03-07", currency: "EUR" }]);
    const before = await snapshot();
    const dry = await run({ dryRun: true });
    expect(await snapshot()).toEqual(before);
    expect(dry.dryRun).toBe(true);
    expect(fake.reads.total).toBeGreaterThan(0);
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
    const view = (r: typeof dry) => r.lines.map((l) => [l.lineId, l.receiptNumber, l.account, l.vatCode, l.rate]);
    expect(view(dry)).toEqual([
      ["l2", "MC26/001", "6104", "NOVAT", null],
      ["l1", "MC26/002", "5901", "IMP81", null],
      ["l3", "MC26/003", "5901", "NOVAT", "0.9246"],
    ]);
    expect(formatReport(dry)).toContain("DRY RUN");
    expect(formatReport(dry)).toContain("MC26/002");
    expect(formatReport(dry)).toContain("0.9246");

    const real = await run();
    expect(view(real)).toEqual(view(dry));
    expect(real.dryRun).toBe(false);
  });
});

describe("offsets (D2)", () => {
  it("numbering starts after the offset, and the counter records it as loaded by the release", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-03" }], { email: "matteo.codogno@welld.ch" });
    const report = await run({ offsets: [{ email: "Matteo.Codogno@welld.ch", year: 2026, lastIssuedSeq: 81 }] });
    expect(report.offsets).toEqual([{ email: "Matteo.Codogno@welld.ch", employeeRef: "MC · u1", year: 2026, lastIssuedSeq: 81, outcome: "applied" }]);
    expect((await line("l1")).receiptNumber).toBe("MC26/082");
    expect((await line("l2")).receiptNumber).toBe("MC26/083");
    const counter = await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "u1", year: 2026 } } });
    expect(counter).toMatchObject({ lastSeq: 83, startAfter: 81, startAfterSetBy: "system:accounting-release" });
  });

  it("an offset for a year with no lines applies to that year only", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }], { email: "m@welld.ch" });
    await run({ offsets: [{ email: "m@welld.ch", year: 2027, lastIssuedSeq: 5 }] });
    expect((await line("l1")).receiptNumber).toBe("MC26/001");
    expect((await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "u1", year: 2027 } } })).lastSeq).toBe(5);
  });

  it("is refused for an (employee, year) pair that already has numbers, and then NOTHING is written", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }], { email: "m@welld.ch" });
    await run();
    await request("u1", [{ id: "l2", date: "2026-03-09" }], { email: "m@welld.ch" });
    const before = await snapshot();
    await expect(run({ offsets: [{ email: "m@welld.ch", year: 2026, lastIssuedSeq: 81 }] })).rejects.toThrow(/already has receipt numbers/);
    expect(await snapshot()).toEqual(before);
    expect((await line("l2")).receiptNumber).toBeNull();
  });

  it("a refused offset rolls back the seed and the marker too", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }], { email: "m@welld.ch" });
    await expect(run({ offsets: [{ email: "nobody@welld.ch", year: 2026, lastIssuedSeq: 5 }] })).rejects.toThrow(/n\*\*\*@welld\.ch/);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
    expect(await db.refundSetting.count()).toBe(0);
    expect((await line("l1")).receiptNumber).toBeNull();
  });

  it("is refused for an email that belongs to two user ids", async () => {
    await request("u1", [], { email: "m@welld.ch" });
    await request("u2", [], { email: "M@welld.ch" });
    await expect(run({ offsets: [{ email: "m@welld.ch", year: 2026, lastIssuedSeq: 5 }] })).rejects.toThrow(/more than one/);
  });

  it("repeating the very same offset on an untouched counter is already-applied, not an error", async () => {
    await request("u1", [], { email: "m@welld.ch" });
    await run({ offsets: [{ email: "m@welld.ch", year: 2027, lastIssuedSeq: 5 }] });
    const again = await run({ offsets: [{ email: "m@welld.ch", year: 2027, lastIssuedSeq: 5 }] });
    expect(again.offsets[0]!.outcome).toBe("already-applied");
    await expect(run({ offsets: [{ email: "m@welld.ch", year: 2027, lastIssuedSeq: 6 }] })).rejects.toThrow(ReleaseError);
  });
});

// ─── Fix round 1 (T41): D-1, SR-3, SR-4 ──────────────────────────────────────

describe("the report (D-1, SR-4)", () => {
  async function legacy() {
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-03", type: "representation_gifts" }], { email: "matteo.codogno@welld.ch" });
  }

  it("D-1: a dry run never says the marker was written; the real run says yes; a later run says it was already set", async () => {
    await legacy();
    const dry = formatReport(await run({ dryRun: true }));
    expect(dry).toContain("Release marker written: no (dry run: the real run would write it)");
    expect(dry).not.toContain("Release marker written: yes");
    expect(formatReport(await run())).toContain("Release marker written: yes");
    expect(formatReport(await run())).toContain("Release marker written: no (already set)");
    expect(formatReport(await run({ dryRun: true }))).toContain("Release marker written: no (already set)");
  });

  it("SR-4: an employee is `<initials> · <first 8 characters of the user id>`, and no `@` appears anywhere without showEmails", async () => {
    await request("0123456789abcdef", [{ id: "l1", date: "2026-03-02" }], { email: "matteo.codogno@welld.ch", name: "Matteo Codogno" });
    const report = await run({ dryRun: true, offsets: [{ email: "matteo.codogno@welld.ch", year: 2027, lastIssuedSeq: 4 }] });
    for (const text of [formatReport(report), formatReport(report, { showEmails: false })]) {
      expect(text).not.toContain("@");
      expect(text).toContain("MC · 01234567");
      expect(text).not.toContain("89abcdef");
    }
    expect(formatReport(report, { showEmails: true })).toContain("matteo.codogno@welld.ch");
  });

  it("SR-4: the unclassified lines are listed by the same reference", async () => {
    await legacy();
    const text = formatReport(await run({ dryRun: true }));
    expect(text).toMatch(/Left unclassified, account or VAT code missing \(1\)\n {2}MC26\/002 MC · u1 2026-03-03 representation_gifts/);
    expect(text).not.toContain("@");
  });
});

describe("describeReleaseFailure (F-03)", () => {
  it("a ReleaseError prints its own, already masked, message", () => {
    expect(describeReleaseFailure(new ReleaseError("usage", "unknown argument --x"))).toBe("unknown argument --x");
  });

  it("any other error prints its kind (and a plain error code), never its message, which can carry an address, a host or a credential", () => {
    const driver = Object.assign(new Error("connect ECONNREFUSED postgresql://user:secret@db.internal:5432/refund for matteo.codogno@welld.ch"), {
      name: "PrismaClientInitializationError",
      code: "P1001",
    });
    const text = describeReleaseFailure(driver);
    expect(text).toBe("PrismaClientInitializationError (P1001)");
    expect(text).not.toMatch(/secret|db\.internal|@|matteo/);
    expect(describeReleaseFailure(new TypeError("x@y.ch"))).toBe("TypeError");
    expect(describeReleaseFailure(Object.assign(new Error("m"), { code: "has spaces and secret@x.ch" }))).toBe("Error");
    expect(describeReleaseFailure(Object.assign(new Error("m"), { name: "Evil\nname secret@x.ch" }))).toBe("Error");
    expect(describeReleaseFailure("secret@x.ch")).toBe("an unknown error");
    expect(describeReleaseFailure(null)).toBe("an unknown error");
  });
});

describe("maskEmail (SR-4)", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("matteo.codogno@welld.ch")).toBe("m***@welld.ch");
    expect(maskEmail("A@b.ch")).toBe("A***@b.ch");
  });
  it("a value with no local part or no @ keeps one character at most", () => {
    expect(maskEmail("not-an-email")).toBe("n***");
    expect(maskEmail("@welld.ch")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });
  it("parse errors mask the cell unless asked", () => {
    expect(() => parseOffsetsCsv("matteo@x,2026,1")).toThrow(/"m\*\*\*@x"/);
    expect(() => parseOffsetsCsv("matteo@x,2026,1", { showEmails: true })).toThrow(/"matteo@x"/);
    expect(() => parseOffsetsCsv("a@b.ch,2026,1\nA@b.ch,2026,2")).toThrow(/A\*\*\*@b\.ch 2026 appears twice/);
  });
});

describe("offsetsPathWarning (SR-3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "offsets-path-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("warns for a file under a directory that has `.git` (a directory, or a file as in a linked worktree), at any depth", () => {
    mkdirSync(join(dir, "clone", ".git"), { recursive: true });
    mkdirSync(join(dir, "clone", "a", "b"), { recursive: true });
    mkdirSync(join(dir, "linked", "x"), { recursive: true });
    writeFileSync(join(dir, "linked", ".git"), "gitdir: /elsewhere\n");
    expect(offsetsPathWarning(join(dir, "clone", "a", "b", "offsets.csv"))).toContain("inside a git worktree");
    expect(offsetsPathWarning(join(dir, "linked", "x", "offsets.csv"))).toContain("inside a git worktree");
    expect(offsetsPathWarning(join(dir, "clone", "a", "b", "offsets.csv"))).not.toContain("@");
  });
  it("is silent for a path outside any worktree", () => {
    mkdirSync(join(dir, "plain"), { recursive: true });
    expect(offsetsPathWarning(join(dir, "plain", "offsets.csv"))).toBeNull();
  });
});

describe(".gitignore keeps an offsets file out of the repository (SR-3, S-03)", () => {
  const root = join(import.meta.dir, "..", "..");
  const ignored = (path: string) => Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: root }).exitCode === 0;

  it("ignores offsets CSVs and accounting-offsets files anywhere in the tree", () => {
    for (const path of ["refund-api/offsets.csv", "refund-api/scripts/accounting-offsets.csv", "accounting-offsets", "refund-api/accounting-offsets.txt", "refund-api/data/paper-offsets-2026.csv", "x/y/z/offsets.csv"]) {
      expect(ignored(path)).toBe(true);
    }
  });
  it("does not ignore the script, its tests or its defaults file", () => {
    for (const path of ["refund-api/scripts/accounting-release.ts", "refund-api/scripts/accounting-release.test.ts", "refund-api/scripts/data/accounting-defaults.welld-ch.json"]) {
      expect(ignored(path)).toBe(false);
    }
  });
  it("no tracked file matches the patterns", () => {
    const tracked = new TextDecoder().decode(Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout).split("\n");
    expect(tracked.filter((f) => /offsets.*\.csv$/.test(f) || /accounting-offsets/.test(f))).toEqual([]);
  });
});
