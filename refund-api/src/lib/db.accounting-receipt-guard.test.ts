/**
 * `refund_line_accounting_guard`, `receipt_counter` and the receipt unique index
 * (T1, specs/20261118-refund-accounting-export; AC-3.7, AC-4.3, AC-4.7,
 * AC-4.10 backstop; ADR 20261118-receipt-numbers-... and
 * 20261118-accounting-classification-...).
 *
 * Real Postgres, raw SQL, no application code: the triggers are the subject.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

async function fixture(opts: { status?: "approved" | "paid"; numbered?: boolean; owner?: string } = {}) {
  const owner = opts.owner ?? "owner-1";
  const account = await db.ledgerAccount.create({
    data: { entity: "welld_ch", number: `59${Math.floor(Math.random() * 90 + 10)}`, name: "Account", ...actor },
  });
  const otherAccount = await db.ledgerAccount.create({
    data: { entity: "welld_ch", number: `61${Math.floor(Math.random() * 90 + 10)}`, name: "Other", ...actor },
  });
  const vat = await db.vatCode.create({
    data: { entity: "welld_ch", code: `V${Math.floor(Math.random() * 1e6)}`, label: "VAT", rateBasisPoints: 810, ...actor },
  });
  const otherVat = await db.vatCode.create({
    data: { entity: "welld_ch", code: `W${Math.floor(Math.random() * 1e6)}`, label: "VAT 0", rateBasisPoints: 0, ...actor },
  });
  const request = await db.refundRequest.create({
    data: { ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, status: opts.status ?? "approved" },
  });
  const line = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date("2026-03-02"),
      type: "travel_train",
      motivo: "Train",
      entity: "welld_ch",
      currency: "CHF",
      requestedAmountCents: 1000,
      approvedTotalCents: 1000,
      ledgerAccountId: account.id,
      ledgerAccountIsDefault: true,
      vatCodeId: vat.id,
      vatCodeIsDefault: true,
      ...(opts.numbered === false
        ? {}
        : {
            receiptNumber: "MC26/001",
            receiptOwnerUserId: owner,
            receiptYear: 2026,
            receiptSeq: 1,
            numberedAt: new Date(),
          }),
    },
  });
  return { owner, account, otherAccount, vat, otherVat, request, line };
}

describe("refund_line_accounting_guard: a receipt number is immutable (AC-4.7)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  for (const [column, value] of [
    ["receiptNumber", "MC26/002"],
    ["receiptOwnerUserId", "someone-else"],
    ["receiptYear", 2027],
    ["receiptSeq", 2],
  ] as const) {
    it(`a numbered line's ${column} cannot change`, async () => {
      const { line } = await fixture();
      await expect(
        asPromise(db.$executeRawUnsafe(`UPDATE "refund_line" SET "${column}" = $1 WHERE id = $2`, value, line.id)),
      ).rejects.toThrow(/immutable/);
      const reread = await db.refundLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(reread.receiptNumber).toBe("MC26/001");
      expect(reread.receiptSeq).toBe(1);
    });
  }

  it("a numbered line's receipt number cannot be cleared, nor changed through the Prisma client", async () => {
    const { line } = await fixture();
    await expect(
      asPromise(
        db.$executeRawUnsafe(
          `UPDATE "refund_line" SET "receiptNumber" = NULL, "receiptOwnerUserId" = NULL, "receiptYear" = NULL, "receiptSeq" = NULL, "numberedAt" = NULL WHERE id = $1`,
          line.id,
        ),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      asPromise(db.refundLine.update({ where: { id: line.id }, data: { receiptNumber: "XX26/001" } })),
    ).rejects.toThrow();
  });

  it("a numbered line cannot be deleted, by SQL, by the client, or by the cascade of its request", async () => {
    const { line, request } = await fixture();
    await expect(asPromise(db.$executeRawUnsafe(`DELETE FROM "refund_line" WHERE id = $1`, line.id))).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(asPromise(db.refundLine.delete({ where: { id: line.id } }))).rejects.toThrow();
    await expect(asPromise(db.refundRequest.delete({ where: { id: request.id } }))).rejects.toThrow();
    expect(await db.refundLine.count({ where: { id: line.id } })).toBe(1);
  });

  it("an unnumbered line can still be updated and deleted, and other columns of a numbered line can change", async () => {
    const plain = await fixture({ numbered: false });
    await expect(
      asPromise(db.refundLine.update({ where: { id: plain.line.id }, data: { approvedTotalCents: 5 } })),
    ).resolves.toBeTruthy();
    await expect(asPromise(db.refundLine.delete({ where: { id: plain.line.id } }))).resolves.toBeTruthy();

    const numbered = await fixture({ owner: "owner-2" });
    await expect(
      asPromise(db.refundLine.update({ where: { id: numbered.line.id }, data: { approvedTotalCents: 7 } })),
    ).resolves.toBeTruthy();
  });

  it("(control) the first numbering of a line (all five columns together) succeeds", async () => {
    const { line } = await fixture({ numbered: false });
    await expect(
      asPromise(
        db.refundLine.update({
          where: { id: line.id },
          data: {
            receiptNumber: "MC26/001",
            receiptOwnerUserId: "owner-1",
            receiptYear: 2026,
            receiptSeq: 1,
            numberedAt: new Date(),
          },
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it("the five receipt columns are set together or not at all (CHECK)", async () => {
    const { line } = await fixture({ numbered: false });
    await expect(
      asPromise(db.refundLine.update({ where: { id: line.id }, data: { receiptNumber: "MC26/001" } })),
    ).rejects.toThrow();
    await expect(
      asPromise(db.refundLine.update({ where: { id: line.id }, data: { receiptSeq: 1 } })),
    ).rejects.toThrow();
  });

  it("the unique index refuses a second line with the same (owner, year, seq) (AC-4.3, AC-4.10 backstop)", async () => {
    const first = await fixture();
    const dup = db.refundLine.create({
      data: {
        requestId: first.request.id,
        date: new Date("2026-03-03"),
        type: "travel_train",
        motivo: "Train 2",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 500,
        receiptNumber: "MC26/001",
        receiptOwnerUserId: first.owner,
        receiptYear: 2026,
        receiptSeq: 1,
        numberedAt: new Date(),
      },
    });
    await expect(asPromise(dup)).rejects.toThrow();

    // Another owner, another year, or another seq is fine.
    const mk = (overrides: Record<string, unknown>) =>
      db.refundLine.create({
        data: {
          requestId: first.request.id,
          date: new Date("2026-03-03"),
          type: "travel_train",
          motivo: "Train 3",
          entity: "welld_ch",
          currency: "CHF",
          requestedAmountCents: 500,
          receiptNumber: "MC26/009",
          receiptOwnerUserId: first.owner,
          receiptYear: 2026,
          receiptSeq: 9,
          numberedAt: new Date(),
          ...overrides,
        },
      });
    await expect(asPromise(mk({ receiptOwnerUserId: "owner-9" }))).resolves.toBeTruthy();
    await expect(asPromise(mk({ receiptYear: 2025 }))).resolves.toBeTruthy();
    await expect(asPromise(mk({ receiptSeq: 2 }))).resolves.toBeTruthy();
  });

  it("unnumbered lines never collide with each other on the unique index (NULLs are distinct)", async () => {
    const a = await fixture({ numbered: false });
    for (let i = 0; i < 3; i++) {
      await db.refundLine.create({
        data: {
          requestId: a.request.id,
          date: new Date("2026-03-03"),
          type: "postal",
          motivo: `p${i}`,
          entity: "welld_it",
          currency: "EUR",
          requestedAmountCents: 100,
        },
      });
    }
    expect(await db.refundLine.count()).toBe(4);
  });
});

describe("refund_line_accounting_guard: classification locked when paid (AC-3.7)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  it("a paid request's numbered line: account, VAT code and both default flags cannot change", async () => {
    const f = await fixture({ status: "paid" });
    const attempts: [string, unknown][] = [
      ["vatCodeId", f.otherVat.id],
      ["ledgerAccountId", f.otherAccount.id],
      ["vatCodeIsDefault", false],
      ["ledgerAccountIsDefault", false],
      ["vatCodeId", null],
    ];
    for (const [column, value] of attempts) {
      await expect(
        asPromise(db.$executeRawUnsafe(`UPDATE "refund_line" SET "${column}" = $1 WHERE id = $2`, value, f.line.id)),
      ).rejects.toThrow(/locked/);
    }
    const reread = await db.refundLine.findUniqueOrThrow({ where: { id: f.line.id } });
    expect(reread.vatCodeId).toBe(f.vat.id);
    expect(reread.ledgerAccountId).toBe(f.account.id);
    expect(reread.vatCodeIsDefault).toBe(true);
  });

  it("the same change on an approved request's line is accepted (post-approval reclassification, AC-3.6)", async () => {
    const f = await fixture({ status: "approved" });
    await expect(
      asPromise(
        db.refundLine.update({
          where: { id: f.line.id },
          data: { vatCodeId: f.otherVat.id, vatCodeIsDefault: false },
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it("marking the request paid is what locks it: change, pay, change again", async () => {
    const f = await fixture({ status: "approved" });
    await db.refundLine.update({ where: { id: f.line.id }, data: { ledgerAccountId: f.otherAccount.id, ledgerAccountIsDefault: false } });
    await db.refundRequest.update({ where: { id: f.request.id }, data: { status: "paid" } });
    await expect(
      asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { ledgerAccountId: f.account.id } })),
    ).rejects.toThrow(/locked/);
  });

  it("other columns of a paid request's line are not the guard's business", async () => {
    const f = await fixture({ status: "paid" });
    await expect(
      asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { motivo: "edited" } })),
    ).resolves.toBeTruthy();
  });

  it("a legacy line of a paid request that has no receipt number yet can still be classified (the release backfill, AC-7.1)", async () => {
    const f = await fixture({ status: "paid", numbered: false });
    await db.refundLine.update({
      where: { id: f.line.id },
      data: { ledgerAccountId: f.otherAccount.id, vatCodeId: f.otherVat.id },
    });
    // ...and numbered in the same or a later statement, after which it is locked.
    await db.refundLine.update({
      where: { id: f.line.id },
      data: { receiptNumber: "MC26/001", receiptOwnerUserId: "owner-1", receiptYear: 2026, receiptSeq: 1, numberedAt: new Date() },
    });
    await expect(
      asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { vatCodeId: f.vat.id } })),
    ).rejects.toThrow(/locked/);
  });
});

describe("receipt_counter trigger (AC-4.3)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  const makeCounter = (overrides: Record<string, unknown> = {}) =>
    db.receiptCounter.create({
      data: { ownerUserId: "owner-1", year: 2026, lastSeq: 5, ...overrides },
    });

  it("lastSeq can grow but cannot decrease", async () => {
    await makeCounter();
    await expect(
      asPromise(db.receiptCounter.update({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } }, data: { lastSeq: 6 } })),
    ).resolves.toBeTruthy();
    await expect(
      asPromise(
        db.$executeRawUnsafe(`UPDATE "receipt_counter" SET "lastSeq" = 5 WHERE "ownerUserId" = 'owner-1' AND "year" = 2026`),
      ),
    ).rejects.toThrow(/cannot decrease/);
    const row = await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } });
    expect(row.lastSeq).toBe(6);
  });

  it("startAfter and startAfterSetBy are frozen after insert", async () => {
    await makeCounter({ startAfter: 80, startAfterSetBy: "system:accounting-release", lastSeq: 80 });
    await expect(
      asPromise(
        db.$executeRawUnsafe(`UPDATE "receipt_counter" SET "startAfter" = 0 WHERE "ownerUserId" = 'owner-1' AND "year" = 2026`),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      asPromise(
        db.$executeRawUnsafe(`UPDATE "receipt_counter" SET "startAfterSetBy" = NULL WHERE "ownerUserId" = 'owner-1' AND "year" = 2026`),
      ),
    ).rejects.toThrow(/immutable/);
    const row = await db.receiptCounter.findUniqueOrThrow({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } });
    expect(row.startAfter).toBe(80);
    expect(row.startAfterSetBy).toBe("system:accounting-release");
  });

  it("the key is frozen and the row cannot be deleted", async () => {
    await makeCounter();
    await expect(
      asPromise(db.$executeRawUnsafe(`UPDATE "receipt_counter" SET "year" = 2027 WHERE "ownerUserId" = 'owner-1'`)),
    ).rejects.toThrow(/immutable/);
    await expect(
      asPromise(db.$executeRawUnsafe(`DELETE FROM "receipt_counter" WHERE "ownerUserId" = 'owner-1'`)),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      asPromise(db.receiptCounter.delete({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } } })),
    ).rejects.toThrow();
    expect(await db.receiptCounter.count()).toBe(1);
  });

  it("a no-op update (same lastSeq, e.g. updatedAt only) is allowed", async () => {
    await makeCounter();
    await expect(
      asPromise(db.receiptCounter.update({ where: { ownerUserId_year: { ownerUserId: "owner-1", year: 2026 } }, data: { lastSeq: 5 } })),
    ).resolves.toBeTruthy();
  });
});
