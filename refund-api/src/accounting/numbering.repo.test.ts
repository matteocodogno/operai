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
import { classifyAndNumber, type ClassifyAndNumberInput, type DefaultsSnapshot } from "./numbering.repo";

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const actor = { userId: "acc-1", email: "acc@welld.ch" };

let account: { id: string; number: string; name: string; active: boolean };
let otherAccount: { id: string; number: string; name: string; active: boolean };
let vat: { id: string; code: string; label: string; rateBasisPoints: number; active: boolean };
let zeroVat: typeof vat;
let snapshot: DefaultsSnapshot;

beforeEach(async () => {
  await truncateRefundTables();
  const a = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "Treno", ...by } });
  const b = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Ufficio", ...by } });
  const v = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  const z = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
  account = { id: a.id, number: a.number, name: a.name, active: true };
  otherAccount = { id: b.id, number: b.number, name: b.name, active: true };
  vat = { id: v.id, code: v.code, label: v.label, rateBasisPoints: 810, active: true };
  zeroVat = { id: z.id, code: z.code, label: z.label, rateBasisPoints: 0, active: true };
  snapshot = {
    defaults: {
      travel_train: { account, vatCode: vat },
      office_material: { account: otherAccount, vatCode: vat },
      postal: { account: otherAccount, vatCode: null },
    },
    foreignCurrencyVatCode: zeroVat,
  };
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
  ledgerAccountId?: string;
  ledgerAccountIsDefault?: boolean;
  numbered?: boolean;
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
        ...(spec.ledgerAccountId ? { ledgerAccountId: spec.ledgerAccountId, ledgerAccountIsDefault: spec.ledgerAccountIsDefault ?? false } : {}),
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
    classifyAndNumber(tx, { owner, requestIds, cause: "approval", actor, snapshot, ...extra }),
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
        const res = await classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "approval", actor, snapshot });
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

describe("classification freeze", () => {
  it("(AC-3.5) freezes the live defaults with *IsDefault true and audits cause approval, from null to the value", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", type: "travel_train" }]);
    const res = await run([r.request.id]);
    expect(res.ok && res.lines[0]!.missing).toEqual([]);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({
      ledgerAccountId: account.id, ledgerAccountIsDefault: true, vatCodeId: vat.id, vatCodeIsDefault: true,
    });
    const audit = await db.refundAuditEntry.findMany({ where: { lineId: "l1" }, orderBy: { createdAt: "asc" } });
    const classified = audit.find((a) => a.action === "line_classified")!;
    expect(classified).toMatchObject({ actorUserId: "acc-1", actorEmail: "acc@welld.ch", requestId: r.request.id });
    expect(classified.detail).toEqual({
      cause: "approval",
      account: { from: null, to: { id: account.id, number: "5901" }, fromDefault: true, toDefault: true },
      vatCode: { from: null, to: { id: vat.id, code: "IMP81", rateBasisPoints: 810 }, fromDefault: true, toDefault: true },
    });
    const assigned = audit.find((a) => a.action === "receipt_number_assigned")!;
    expect(assigned.detail).toEqual({ cause: "approval", receiptNumber: "MC26/001", year: 2026, seq: 1 });
  });

  it("(AC-3.2) a foreign-currency line gets the designated VAT code, not the type's own", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", currency: "EUR" }]);
    await run([r.request.id]);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line.vatCodeId).toBe(zeroVat.id);
    expect(line.ledgerAccountId).toBe(account.id);
  });

  it("keeps an accounting override and its flag, and audits it from the override", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", ledgerAccountId: otherAccount.id, ledgerAccountIsDefault: false }]);
    await run([r.request.id]);
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({ ledgerAccountId: otherAccount.id, ledgerAccountIsDefault: false, vatCodeIsDefault: true });
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } })).detail as any;
    expect(detail.account).toMatchObject({ from: { id: otherAccount.id }, to: { id: otherAccount.id }, fromDefault: false, toDefault: false });
  });

  it("(AC-3.4) a missing half refuses the approval, naming line, date and type, and writes nothing", async () => {
    const r = await makeRequest("owner-1", [
      { date: "2026-03-05", id: "ok", type: "travel_train" },
      { date: "2026-03-02", id: "bad", type: "postal" }, // postal has an account but no VAT code
      { date: "2026-03-03", id: "worse", type: "stationery" }, // no default at all
    ]);
    const res = await run([r.request.id]);
    expect(res).toEqual({
      ok: false,
      reason: "classification_missing",
      missing: [
        { lineId: "bad", requestId: r.request.id, date: "2026-03-02", type: "postal", missing: ["vatCode"] },
        { lineId: "worse", requestId: r.request.id, date: "2026-03-03", type: "stationery", missing: ["account", "vatCode"] },
      ],
    });
    expect(await db.receiptCounter.count()).toBe(0);
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.refundLine.count({ where: { receiptNumber: { not: null } } })).toBe(0);
    expect(await db.refundLine.count({ where: { ledgerAccountId: { not: null } } })).toBe(0);
  });

  it("(G3) a default pointing at an inactive account counts as missing", async () => {
    snapshot = { ...snapshot, defaults: { travel_train: { account: { ...account, active: false }, vatCode: vat } } };
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }]);
    const res = await run([r.request.id]);
    expect(res.ok === false && res.missing[0]!.missing).toEqual(["account"]);
  });

  it("(AC-2.7) a foreign-currency line with no usable designation is refused while a CHF line of the same type is not", async () => {
    snapshot = { ...snapshot, foreignCurrencyVatCode: null };
    const chf = await makeRequest("owner-1", [{ date: "2026-03-02", id: "chf" }]);
    const eur = await makeRequest("owner-2", [{ date: "2026-03-02", id: "eur", currency: "EUR" }]);
    expect((await run([chf.request.id])).ok).toBe(true);
    const res = await run([eur.request.id], { userId: "owner-2", name: "A B", email: "a.b@x.ch" });
    expect(res.ok === false && res.missing[0]!.missing).toEqual(["vatCode"]);
  });
});

describe("release cause", () => {
  it("(AC-7.2) numbers a line it cannot fully classify, freezes the half that resolved, and reports what is missing", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1", type: "postal" }], { status: "approved" });
    const res = await db.$transaction((tx) =>
      classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "release", actor: { userId: "system:accounting-release", email: "system-accounting-release@welld.ch" }, snapshot }),
    );
    expect(res.ok && res.lines[0]).toMatchObject({ lineId: "l1", receiptNumber: "MC26/001", missing: ["vatCode"] });
    const line = await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } });
    expect(line).toMatchObject({ ledgerAccountId: otherAccount.id, ledgerAccountIsDefault: true, vatCodeId: null, vatCodeIsDefault: null });
    const audit = await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: "l1", action: "line_classified" } });
    expect(audit.actorUserId).toBe("system:accounting-release");
    expect((audit.detail as any).cause).toBe("release");
  });

  it("(IS-1) classifies and numbers a legacy line of a PAID request: one statement, so the database guard allows it", async () => {
    const r = await makeRequest("owner-1", [{ date: "2026-03-02", id: "l1" }], { status: "paid" });
    const res = await db.$transaction((tx) =>
      classifyAndNumber(tx, { owner: { userId: "owner-1", name: "Matteo Codogno", email: "m@x.ch" }, requestIds: [r.request.id], cause: "release", actor, snapshot }),
    );
    expect(res.ok).toBe(true);
    expect(await db.refundLine.findUniqueOrThrow({ where: { id: "l1" } })).toMatchObject({
      receiptNumber: "MC26/001", ledgerAccountId: account.id, vatCodeId: vat.id,
    });
    // and from now on it is locked
    await expect(
      Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_line" SET "vatCodeId" = $1 WHERE id = 'l1'`, zeroVat.id)),
    ).rejects.toThrow();
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
