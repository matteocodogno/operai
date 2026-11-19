/**
 * The 2026 numbering baseline, read when a counter is created (T63, specs/20261119-accounting; 20261118: AC-4.3, AC-4.11, AC-4.12,
 * AC-4.13, AC-7.1; SO-13). Real Postgres; `classifyAndNumber` is driven inside `db.$transaction` as the approve transaction and the
 * release backfill call it (cause `approval`, the owner's email as the request holds it).
 *
 *   AC-4.11  baseline 81: the first 2026 line is `MC26/082`, then 083, whether numbered by an approval or by the release; an employee
 *            with a baseline and no request when it was loaded gets N + 1 at their first line; the latest baseline row counts
 *   AC-4.12  no baseline: 001; 2025 and every year but 2026 ignore it (the table itself refuses another year)
 *   AC-4.13  2027 restarts at 001 whatever the 2026 sequence reached
 *   key      the email, lower-cased and trimmed; another employee's baseline never applies
 *   N-01     an email changed before the first numbering: the baseline of any email the user id has used still applies (the maximum)
 *   one-shot a counter that exists is never moved by a baseline added later; a baseline never changes a number issued
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { createFakeAccounting } from "../test-support/fakeAccounting";
import { BASELINE_SET_BY, BASELINE_YEAR, baselineKey, classifyAndNumber, type AccountingReads } from "./numbering.repo";
import { referenceSnapshot } from "./referenceSnapshot";

const by = { createdByUserId: "system:accounting-release", createdByEmail: "system-accounting-release@welld.ch" };
const actor = { userId: "acc-1", email: "acc@welld.ch" };
const fake = createFakeAccounting();
let reference: AccountingReads;

beforeEach(async () => {
  await truncateRefundTables();
  for (const a of ["5901", "6101"]) fake.removeAccount(a);
  fake.setAccount("5901", "Treno").setAccount("6101", "Ufficio");
  await db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Treno", ...by } });
  const op = fake.begin("approve");
  reference = { snapshot: referenceSnapshot(await op.referenceData()), rates: new Map() };
});
afterAll(async () => {
  await truncateRefundTables();
});

/** A baseline row as the release writes it: the email key is lower-case. */
const baseline = (emailKey: string, lastIssuedSeq: number, year = 2026) =>
  db.receiptNumberBaseline.create({ data: { emailKey, year, lastIssuedSeq, ...by } });

async function makeRequest(owner: string, email: string, dates: string[]) {
  const request = await db.refundRequest.create({ data: { ownerUserId: owner, ownerEmail: email, ownerName: "Matteo Codogno", status: "submitted" } });
  const ids: string[] = [];
  for (const [i, date] of dates.entries()) {
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(date),
        type: "travel_train",
        motivo: "m",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 1000,
        approvedTotalCents: 1000,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}

const number = (owner: string, email: string, requestIds: string[]) =>
  db.$transaction((tx) =>
    classifyAndNumber(tx, { owner: { userId: owner, name: "Matteo Codogno", email }, requestIds, cause: "approval", actor, reference }),
  );
const numbers = async (ids: string[]) =>
  (await db.refundLine.findMany({ where: { id: { in: ids } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] })).map((l) => l.receiptNumber);
const counter = (owner: string, year: number) => db.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId: owner, year } } });

describe("the baseline starts a 2026 counter (AC-4.11)", () => {
  it("baseline 81: the first 2026 line is 082, the next 083, and the counter records where it started and who set it", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    const r = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02", "2026-03-03"]);
    const result = await number("u1", "matteo.codogno@welld.ch", [r.id]);
    expect(result.ok && result.lines.map((l) => [l.receiptNumber, l.year, l.seq])).toEqual([
      ["MC26/082", 2026, 82],
      ["MC26/083", 2026, 83],
    ]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 83, startAfter: 81, startAfterSetBy: BASELINE_SET_BY });
    expect(BASELINE_SET_BY).toBe("baseline");
    expect(BASELINE_YEAR).toBe(2026);
  });

  it("the next approval continues by one with no gap and no repeat, and never reads the baseline again", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    const r1 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02"]);
    const r2 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-09"]);
    await number("u1", "matteo.codogno@welld.ch", [r1.id]);
    await number("u1", "matteo.codogno@welld.ch", [r2.id]);
    expect(await numbers([...r1.lineIds, ...r2.lineIds])).toEqual(["MC26/082", "MC26/083"]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 83, startAfter: 81 });
  });

  it("an employee who had no request when the baseline was loaded gets N + 1 at their first approval, however much later", async () => {
    await baseline("late.joiner@welld.ch", 12); // loaded by the release; nobody of that email has a request yet
    expect(await db.refundRequest.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    const r = await makeRequest("u-late", "late.joiner@welld.ch", ["2026-09-14"]);
    await number("u-late", "late.joiner@welld.ch", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/013"]);
    expect(await counter("u-late", 2026)).toMatchObject({ lastSeq: 13, startAfter: 12, startAfterSetBy: "baseline" });
  });

  it("the latest baseline row counts (the table is append-only: a correction is a new row)", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    await new Promise((resolve) => setTimeout(resolve, 5)); // a later createdAt
    await baseline("matteo.codogno@welld.ch", 84);
    const r = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02"]);
    await number("u1", "matteo.codogno@welld.ch", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/085"]);
  });

  it("the key is the email, lower-cased and trimmed; another employee's baseline never applies", async () => {
    expect(baselineKey("  Matteo.Codogno@WellD.ch ")).toBe("matteo.codogno@welld.ch");
    await baseline("matteo.codogno@welld.ch", 81);
    await baseline("someone.else@welld.ch", 40);
    const r = await makeRequest("u1", " Matteo.Codogno@WELLD.ch ", ["2026-03-02"]);
    await number("u1", " Matteo.Codogno@WELLD.ch ", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/082"]);

    const other = await makeRequest("u2", "nobody@welld.ch", ["2026-03-02"]);
    await number("u2", "nobody@welld.ch", [other.id]);
    expect(await numbers(other.lineIds)).toEqual(["MC26/001"]);
    expect(await counter("u2", 2026)).toMatchObject({ startAfter: 0, startAfterSetBy: null });
  });

  it("the baseline is by employee, not by request or user id: a new user id with the same email also starts after it (the release refuses two ids behind one email)", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    const r = await makeRequest("u-other-id", "matteo.codogno@welld.ch", ["2026-03-02"]);
    await number("u-other-id", "matteo.codogno@welld.ch", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/082"]);
  });
});

describe("an email that changed before the first numbering still continues from the baseline (N-01, AC-4.11)", () => {
  it("the baseline was loaded under the old email, the user id now holds a new one: the first 2026 line is 082, never 001", async () => {
    await baseline("old.name@welld.ch", 81);
    // The employee filed under the old address, then the address changed; nothing was numbered yet, so no counter exists.
    await makeRequest("u1", "old.name@welld.ch", ["2026-02-02"]);
    const later = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02", "2026-03-03"]);
    expect(await db.receiptCounter.count()).toBe(0);
    const result = await number("u1", "new.name@welld.ch", [later.id]);
    expect(result.ok && result.lines.map((l) => l.receiptNumber)).toEqual(["MC26/082", "MC26/083"]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 83, startAfter: 81, startAfterSetBy: BASELINE_SET_BY });
  });

  it("the old email is found whatever its case or spaces in the stored requests", async () => {
    await baseline("old.name@welld.ch", 81);
    await makeRequest("u1", "  Old.Name@WELLD.ch ", ["2026-02-02"]);
    const later = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02"]);
    await number("u1", "new.name@welld.ch", [later.id]);
    expect(await numbers(later.lineIds)).toEqual(["MC26/082"]);
  });

  it("with baselines under both emails the higher one wins: a number is never issued twice (a gap is the lesser evil)", async () => {
    await baseline("old.name@welld.ch", 81);
    await baseline("new.name@welld.ch", 85);
    await makeRequest("u1", "old.name@welld.ch", ["2026-02-02"]);
    const later = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02"]);
    await number("u1", "new.name@welld.ch", [later.id]);
    expect(await numbers(later.lineIds)).toEqual(["MC26/086"]);
  });

  it("per email the latest row counts, then the maximum across the emails of that user id", async () => {
    await baseline("old.name@welld.ch", 90);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await baseline("old.name@welld.ch", 81); // a correction downwards: the latest row of that email is 81
    await baseline("new.name@welld.ch", 70);
    await makeRequest("u1", "old.name@welld.ch", ["2026-02-02"]);
    const later = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02"]);
    await number("u1", "new.name@welld.ch", [later.id]);
    expect(await numbers(later.lineIds)).toEqual(["MC26/082"]);
  });

  it("another user id's old email never applies: only the emails this user id has used", async () => {
    await baseline("old.name@welld.ch", 81);
    await makeRequest("u-other", "old.name@welld.ch", ["2026-02-02"]); // someone else filed under that address
    const mine = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02"]);
    await number("u1", "new.name@welld.ch", [mine.id]);
    expect(await numbers(mine.lineIds)).toEqual(["MC26/001"]);
  });

  it("the earlier email is only a lookup: a counter that exists is never moved by it, and 2027 ignores it", async () => {
    const first = await makeRequest("u1", "new.name@welld.ch", ["2026-03-02"]);
    await number("u1", "new.name@welld.ch", [first.id]);
    await baseline("old.name@welld.ch", 81);
    await makeRequest("u1", "old.name@welld.ch", ["2026-02-02"]);
    const second = await makeRequest("u1", "new.name@welld.ch", ["2026-03-09", "2027-01-04"]);
    await number("u1", "new.name@welld.ch", [second.id]);
    expect(await numbers([...first.lineIds, ...second.lineIds])).toEqual(["MC26/001", "MC26/002", "MC27/001"]);
  });
});

describe("no baseline, and the years it does not touch (AC-4.12, AC-4.13)", () => {
  it("no baseline recorded: the first 2026 line is 001 and the counter is the plain one", async () => {
    const r = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02"]);
    await number("u1", "matteo.codogno@welld.ch", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/001"]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 1, startAfter: 0, startAfterSetBy: null });
  });

  it("2025 and 2027 lines of the same employee ignore the 2026 baseline: 001 each, in one call as in two", async () => {
    await baseline("matteo.codogno@welld.ch", 141);
    const r = await makeRequest("u1", "matteo.codogno@welld.ch", ["2025-12-30", "2026-03-02", "2026-03-03", "2027-01-05", "2027-01-06"]);
    await number("u1", "matteo.codogno@welld.ch", [r.id]);
    expect(await numbers(r.lineIds)).toEqual(["MC25/001", "MC26/142", "MC26/143", "MC27/001", "MC27/002"]);
    for (const year of [2025, 2027]) expect(await counter("u1", year)).toMatchObject({ startAfter: 0, startAfterSetBy: null });
    expect(await counter("u1", 2026)).toMatchObject({ startAfter: 141, startAfterSetBy: "baseline", lastSeq: 143 });
  });

  it("(AC-4.13) the first 2027 line after a 2026 sequence of 142 is 001, whatever the baseline and the 2026 sequence reached", async () => {
    await baseline("matteo.codogno@welld.ch", 141);
    const r26 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-12-30"]);
    await number("u1", "matteo.codogno@welld.ch", [r26.id]);
    expect(await numbers(r26.lineIds)).toEqual(["MC26/142"]);
    const r27 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2027-01-04"]);
    await number("u1", "matteo.codogno@welld.ch", [r27.id]);
    expect(await numbers(r27.lineIds)).toEqual(["MC27/001"]);
  });

  it("the table refuses a baseline for another year, so no other year can ever be continued from it", async () => {
    for (const year of [2025, 2027]) {
      await expect(Promise.resolve(baseline("matteo.codogno@welld.ch", 5, year))).rejects.toThrow(/receipt_number_baseline_year_2026/);
    }
    expect(await db.receiptNumberBaseline.count()).toBe(0);
  });
});

describe("a counter that exists is never moved (the one-shot rule)", () => {
  it("a baseline added after the counter was created changes nothing for this employee", async () => {
    const r1 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02"]);
    await number("u1", "matteo.codogno@welld.ch", [r1.id]);
    await baseline("matteo.codogno@welld.ch", 81);
    const r2 = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-09"]);
    await number("u1", "matteo.codogno@welld.ch", [r2.id]);
    expect(await numbers([...r1.lineIds, ...r2.lineIds])).toEqual(["MC26/001", "MC26/002"]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 2, startAfter: 0, startAfterSetBy: null });
  });

  it("a refused numbering (a line with no default account) consumes no number and creates no counter, so the baseline is untouched too", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    const request = await db.refundRequest.create({ data: { ownerUserId: "u1", ownerEmail: "matteo.codogno@welld.ch", ownerName: "Matteo Codogno", status: "submitted" } });
    const line = await db.refundLine.create({
      data: { requestId: request.id, date: new Date("2026-03-02"), type: "stationery", motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 1000, approvedTotalCents: 1000 },
    });
    const refused = await number("u1", "matteo.codogno@welld.ch", [request.id]);
    expect(refused.ok).toBe(false);
    expect(await counter("u1", 2026)).toBeNull();
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: line.id } })).receiptNumber).toBeNull();
    // The retry once the line can be numbered starts after the baseline, exactly as if the refusal had not happened.
    await db.refundLine.update({ where: { id: line.id }, data: { type: "travel_train" } });
    await number("u1", "matteo.codogno@welld.ch", [request.id]);
    expect(await numbers([line.id])).toEqual(["MC26/082"]);
  });

  it("two approvals of the same new employee at once get 082 and 083, never the same number twice", async () => {
    await baseline("matteo.codogno@welld.ch", 81);
    const rs = await Promise.all([1, 2, 3, 4].map((n) => makeRequest("u1", "matteo.codogno@welld.ch", [`2026-03-0${n}`])));
    const results = await Promise.all(rs.map((r) => number("u1", "matteo.codogno@welld.ch", [r.id])));
    expect(results.every((result) => result.ok)).toBe(true);
    const all = await numbers(rs.flatMap((r) => r.lineIds));
    expect([...all].sort()).toEqual(["MC26/082", "MC26/083", "MC26/084", "MC26/085"]);
    expect(await counter("u1", 2026)).toMatchObject({ lastSeq: 85, startAfter: 81 });
  });

  it("a number issued is immutable: the baseline, read or not, never rewrites a line that has one", async () => {
    const r = await makeRequest("u1", "matteo.codogno@welld.ch", ["2026-03-02"]);
    await number("u1", "matteo.codogno@welld.ch", [r.id]);
    await baseline("matteo.codogno@welld.ch", 81);
    const again = await number("u1", "matteo.codogno@welld.ch", [r.id]);
    expect(again.ok && again.lines).toEqual([]);
    expect(await numbers(r.lineIds)).toEqual(["MC26/001"]);
  });
});
