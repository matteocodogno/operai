/**
 * The release script against real Postgres (T11, specs/20261118-refund-accounting-
 * export; AC-2.5, AC-7.1, AC-7.2, AC-7.3; plan D2, D6, D13, IS-1).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { truncateRefundTables } from "../src/test-support/dbCleanup";
import { setVatCodeActive } from "../src/accounting/catalog.repo";
import { FOREIGN_CURRENCY_VAT_CODE_KEY, loadForeignCurrencyVatCodeState } from "../src/accounting/defaults.repo";
import { isAccountingReleased } from "../src/accounting/release";
import {
  DEFAULT_SEED_PATH,
  formatReport,
  parseOffsetsCsv,
  parseSeed,
  ReleaseError,
  runAccountingRelease,
} from "./accounting-release";

const admin = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };
const adminActor = { userId: "admin-1", email: "admin@welld.ch" };
const NOW = new Date("2026-11-20T08:00:00.000Z");

beforeEach(async () => {
  await truncateRefundTables({ released: false });
});
afterAll(async () => {
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

const run = (over: Parameters<typeof runAccountingRelease>[0] = {}) => runAccountingRelease({ now: () => NOW, ...over });
const line = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id }, include: { ledgerAccount: true, vatCode: true } });

async function snapshot() {
  return {
    accounts: await db.ledgerAccount.count(),
    vat: await db.vatCode.count(),
    defaults: await db.expenseTypeDefault.count(),
    settings: await db.refundSetting.count(),
    counters: JSON.stringify(await db.receiptCounter.findMany({ orderBy: { year: "asc" } })),
    numbers: JSON.stringify((await db.refundLine.findMany({ orderBy: { id: "asc" }, select: { id: true, receiptNumber: true, ledgerAccountId: true, vatCodeId: true } }))),
    audit: await db.refundAuditEntry.count(),
    status: await db.accountingCatalogStatus.count(),
  };
}

describe("the seed file", () => {
  it("is valid, and is the plan's D1 draft: 15 accounts, three VAT codes, twelve types, NOVAT designated", () => {
    const seed = parseSeed(JSON.parse(readFileSync(DEFAULT_SEED_PATH, "utf8")));
    expect(seed.ledgerAccounts).toHaveLength(15);
    expect(seed.vatCodes.map((v) => [v.code, v.ratePercent])).toEqual([["IMP81", "8.1"], ["IMP77", "7.7"], ["NOVAT", "0"]]);
    expect(Object.keys(seed.typeDefaults)).toHaveLength(12);
    expect(seed.typeDefaults.travel_km).toEqual({ ledgerAccount: "5905", vatCode: "NOVAT" });
    expect(seed.typeDefaults.representation_gifts).toEqual({ ledgerAccount: null, vatCode: "IMP81" });
    expect(seed.typeDefaults.company_manuals).toEqual({ ledgerAccount: "6101", vatCode: null });
    expect(seed.foreignCurrencyVatCode).toBe("NOVAT");
  });

  it("refuses a seed that points at an account or code it does not define", () => {
    const base = { ledgerAccounts: [{ number: "5901", name: "x" }], vatCodes: [{ code: "A", label: "l", ratePercent: "1" }], typeDefaults: {}, foreignCurrencyVatCode: null };
    expect(() => parseSeed({ ...base, typeDefaults: { postal: { ledgerAccount: "9999", vatCode: null } } })).toThrow(ReleaseError);
    expect(() => parseSeed({ ...base, typeDefaults: { postal: { ledgerAccount: null, vatCode: "B" } } })).toThrow(ReleaseError);
    expect(() => parseSeed({ ...base, foreignCurrencyVatCode: "B" })).toThrow(ReleaseError);
    expect(() => parseSeed({ ...base, typeDefaults: { not_a_type: { ledgerAccount: null, vatCode: null } } })).toThrow(ReleaseError);
    expect(() => parseSeed({ ...base, ledgerAccounts: [{ number: "5901", name: "x" }, { number: "5901", name: "y" }] })).toThrow(ReleaseError);
    expect(parseSeed(base)).toBeTruthy();
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

describe("backfill (AC-7.1)", () => {
  it("classifies CHF lines with the type defaults and EUR lines with the type account plus the foreign-currency VAT code, and numbers by expense date across requests", async () => {
    await request("u1", [{ id: "a-late", date: "2026-03-20", type: "travel_train" }, { id: "a-eur", date: "2026-03-05", type: "travel_train", currency: "EUR" }]);
    await request("u1", [{ id: "a-early", date: "2026-02-10", type: "office_material" }], { status: "paid" });
    const report = await run();

    expect(await Promise.all(["a-early", "a-eur", "a-late"].map(async (id) => (await line(id)).receiptNumber))).toEqual(["MC26/001", "MC26/002", "MC26/003"]);
    const chf = await line("a-late");
    expect(chf.ledgerAccount?.number).toBe("5901");
    expect(chf.vatCode?.code).toBe("IMP81");
    expect([chf.ledgerAccountIsDefault, chf.vatCodeIsDefault]).toEqual([true, true]);
    const eur = await line("a-eur");
    expect(eur.ledgerAccount?.number).toBe("5901");
    expect(eur.vatCode?.code).toBe("NOVAT");
    const early = await line("a-early");
    expect([early.ledgerAccount?.number, early.vatCode?.code]).toEqual(["6101", "IMP81"]);

    const audit = await db.refundAuditEntry.findMany({ where: { action: { in: ["line_classified", "receipt_number_assigned"] } } });
    expect(audit).toHaveLength(6);
    expect(audit.every((a) => a.actorUserId === "system:accounting-release" && a.actorEmail === "system-accounting-release@welld.ch")).toBe(true);
    expect(audit.every((a) => (a.detail as any).cause === "release")).toBe(true);

    expect(report.lines.map((l) => l.receiptNumber)).toEqual(["MC26/001", "MC26/002", "MC26/003"]);
    expect(report.numbered).toEqual([{ employee: "u1@welld.ch", year: 2026, count: 3, first: "MC26/001", last: "MC26/003" }]);
    expect(report.unclassified).toEqual([]);
    expect(report.markerWritten).toBe(true);
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(true);
  });

  it("(IS-1) classifies and numbers a legacy line of a PAID request, which the database then locks", async () => {
    await request("u1", [{ id: "p1", date: "2026-03-02" }], { status: "paid" });
    await run();
    const l = await line("p1");
    expect([l.receiptNumber, l.ledgerAccount?.number, l.vatCode?.code]).toEqual(["MC26/001", "5901", "IMP81"]);
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_line" SET "vatCodeId" = NULL WHERE id = 'p1'`))).rejects.toThrow();
  });

  it("numbers each employee in their own sequence, two years as two sequences, initials from the name", async () => {
    await request("u1", [{ id: "x1", date: "2025-12-30" }, { id: "x2", date: "2026-01-02" }]);
    await request("u2", [{ id: "y1", date: "2026-03-02" }], { name: "Marco Cattaneo" });
    await request("u3", [{ id: "z1", date: "2026-03-02" }], { name: null, email: "anna.rossi@welld.ch" });
    await run();
    expect(await Promise.all(["x1", "x2", "y1", "z1"].map(async (id) => (await line(id)).receiptNumber))).toEqual(["MC25/001", "MC26/001", "MC26/001", "AR26/001"]);
  });

  it("(AC-7.2) numbers but leaves unclassified a type without a default and an EUR line whose designation is inactive, and reports them", async () => {
    // an admin-made NOVAT that is deactivated: the seed does not recreate or designate it
    const novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...admin } });
    await setVatCodeActive(novat.id, false, adminActor);
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
    expect([gift.receiptNumber, gift.ledgerAccountId, gift.vatCode?.code]).toEqual(["MC26/001", null, "IMP81"]);
    const manual = await line("manual");
    expect([manual.receiptNumber, manual.ledgerAccount?.number, manual.vatCodeId]).toEqual(["MC26/002", "6101", null]);
    const eur = await line("eur");
    expect([eur.receiptNumber, eur.ledgerAccount?.number, eur.vatCodeId]).toEqual(["MC26/003", "5901", null]);
    expect((await line("ok")).vatCode?.code).toBe("IMP81");

    expect(report.unclassified.map((l) => [l.lineId, l.missing])).toEqual([
      ["gift", ["account"]],
      ["manual", ["vatCode"]],
      ["eur", ["vatCode"]],
    ]);
    expect(formatReport(report)).toContain("missing vatCode");
  });

  it("(AC-7.3) leaves WellD Italia lines without number, classification, audit row or counter, and counts them", async () => {
    await request("u1", [{ id: "it", date: "2026-03-02", entity: "welld_it", currency: "EUR" }], { status: "paid" });
    const report = await run();
    expect(report.itLinesLeftUnnumbered).toBe(1);
    const l = await line("it");
    expect([l.receiptNumber, l.ledgerAccountId, l.vatCodeId]).toEqual([null, null, null]);
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

describe("seed (AC-2.5)", () => {
  it("creates the catalog, the twelve type defaults where the register gave an answer, and designates NOVAT with the system actor", async () => {
    const report = await run();
    expect(await db.ledgerAccount.count()).toBe(15);
    expect(await db.vatCode.count()).toBe(3);
    expect((await db.vatCode.findUniqueOrThrow({ where: { entity_code: { entity: "welld_ch", code: "IMP81" } } })).rateBasisPoints).toBe(810);
    expect(report.seeded.typeDefaults).toHaveLength(12);
    const km = await db.expenseTypeDefault.findFirstOrThrow({ where: { type: "travel_km" }, include: { ledgerAccount: true, vatCode: true } });
    expect([km.ledgerAccount?.number, km.vatCode?.code, km.createdByUserId]).toEqual(["5905", "NOVAT", "system:accounting-seed"]);
    const gifts = await db.expenseTypeDefault.findFirstOrThrow({ where: { type: "representation_gifts" } });
    expect([gifts.ledgerAccountId, gifts.vatCodeId === null]).toEqual([null, false]);

    const state = await db.$transaction((tx) => loadForeignCurrencyVatCodeState(tx));
    expect(state.foreignCurrencyVatCode).toMatchObject({ code: "NOVAT", active: true });
    expect(state.foreignCurrencyVatCodeUsable).toBe(true);
    expect(state.foreignCurrencyVatCodeHistory).toHaveLength(1);
    expect(state.foreignCurrencyVatCodeHistory[0]).toMatchObject({ vatCode: { code: "NOVAT" }, byEmail: "system-accounting-seed@welld.ch" });
    const row = await db.refundSetting.findFirstOrThrow({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } });
    expect(row.createdByUserId).toBe("system:accounting-seed");
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_setting" SET "value" = NULL WHERE id = $1`, row.id))).rejects.toThrow();
    for (const c of await db.ledgerAccount.findMany()) expect(c.createdByUserId).toBe("system:accounting-seed");
  });

  it("an admin's earlier designation is never overridden, though the rest is still seeded", async () => {
    const mine = await db.vatCode.create({ data: { entity: "welld_ch", code: "ESTERO", label: "Estero", rateBasisPoints: 0, ...admin } });
    await db.refundSetting.create({ data: { key: FOREIGN_CURRENCY_VAT_CODE_KEY, value: mine.id, ...admin } });
    const report = await run();
    expect(report.seeded.foreignCurrencyVatCode).toBeNull();
    expect(report.seeded.vatCodes.sort()).toEqual(["IMP77", "IMP81", "NOVAT"]);
    const state = await db.$transaction((tx) => loadForeignCurrencyVatCodeState(tx));
    expect(state.foreignCurrencyVatCode?.code).toBe("ESTERO");
    expect(state.foreignCurrencyVatCodeHistory).toHaveLength(1);
    expect(state.foreignCurrencyVatCodeHistory[0]!.byEmail).toBe("admin@welld.ch");
  });

  it("an admin's earlier choice for a type (even an explicit none), and an existing catalog entry, are kept", async () => {
    const own = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "My own name", ...admin } });
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "postal", ledgerAccountId: null, vatCodeId: null, ...admin } });
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "telephone", ledgerAccountId: own.id, vatCodeId: null, ...admin } });
    const report = await run();
    expect(report.seeded.typeDefaults).not.toContain("postal");
    expect(report.seeded.typeDefaults).not.toContain("telephone");
    expect(report.seeded.ledgerAccounts).not.toContain("5901");
    expect((await db.ledgerAccount.findUniqueOrThrow({ where: { id: own.id } })).name).toBe("My own name");
    expect(await db.expenseTypeDefault.count({ where: { type: "postal" } })).toBe(1);
    expect(await db.expenseTypeDefault.count({ where: { type: "telephone" } })).toBe(1);
  });

  it("does not seed a default that points at a deactivated entry, and says so", async () => {
    const acc = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6104", name: "Postali", ...admin } });
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: acc.id, active: false, ...admin } });
    const report = await run();
    expect(report.seeded.warnings.join("\n")).toContain("6104");
    const postal = await db.expenseTypeDefault.findFirstOrThrow({ where: { type: "postal" } });
    expect([postal.ledgerAccountId, postal.vatCodeId === null]).toEqual([null, false]);
  });
});

describe("idempotence and dry run", () => {
  it("a second run changes nothing, not even a second marker", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-03", currency: "EUR" }]);
    await request("u2", [{ id: "l3", date: "2026-03-04", type: "postal" }], { name: "Anna Rossi" });
    await run();
    const before = await snapshot();
    const second = await run();
    expect(await snapshot()).toEqual(before);
    expect(second).toMatchObject({ alreadyReleased: true, markerWritten: false, lines: [], unclassified: [] });
    expect(second.seeded).toMatchObject({ ledgerAccounts: [], vatCodes: [], typeDefaults: [], foreignCurrencyVatCode: null });
    expect(await db.refundSetting.count({ where: { key: "accounting-release-completed-at" } })).toBe(1);
  });

  it("--dry-run writes nothing and reports exactly what the real run then does", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-01", type: "postal" }]);
    const before = await snapshot();
    const dry = await run({ dryRun: true });
    expect(await snapshot()).toEqual(before);
    expect(dry.dryRun).toBe(true);
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
    expect(dry.lines.map((l) => [l.lineId, l.receiptNumber, l.account, l.vatCode])).toEqual([
      ["l2", "MC26/001", "6104", "NOVAT"],
      ["l1", "MC26/002", "5901", "IMP81"],
    ]);
    expect(formatReport(dry)).toContain("DRY RUN");
    expect(formatReport(dry)).toContain("MC26/002");

    const real = await run();
    expect(real.lines.map((l) => [l.lineId, l.receiptNumber, l.account, l.vatCode])).toEqual(dry.lines.map((l) => [l.lineId, l.receiptNumber, l.account, l.vatCode]));
    expect(real.dryRun).toBe(false);
  });
});

describe("offsets (D2)", () => {
  it("numbering starts after the offset, and the counter records it as loaded by the release", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }, { id: "l2", date: "2026-03-03" }], { email: "matteo.codogno@welld.ch" });
    const report = await run({ offsets: [{ email: "Matteo.Codogno@welld.ch", year: 2026, lastIssuedSeq: 81 }] });
    expect(report.offsets).toEqual([{ email: "Matteo.Codogno@welld.ch", year: 2026, lastIssuedSeq: 81, outcome: "applied" }]);
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
    const before = await snapshot();
    await request("u1", [{ id: "l2", date: "2026-03-09" }], { email: "m@welld.ch" });
    await expect(run({ offsets: [{ email: "m@welld.ch", year: 2026, lastIssuedSeq: 81 }] })).rejects.toThrow(/already has receipt numbers/);
    const after = await snapshot();
    expect({ ...after, numbers: "", audit: 0 }).toEqual({ ...before, numbers: "", audit: 0 });
    expect((await line("l2")).receiptNumber).toBeNull();
  });

  it("a refused offset rolls back the seed and the marker too", async () => {
    await request("u1", [{ id: "l1", date: "2026-03-02" }], { email: "m@welld.ch" });
    await expect(run({ offsets: [{ email: "nobody@welld.ch", year: 2026, lastIssuedSeq: 5 }] })).rejects.toThrow(/nobody@welld.ch/);
    expect(await db.ledgerAccount.count()).toBe(0);
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
