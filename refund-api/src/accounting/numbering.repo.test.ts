/**
 * `classifyAndNumber` against real Postgres (T8, specs/20261118-refund-
 * accounting-export; AC-3.5, AC-4.3, AC-4.4, AC-4.5, AC-4.7, AC-4.10).
 *
 * The function is exercised directly inside `db.$transaction`, the way the
 * approve transaction (T12) and the release script (T11) call it.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import type { Entity, ExpenseType, Currency } from "../lib/generated/prisma/enums";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { createFakeAccounting } from "../test-support/fakeAccounting";
import { ratePairKey } from "./accountingClient";
import { referenceSnapshot } from "./referenceSnapshot";
import { classifyAndNumber, type AccountingReads, type ClassifyAndNumberInput } from "./numbering.repo";

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const actor = { userId: "acc-1", email: "acc@welld.ch" };

/** What the caller read from Accounting before its transaction: the reference data and the rates of the foreign pairs. */
let reference: AccountingReads;
const fake = createFakeAccounting();

/** Reads the fake the way the approve route does, so what is numbered is what Accounting says. */
async function readReference(pairs: { currency: "EUR" | "USD" | "GBP"; month: string }[] = []): Promise<AccountingReads> {
  const op = fake.begin("approve");
  const [data, answers] = await Promise.all([op.referenceData(), op.rates(pairs)]);
  return { snapshot: referenceSnapshot(data), rates: new Map(answers.map((a) => [ratePairKey(a), a] as const)) };
}

beforeEach(async () => {
  await truncateRefundTables();
  for (const a of ["5901", "6101"]) fake.removeAccount(a);
  for (const v of ["IMP81", "NOVAT"]) fake.removeVatCode(v);
  for (const c of ["EUR", "USD", "GBP"] as const) for (const m of ["2026-03", "2025-12", "2026-01"]) fake.removeRate(c, m);
  fake.setAccount("5901", "Treno").setAccount("6101", "Ufficio").setVatCode("IMP81", "IVA 8.1%", 810).setVatCode("NOVAT", "Senza IVA", 0);
  // Refund's recorded defaults (copies): train, office and postal. Accounts only: there is no VAT default, no designation.
  const copy = (type: ExpenseType, accountNumber: string, accountName: string) =>
    db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type, accountNumber, accountName, ...by } });
  await copy("travel_train", "5901", "Treno");
  await copy("office_material", "6101", "Ufficio");
  await copy("postal", "6101", "Ufficio");
  reference = await readReference([{ currency: "EUR", month: "2026-03" }, { currency: "EUR", month: "2026-01" }, { currency: "EUR", month: "2025-12" }]);
});
afterAll(async () => {
  await truncateRefundTables();
});

interface LineSpec {
  date: string;
  type?: ExpenseType;
  entity?: Entity;
  currency?: Currency;
  rejected?: boolean;
  createdAt?: string;
  id?: string;
  /** A hand copy stored on the line (WellD CH only). */
  accountNumber?: string;
  accountName?: string;
  ledgerAccountIsDefault?: boolean;
  /** A rate copy already on the line. */
  fxRateMicros?: number;
}

async function makeRequest(
  owner: string,
  lines: LineSpec[],
  opts: { status?: "submitted" | "approved" | "paid"; name?: string | null; email?: string } = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner,
      ownerEmail: opts.email ?? `${owner}@welld.ch`,
      ownerName: opts.name === undefined ? "Matteo Codogno" : opts.name,
      status: opts.status ?? "submitted",
    },
  });
  const ids: string[] = [];
  for (const spec of lines) {
    const line = await db.refundLine.create({
      data: {
        ...(spec.id ? { id: spec.id } : {}),
        requestId: request.id,
        date: new Date(spec.date),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: spec.entity ?? "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: 1000,
        approvedTotalCents: 1000,
        ...(spec.createdAt ? { createdAt: new Date(spec.createdAt) } : {}),
        ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x" } : {}),
        ...(spec.accountNumber
          ? { accountNumber: spec.accountNumber, accountName: spec.accountName ?? "x", ledgerAccountIsDefault: spec.ledgerAccountIsDefault ?? false }
          : {}),
        ...(spec.fxRateMicros ? { fxRateMicros: spec.fxRateMicros, fxRateMonth: new Date(`${spec.date.slice(0, 7)}-01T00:00:00Z`), fxRateCopiedAt: new Date() } : {}),
      },
    });
    ids.push(line.id);
  }
  return { request, ids };
}

const run = (
  requestIds: string[],
  owner: ClassifyAndNumberInput["owner"] = { userId: "owner-1", name: "Matteo Codogno", email: "matteo.codogno@welld.ch" },
  extra: Partial<ClassifyAndNumberInput> = {},
) =>
  db.$transaction((tx) =>
    classifyAndNumber(tx, { owner, requestIds, cause: "approval", actor, reference, ...extra }),
  );

const numberOf = async (id: string) => (await db.refundLine.findUniqueOrThrow({ where: { id } })).receiptNumber;

describe("numbering", () => {
  it("(AC-4.3) numbers contiguously from 001 across successive calls and keeps the counter equal to the highest", async () => {
    const r1 = await makeRequest("owner-1", [{ date: "2026-03-02" }, { date: "2026-03-03" }]);
    const r2 = await makeRequest("owner-1", [{ date: "2026-03-04" }]);
    const first = await run([r1.request.id]);
    const second = await run([r2.request.id]);
    expect(first.ok && first.lines.map((l) => l.receiptNumber)).toEqual(["MC26/001", "MC26/002"]);
    expect(second.ok && second.lines.map((l) => l.receiptNumber)).toEqual(["MC26/003"]);
    const counter = await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } });
    expect(counter.lastSeq).toBe(3);
    expect(counter.startAfter).toBe(0);
  });

  it("(AC-4.4) numbers by expense date, then createdAt, then id", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-03-10", id: "line-a" },
      { date: "2026-03-02", createdAt: "2026-03-05T10:00:00Z", id: "line-b" },
      { date: "2026-03-02", createdAt: "2026-03-05T09:00:00Z", id: "line-z" },
      { date: "2026-03-02", createdAt: "2026-03-05T09:00:00Z", id: "line-y" },
    ]);
    await run([r.request.id]);
    expect(await Promise.all(["line-y", "line-z", "line-b", "line-a"].map(numberOf))).toEqual([
      "MC26/001",
      "MC26/002",
      "MC26/003",
      "MC26/004",
    ]);
  });

  it("(AC-4.5) two years in one call are two sequences, each starting at 001", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-01-02", id: "l26" },
      { date: "2025-12-30", id: "l25a" },
      { date: "2025-12-31", id: "l25b" },
    ]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines.map((l) => [l.lineId, l.receiptNumber])).toEqual([
      ["l25a", "MC25/001"],
      ["l25b", "MC25/002"],
      ["l26", "MC26/001"],
    ]);
    const years = (await db.receiptCounter.findMany({ orderBy: { year: "asc" } })).map((c) => [c.year, c.lastSeq]);
    expect(years).toEqual([[2025, 2], [2026, 1]]);
  });

  it("(AC-4.6) two employees with the same initials each start at 001, and the line records its owner", async () => {
    const a = await makeRequest("owner-1", [{ date: "2026-03-02", id: "la" }]);
    const b = await makeRequest("owner-2", [{ date: "2026-03-02", id: "lb" }], { name: "Marco Cattaneo" });
    await run([a.request.id]);
    await run([b.request.id], { userId: "owner-2", name: "Marco Cattaneo", email: "owner-2@welld.ch" });
    expect(await numberOf("la")).toBe("MC26/001");
    expect(await numberOf("lb")).toBe("MC26/001");
    const lb = await db.refundLine.findUniqueOrThrow({ where: { id: "lb" } });
    expect(lb).toMatchObject({ receiptOwnerUserId: "owner-2", receiptYear: 2026, receiptSeq: 1 });
  });

  it("(D2) honours a starting offset: the first number is startAfter + 1", async () => {
    await db.receiptCounter.create({
      data: { ownerUserId: "owner-1", year: 2026, lastSeq: 81, startAfter: 81, startAfterSetBy: "system:accounting-release" },
    });
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }, { date: "2026-03-03", id: "l2" }]);
    await run([r.request.id]);
    expect(await numberOf("l1")).toBe("MC26/082");
    expect(await numberOf("l2")).toBe("MC26/083");
    const counter = await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } });
    expect(counter).toMatchObject({ lastSeq: 83, startAfter: 81 });
  });

  it("(AC-4.10) 20 concurrent calls for one employee: 20 distinct, contiguous numbers", async () => {
    const requests = await Promise.all(
      Array.from({ length: 20 }, (_, i) => makeRequest("owner-1", [{ date: `2026-03-${String(i + 1).padStart(2, "0")}`, id: `c${i}` }])),
    );
    const results = await Promise.all(requests.map((r) => run([r.request.id])));
    expect(results.every((r) => r.ok)).toBe(true);
    const seqs = (await db.refundLine.findMany({ where: { receiptOwnerUserId: "owner-1" }, select: { receiptSeq: true } }))
      .map((l) => l.receiptSeq!)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } })).lastSeq).toBe(20);
  });

  it("(AC-4.10) concurrent calls whose lines span two years do not deadlock", async () => {
    const requests = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        makeRequest("owner-1", [{ date: "2025-12-30", id: `y25-${i}` }, { date: "2026-01-02", id: `y26-${i}` }]),
      ),
    );
    const results = await Promise.all(requests.map((r) => run([r.request.id])));
    expect(results.every((r) => r.ok)).toBe(true);
    const counters = await db.receiptCounter.findMany({ orderBy: { year: "asc" } });
    expect(counters.map((c) => [c.year, c.lastSeq])).toEqual([[2025, 10], [2026, 10]]);
  });

  it("(AC-4.3) a rolled-back transaction consumes no number and leaves no counter row", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    await expect(
      db.$transaction(async (tx) => {
        const res = await classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "approval", actor, reference });
        expect(res.ok).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await numberOf("l1")).toBeNull();
    expect(await db.receiptCounter.count()).toBe(0);
    expect(await db.refundAuditEntry.count()).toBe(0);
    await run([r.request.id]);
    expect(await numberOf("l1")).toBe("MC26/001");
  });

  it("(AC-4.1) numbers WellD Italia lines too, skips rejected lines, and never renumbers a numbered line", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-03-02", id: "ch" },
      { date: "2026-03-03", id: "it", entity: "welld_it", currency: "EUR" },
      { date: "2026-03-04", id: "rej", rejected: true },
    ]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines.map((l) => l.lineId)).toEqual(["ch", "it"]);
    expect(await numberOf("rej")).toBeNull();
    const again = await run([r.request.id]);
    expect(again).toEqual({ ok: true, lines: [] });
    expect(await numberOf("ch")).toBe("MC26/001");
    expect((await db.receiptCounter.findFirstOrThrow()).lastSeq).toBe(2);
  });

  it("(AC-7.3) the entities filter leaves other lines untouched", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-03-02", id: "ch" },
      { date: "2026-03-03", id: "it", entity: "welld_it", currency: "EUR" },
    ]);
    const res = await run([r.request.id], undefined, { entities: ["welld_ch"] });
    expect(res.ok && res.lines.map((l) => l.lineId)).toEqual(["ch"]);
    expect(await numberOf("it")).toBeNull();
  });

  it("numbers the lines of several requests of one employee by expense date across the requests", async () => {
    const a = await makeRequest("owner-1", [{ date: "2026-03-20", id: "late" }]);
    const b = await makeRequest("owner-1", [{ date: "2026-03-01", id: "early" }]);
    await run([a.request.id, b.request.id]);
    expect(await numberOf("early")).toBe("MC26/001");
    expect(await numberOf("late")).toBe("MC26/002");
  });

  it("falls back to the email for initials, padded with X", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    await run([r.request.id], { userId: "owner-1", name: "Cher", email: "x@welld.ch" });
    expect(await numberOf("l1")).toBe("XX26/001");
  });
});

describe("classification copy", () => {
  it("(AC-5.1) copies the default account from Accounting's current entry, marked default, no VAT code, and audits cause approval, from null to the copy", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", type: "travel_train" }]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines[0]!.missing).toEqual([]);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({
      accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: true,
      vatCodeCopy: null, vatRateBasisPoints: null, vatCodeIsDefault: null,
      fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null,
    });
    expect(Object.keys(line).filter((key) => /ledgerAccountId|vatCodeId/.test(key))).toEqual([]); // the old foreign keys are gone (T24)
    const audit = await db.refundAuditEntry.findMany({ where: { lineId: "l1" }, orderBy: { createdAt: "asc" } });
    const classified = audit.find((a) => a.action === "line_classified")!;
    expect(classified).toMatchObject({ actorUserId: "acc-1", actorEmail: "acc@welld.ch", requestId: r.request.id });
    expect(classified.detail).toEqual({
      v: 2,
      cause: "approval",
      account: { from: null, to: { number: "5901", name: "Treno" }, fromDefault: true, toDefault: true },
      vatCode: { from: null, to: null, fromDefault: false, toDefault: false },
    });
    const assigned = audit.find((a) => a.action === "receipt_number_assigned")!;
    expect(assigned.detail).toEqual({ cause: "approval", receiptNumber: "MC26/001", year: 2026, seq: 1 });
  });

  it("(D11) a default takes the entry's name as Accounting holds it NOW, not the name Refund recorded", async () => {
    fake.setAccount("5901", "Treno e bus");
    reference = await readReference();
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    await run([r.request.id]);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).toMatchObject({ accountNumber: "5901", accountName: "Treno e bus" });
  });

  it("(AC-3.13 of 20261118) a foreign-currency line gets the account and NO VAT code: nothing is pre-set", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", currency: "EUR" }]);
    expect((await run([r.request.id])).ok).toBe(true);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect([line.vatCodeCopy, line.vatRateBasisPoints, line.vatCodeIsDefault]).toEqual([null, null, null]);
    expect(line.accountNumber).toBe("5901");
  });

  it("(AC-3.5, AC-5.1) a VAT copy stored by hand is booked as it is, flagged false, audited from the copy to the same copy", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", currency: "EUR" }]);
    await db.refundLine.update({ where: { id: "l1" }, data: { vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: true /* a former default's flag */ } });
    expect((await run([r.request.id])).ok).toBe(true);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({ vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false });
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } })).detail as any;
    expect(detail.vatCode).toEqual({
      from: { code: "IMP81", rateBasisPoints: 810 },
      to: { code: "IMP81", rateBasisPoints: 810 },
      fromDefault: false,
      toDefault: false,
    });
  });

  it("keeps a hand copy and its flag exactly as stored, and audits it from the copy", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", accountNumber: "6101", accountName: "Ufficio (as copied)", ledgerAccountIsDefault: false }]);
    await run([r.request.id]);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as copied)", ledgerAccountIsDefault: false, vatCodeIsDefault: null });
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } })).detail as any;
    expect(detail.account).toMatchObject({ from: { number: "6101" }, to: { number: "6101", name: "Ufficio (as copied)" }, fromDefault: false, toDefault: false });
  });

  it("(AC-5.3) a hand copy whose entry was deactivated or has vanished is kept, not refused", async () => {
    fake.setAccountActive("6101", false);
    reference = await readReference();
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false }]);
    expect((await run([r.request.id])).ok).toBe(true);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).accountNumber).toBe("6101");
  });

  it("(AC-6.3, AC-3.4) a missing account refuses the approval, naming line, date and type, and writes nothing; a line with no VAT code never does", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-03-05", id: "ok", type: "travel_train" },
      { date: "2026-03-02", id: "fine", type: "postal" }, // an account, no VAT code: complete
      { date: "2026-03-03", id: "worse", type: "stationery" }, // no default at all
      { date: "2026-03-04", id: "gifts", type: "representation_gifts" }, // no account chosen yet (20261118 AC-8.3)
    ]);
    const res = await run([r.request.id]);
    expect(res).toEqual({
      ok: false,
      reason: "classification_missing",
      missing: [
        { lineId: "worse", requestId: r.request.id, date: "2026-03-03", type: "stationery", missing: ["account"] },
        { lineId: "gifts", requestId: r.request.id, date: "2026-03-04", type: "representation_gifts", missing: ["account"] },
      ],
    });
    expect(await db.receiptCounter.count()).toBe(0);
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.refundLine.count({ where: { receiptNumber: { not: null } } })).toBe(0);
    expect(await db.refundLine.count({ where: { accountNumber: { not: null } } })).toBe(0);
  });

  it("(AC-6.3, AC-4.5) a default whose entry is deactivated, no longer found, or unverifiable counts as missing", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    fake.setAccountActive("5901", false);
    reference = await readReference();
    let res = await run([r.request.id]);
    expect(res.ok === false && res.reason === "classification_missing" && res.missing[0]!.missing).toEqual(["account"]);
    expect(await db.refundLine.count({ where: { receiptNumber: { not: null } } })).toBe(0);
    fake.setAccountActive("5901", true);
    reference = await readReference();
    expect((await run([r.request.id])).ok).toBe(true);
  });

  it("(AC-3.11) VAT codes are irrelevant to the approval: with no code in Accounting at all, CHF and foreign lines are numbered alike", async () => {
    fake.removeVatCode("IMP81");
    fake.removeVatCode("NOVAT");
    fake.setRate("EUR", "2026-03", 924_600);
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const chf = await makeRequest("owner-1", [{ date: "2026-03-02", id: "chf" }]);
    const eur = await makeRequest("owner-2", [{ date: "2026-03-02", id: "eur", currency: "EUR" }]);
    expect((await run([chf.request.id])).ok).toBe(true);
    expect((await run([eur.request.id], { userId: "owner-2", name: "A B", email: "a.b@x.ch" })).ok).toBe(true);
    expect(await db.refundLine.count({ where: { receiptNumber: { not: null }, vatCodeCopy: null } })).toBe(2);
  });

  it("a WellD CH line with no read of Accounting is refused as reference_missing, never classified from nothing", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    const res = await run([r.request.id], undefined, { reference: null });
    expect(res).toEqual({ ok: false, reason: "reference_missing" });
    expect(await db.receiptCounter.count()).toBe(0);
    expect(await db.refundLine.count({ where: { receiptNumber: { not: null } } })).toBe(0);
  });

  it("(AC-6.4) a request with only WellD Italia lines needs no read of Accounting at all", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "it", entity: "welld_it", currency: "EUR" }]);
    const res = await run([r.request.id], undefined, { reference: null });
    expect(res.ok && res.lines[0]).toMatchObject({ lineId: "it", receiptNumber: "MC26/001", missing: null, fxRate: null, ratePending: false });
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "it" } })).toMatchObject({ accountNumber: null, fxRateMicros: null });
  });
});

describe("the exchange-rate copy (AC-5.1, AC-5.6)", () => {
  it("a foreign line whose month has a rate in effect: the rate and its month are copied with the number, and the audit carries them", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "l1", currency: "EUR" }]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines[0]).toMatchObject({ fxRate: { rateMicros: 924_600, month: "2026-03" }, ratePending: false });
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line.fxRateMicros).toBe(924_600);
    expect(line.fxRateMonth?.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(line.fxRateCopiedAt).not.toBeNull();
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } })).detail as any;
    expect(detail.fxRate).toEqual({ rateMicros: 924_600, month: "2026-03" });
  });

  it("no rate in effect: the line is numbered and classified, left rate pending, and the audit says so", async () => {
    fake.setRateMissing("EUR", "2026-03", "not_published");
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "l1", currency: "EUR" }]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines[0]).toMatchObject({ receiptNumber: "MC26/001", fxRate: null, ratePending: true });
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).toMatchObject({ fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null, accountNumber: "5901" });
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } })).detail as any;
    expect(detail.fxRate).toBe("pending");
  });

  it("a CHF line has no rate and no fxRate in its audit; each month gets its own rate", async () => {
    fake.setRate("EUR", "2026-01", 900_000).setRate("EUR", "2026-03", 924_600);
    reference = await readReference([{ currency: "EUR", month: "2026-01" }, { currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [
      { date: "2026-01-10", id: "jan", currency: "EUR" },
      { date: "2026-03-10", id: "mar", currency: "EUR" },
      { date: "2026-03-11", id: "chf", currency: "CHF" },
    ]);
    await run([r.request.id]);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: "jan" } })).fxRateMicros).toBe(900_000);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: "mar" } })).fxRateMicros).toBe(924_600);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: "chf" } })).fxRateMicros).toBeNull();
    const chfDetail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "chf", action: "line_classified" } })).detail as any;
    expect(chfDetail).not.toHaveProperty("fxRate");
  });

  it("a WellD Italia foreign line is numbered but has neither a classification nor a rate, even if Accounting has the rate", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "it", entity: "welld_it", currency: "EUR" }]);
    await run([r.request.id]);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "it" } })).toMatchObject({ receiptNumber: "MC26/001", fxRateMicros: null, accountNumber: null });
  });

  it("a rate copy already on the line is never written again (write-once)", async () => {
    fake.setRate("EUR", "2026-03", 930_000);
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "l1", currency: "EUR", fxRateMicros: 924_600 }]);
    await run([r.request.id]);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).fxRateMicros).toBe(924_600);
  });

  it("a pair the caller did not read is reference_missing, not 'pending': Accounting not asked is not Accounting has none", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    // `reference` was read for 2026-03 only: a USD line is not accounted for
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "usd", currency: "USD" }]);
    const res = await run([r.request.id]);
    expect(res).toEqual({ ok: false, reason: "reference_missing" });
    expect(await db.receiptCounter.count()).toBe(0);
    expect(await db.refundAuditEntry.count()).toBe(0);
  });

  it("the rate check stays inside the guard: a copy and the number in one UPDATE, locked afterwards on a paid request", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    reference = await readReference([{ currency: "EUR", month: "2026-03" }]);
    const r = await makeRequest("owner-1", [{ date: "2026-03-15", id: "l1", currency: "EUR" }], { status: "paid" });
    const res = await run([r.request.id], undefined, { cause: "release" });
    expect(res.ok).toBe(true);
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_line" SET "fxRateMicros" = 1 WHERE id = 'l1'`))).rejects.toThrow();
  });
});

describe("release cause", () => {
  it("(AC-7.2 of 20261118) numbers a line it cannot classify (no usable account) and reports what is missing; a line with no VAT code is complete", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", type: "postal" }, { date: "2026-03-03", id: "l2", type: "stationery" }], { status: "approved" });
    const res = await db.$transaction((tx) =>
      classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "release", actor: { userId: "system:accounting-release", email: "system-accounting-release@welld.ch" }, reference }),
    );
    expect(res.ok && res.lines[0]).toMatchObject({ lineId: "l1", receiptNumber: "MC26/001", missing: [] });
    expect(res.ok && res.lines[1]).toMatchObject({ lineId: "l2", receiptNumber: "MC26/002", missing: ["account"] });
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: true, vatCodeCopy: null, vatRateBasisPoints: null, vatCodeIsDefault: null });
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "l2" } })).toMatchObject({ accountNumber: null, accountName: null, ledgerAccountIsDefault: null, vatCodeCopy: null });
    const audit = await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } });
    expect(audit.actorUserId).toBe("system:accounting-release");
    expect((audit.detail as any).cause).toBe("release");
    expect((audit.detail as any).vatCode).toEqual({ from: null, to: null, fromDefault: false, toDefault: false });
  });

  it("(IS-1) classifies and numbers a legacy line of a PAID request: one statement, so the database guard allows it", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }], { status: "paid" });
    const res = await db.$transaction((tx) =>
      classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "release", actor, reference }),
    );
    expect(res.ok).toBe(true);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).toMatchObject({
      receiptNumber: "MC26/001", accountNumber: "5901", vatCodeCopy: null,
    });
    // and from now on it is locked
    // T16 (specs/20261119-accounting): guard v2 watches the COPY columns, no longer the old FK columns.
    await expect(
      Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_line" SET "vatCode" = 'X', "vatRateBasisPoints" = 1 WHERE id = 'l1'`)),
    ).rejects.toThrow(/locked/);
  });
});

describe("(AC-4.7) a number issued stays", () => {
  it("a second call over the same request issues nothing and changes nothing", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    await run([r.request.id]);
    const before = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    await run([r.request.id]);
    const after = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(after.receiptNumber).toBe(before.receiptNumber);
    expect(after.numberedAt).toEqual(before.numberedAt);
    expect(await db.refundAuditEntry.count({ where: { action: "receipt_number_assigned" } })).toBe(1);
  });
});
