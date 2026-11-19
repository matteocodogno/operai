/**
 * The pending exchange-rate copy of an export, directly against the database (T21, specs/20261119-accounting; AC-5.6, AC-5.3,
 * AC-5.7; plan § Data model "fx write-once" and § Interaction flows 7).
 *
 * `copyPendingRates` runs inside the caller's transaction: it locks the pending lines, writes the three `fx*` columns only where
 * none is held yet (first writer wins), and audits each copy it wrote with the exporter. Here it is driven by hand, with no
 * route and no Accounting: what the export decides is `export.routes.test.ts`; what the database guarantees is `db.*`.
 * Real Postgres, no network.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { truncateRefundTables } from "../test-support/dbCleanup";

process.env["NODE_ENV"] = "test";

const { db } = await import("../lib/db");
const { copyPendingRates } = await import("./rateCopy.repo");

const EXPORTER = { userId: "acct-1", email: "acct-1@welld.ch" };
let seq = 0;

async function pendingLine(options: { currency?: "EUR" | "USD" | "CHF"; date?: string; status?: "approved" | "paid" } = {}) {
  const owner = `u-${++seq}`;
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner,
      ownerEmail: `${owner}@welld.ch`,
      ownerName: "Matteo Codogno",
      status: options.status ?? "approved",
      decidedAt: new Date("2026-03-20"),
      decidedByUserId: "a",
      decidedByEmail: "a@welld.ch",
    },
  });
  const line = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date(options.date ?? "2026-03-02"),
      type: "office_material",
      motivo: "Cancelleria",
      entity: "welld_ch",
      currency: options.currency ?? "EUR",
      requestedAmountCents: 1040,
      approvedTotalCents: 1040,
      accountNumber: "6101",
      accountName: "Spese materiale ufficio",
      ledgerAccountIsDefault: true,
      vatCodeCopy: "NOVAT",
      vatRateBasisPoints: 0,
      vatCodeIsDefault: true,
      receiptNumber: `MC26/${String(seq).padStart(3, "0")}`,
      receiptOwnerUserId: owner,
      receiptYear: 2026,
      receiptSeq: seq,
      numberedAt: new Date(),
    },
  });
  return { requestId: request.id, lineId: line.id };
}

const copyOf = (line: { requestId: string; lineId: string }, rateMicros = 924_600, month = "2026-03", currency = "EUR") => ({
  lineId: line.lineId,
  requestId: line.requestId,
  currency,
  month,
  rateMicros,
});
const fxOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id }, select: { fxRateMicros: true, fxRateMonth: true, fxRateCopiedAt: true } });
const audits = () => db.refundAuditEntry.findMany({ where: { action: "line_rate_copied" }, orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  await truncateRefundTables();
});
afterAll(async () => {
  await truncateRefundTables();
});

describe("copyPendingRates (AC-5.6)", () => {
  it("copies the rate, its month and the time onto a pending line, and audits the exporter with the batch, rate, month and currency", async () => {
    const line = await pendingLine();
    const at = new Date("2026-04-02T08:30:00.000Z");
    const written = await db.$transaction((tx) => copyPendingRates(tx, [copyOf(line)], EXPORTER, "batch-1", at));
    expect(written.map((w) => w.lineId)).toEqual([line.lineId]);
    expect(await fxOf(line.lineId)).toEqual({ fxRateMicros: 924_600, fxRateMonth: new Date("2026-03-01T00:00:00.000Z"), fxRateCopiedAt: at });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: line.requestId, lineId: line.lineId, actorUserId: "acct-1", actorEmail: "acct-1@welld.ch", batchId: null });
    expect(rows[0]!.detail).toEqual({ v: 2, cause: "export", batchId: "batch-1", rateMicros: 924_600, month: "2026-03", currency: "EUR" });
  });

  it("is write-once: a line that already holds a copy is not written again and not audited again", async () => {
    const line = await pendingLine();
    await db.$transaction((tx) => copyPendingRates(tx, [copyOf(line, 924_600)], EXPORTER, "batch-1"));
    const first = await fxOf(line.lineId);
    const second = await db.$transaction((tx) => copyPendingRates(tx, [copyOf(line, 950_000)], { userId: "acct-2", email: "acct-2@welld.ch" }, "batch-1"));
    expect(second).toEqual([]);
    expect(await fxOf(line.lineId)).toEqual(first);
    expect(await audits()).toHaveLength(1);
  });

  it("copies the lines that are pending and skips the ones that are not, in one call", async () => {
    const a = await pendingLine();
    const b = await pendingLine({ date: "2026-02-10" });
    await db.$transaction((tx) => copyPendingRates(tx, [copyOf(b, 900_000, "2026-02")], EXPORTER, "batch-1"));
    const written = await db.$transaction((tx) => copyPendingRates(tx, [copyOf(a), copyOf(b, 111_111, "2026-02")], EXPORTER, "batch-1"));
    expect(written.map((w) => w.lineId)).toEqual([a.lineId]);
    expect((await fxOf(b.lineId)).fxRateMicros).toBe(900_000);
    expect(await audits()).toHaveLength(2);
  });

  it("writes nothing else: the classification, the money, the status and the decision of the line and its request are unchanged", async () => {
    const line = await pendingLine({ status: "paid" });
    const lineBefore = await db.refundLine.findUniqueOrThrow({ where: { id: line.lineId } });
    const requestBefore = await db.refundRequest.findUniqueOrThrow({ where: { id: line.requestId } });
    await db.$transaction((tx) => copyPendingRates(tx, [copyOf(line)], EXPORTER, "batch-1"));
    // `updatedAt` is the row's own bookkeeping; every other column besides the three `fx*` ones must be as it was.
    const { fxRateMicros, fxRateMonth, fxRateCopiedAt, updatedAt: _u1, ...lineAfter } = await db.refundLine.findUniqueOrThrow({ where: { id: line.lineId } });
    const { fxRateMicros: _a, fxRateMonth: _b, fxRateCopiedAt: _c, updatedAt: _u2, ...lineWas } = lineBefore;
    expect([fxRateMicros, fxRateMonth?.toISOString(), fxRateCopiedAt === null]).toEqual([924_600, "2026-03-01T00:00:00.000Z", false]);
    expect(lineAfter).toEqual(lineWas);
    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: line.requestId } })).toEqual(requestBefore);
  });

  it("a line of a PAID request, numbered, is copied too: the copy goes from null to set, which the guard allows (AC-5.3)", async () => {
    const line = await pendingLine({ status: "paid" });
    const written = await db.$transaction((tx) => copyPendingRates(tx, [copyOf(line)], EXPORTER, "batch-1"));
    expect(written).toHaveLength(1);
  });

  it("nothing to copy is no query and no audit row", async () => {
    expect(await db.$transaction((tx) => copyPendingRates(tx, [], EXPORTER, "batch-1"))).toEqual([]);
    expect(await audits()).toHaveLength(0);
  });

  it("rolls back with its transaction: a failure after the copy leaves the line pending and the audit trail empty", async () => {
    const line = await pendingLine();
    await expect(
      db.$transaction(async (tx) => {
        await copyPendingRates(tx, [copyOf(line)], EXPORTER, "batch-1");
        throw new Error("the log write failed");
      }),
    ).rejects.toThrow("the log write failed");
    expect(await fxOf(line.lineId)).toEqual({ fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null });
    expect(await audits()).toHaveLength(0);
  });

  it("two transactions copying the same lines at once: each line is copied by exactly one of them, and audited once (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const lines = [await pendingLine(), await pendingLine({ date: "2026-03-09" })];
      const before = (await audits()).length;
      const [x, y] = await Promise.all([
        db.$transaction((tx) => copyPendingRates(tx, lines.map((l) => copyOf(l, 924_600)), EXPORTER, "batch-1")),
        db.$transaction((tx) => copyPendingRates(tx, lines.map((l) => copyOf(l, 930_000)), { userId: "acct-2", email: "acct-2@welld.ch" }, "batch-1")),
      ]);
      expect(x.length + y.length).toBe(2);
      expect((await audits()).length - before).toBe(2);
      // Both rates were offered; the winner's stands for every line it copied, and the loser's never shows.
      const stored = await Promise.all(lines.map((l) => fxOf(l.lineId)));
      for (const [i, line] of lines.entries()) {
        const winner = x.some((w) => w.lineId === line.lineId) ? 924_600 : 930_000;
        expect(stored[i]!.fxRateMicros).toBe(winner);
      }
    }
  });
});

describe("what the database refuses stays refused (CHECKs of the copy)", () => {
  it("a month that is not the expense month, and a rate outside 0 < r < 1e9, are refused and nothing is written or audited", async () => {
    const line = await pendingLine();
    for (const bad of [copyOf(line, 924_600, "2026-02"), copyOf(line, 0), copyOf(line, 1_000_000_000)]) {
      await expect(db.$transaction((tx) => copyPendingRates(tx, [bad], EXPORTER, "batch-1"))).rejects.toThrow();
    }
    expect(await fxOf(line.lineId)).toEqual({ fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null });
    expect(await audits()).toHaveLength(0);
  });

  it("a CHF line cannot hold a rate", async () => {
    const line = await pendingLine({ currency: "CHF" });
    await expect(db.$transaction((tx) => copyPendingRates(tx, [copyOf(line, 1_000_000, "2026-03", "CHF")], EXPORTER, "batch-1"))).rejects.toThrow();
    expect((await fxOf(line.lineId)).fxRateMicros).toBeNull();
  });
});
