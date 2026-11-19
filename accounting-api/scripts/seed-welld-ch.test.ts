/**
 * `seed:welld-ch` (T14, specs/20261119-accounting; AC-1.1, AC-1.13, AC-7.5; plan § Release scripts 1, R2): against the real
 * `accounting` database. Two runs add nothing the second time; an existing entry, deactivated or different, is never touched;
 * `--dry-run` writes nothing; the seed and Refund's defaults agree; the seed is checked with the app's own limits; the whole
 * run is one transaction.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { truncateAccountingTables } from "../src/test-support/dbCleanup";

const { db } = await import("../src/lib/db");
const { createLedgerAccount, createVatCode, setLedgerAccountActive, setVatCodeActive } = await import("../src/catalog/catalog.repo");
const { DEFAULT_SEED_PATH, formatReport, loadSeed, parseSeed, runCli, SEED_ACTOR, seedWelldCh, SeedFileError, USAGE } = await import("./seed-welld-ch");

const seed = loadSeed();
const manual = { userId: "user-accounting", email: "carla@welld.ch" };

const counts = async () => ({
  accounts: await db.ledgerAccount.count(),
  vatCodes: await db.vatCode.count(),
  statuses: await db.catalogStatusChange.count(),
});

beforeEach(truncateAccountingTables);
afterAll(truncateAccountingTables);

describe("the seed file (moved from refund-api, trimmed to the catalog)", () => {
  it("holds the 15 ledger accounts and 3 VAT codes of the signed-off list, and nothing of Refund's defaults", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_SEED_PATH, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["_note", "ledgerAccounts", "vatCodes"]);
    expect(seed.ledgerAccounts).toHaveLength(15);
    expect(seed.vatCodes.map((v) => [v.code, v.rateBasisPoints])).toEqual([["IMP81", 810], ["IMP77", 770], ["NOVAT", 0]]);
  });

  it("carries the six account names of the WellD CH chart of accounts, not the drafts marked `(to confirm)`", () => {
    const byNumber = new Map(seed.ledgerAccounts.map((a) => [a.number, a.name]));
    expect(byNumber.get("5808")).toBe("Contributo aziendale abbonamento mezzi pubblici personale");
    expect(byNumber.get("5909")).toBe("Spese di alloggio (viaggi)");
    expect(byNumber.get("5999")).toBe("Altre spese di viaggio");
    expect(byNumber.get("6405")).toBe("Spese licenze software");
    expect(byNumber.get("6720")).toBe("Spese pranzi e cene di lavoro (interni)");
    expect(byNumber.get("7122")).toBe("Spese anticipate per / succursali / altre società del gruppo");
    expect(seed.ledgerAccounts.some((a) => /to confirm/i.test(a.name))).toBe(false);
  });

  it("(seeds agree, R2) every account number and VAT code Refund's defaults name exists in this seed", () => {
    const defaults = JSON.parse(
      readFileSync(new URL("../../refund-api/scripts/data/accounting-defaults.welld-ch.json", import.meta.url), "utf8"),
    ) as {
      typeDefaults: Record<string, { ledgerAccount: string | null; vatCode: string | null }>;
      foreignCurrencyVatCode: string | null;
    };
    const numbers = new Set(seed.ledgerAccounts.map((a) => a.number));
    const codes = new Set(seed.vatCodes.map((v) => v.code));
    expect(Object.keys(defaults.typeDefaults)).toHaveLength(12);
    const named = { numbers: new Set<string>(), codes: new Set<string>() };
    for (const entry of Object.values(defaults.typeDefaults)) {
      if (entry.ledgerAccount !== null) named.numbers.add(entry.ledgerAccount);
      if (entry.vatCode !== null) named.codes.add(entry.vatCode);
    }
    if (defaults.foreignCurrencyVatCode !== null) named.codes.add(defaults.foreignCurrencyVatCode);
    expect(named.numbers.size).toBeGreaterThan(0);
    expect(named.codes.size).toBeGreaterThan(0);
    for (const number of named.numbers) expect([number, numbers.has(number)]).toEqual([number, true]);
    for (const code of named.codes) expect([code, codes.has(code)]).toEqual([code, true]);
  });
});

describe("a run (AC-1.1, AC-1.13)", () => {
  it("adds every account and VAT code of the seed to WellD CH, active, as the system actor, and touches nothing else", async () => {
    const report = await seedWelldCh();
    expect(report.dryRun).toBe(false);
    expect(report.ledgerAccounts).toMatchObject({ inSeed: 15, present: [], differing: [] });
    expect(report.ledgerAccounts.added).toEqual(seed.ledgerAccounts.map((a) => a.number));
    expect(report.vatCodes.added).toEqual(["IMP81", "IMP77", "NOVAT"]);

    const accounts = await db.ledgerAccount.findMany();
    expect(accounts).toHaveLength(15);
    for (const row of accounts) {
      expect([row.entity, row.createdByUserId, row.createdByEmail]).toEqual(["welld_ch", SEED_ACTOR.userId, "system-accounting-seed@welld.ch"]);
    }
    const vat = await db.vatCode.findMany();
    expect(vat).toHaveLength(3);
    for (const row of vat) expect([row.entity, row.createdByUserId]).toEqual(["welld_ch", "system:accounting-seed"]);
    expect(await db.catalogStatusChange.count()).toBe(0); // added active: no status row
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
    expect(await db.ledgerAccount.count({ where: { entity: "welld_it" } })).toBe(0);
    expect(await db.vatCode.count({ where: { entity: "welld_it" } })).toBe(0);
  });

  it("(AC-7.5) leaves WellD Italia's own entries alone, even with the same number", async () => {
    await createLedgerAccount("welld_it", { number: "5901", name: "Conto Italia" }, manual);
    await seedWelldCh();
    expect(await db.ledgerAccount.findFirstOrThrow({ where: { entity: "welld_it" } })).toMatchObject({ number: "5901", name: "Conto Italia", createdByUserId: "user-accounting" });
    expect(await db.ledgerAccount.count({ where: { entity: "welld_ch", number: "5901" } })).toBe(1);
  });

  it("run twice, the second adds nothing and writes nothing", async () => {
    await seedWelldCh();
    const before = await counts();
    const rowsBefore = JSON.stringify(await db.ledgerAccount.findMany({ orderBy: { number: "asc" } }));
    const second = await seedWelldCh();
    expect(second.ledgerAccounts.added).toEqual([]);
    expect(second.vatCodes.added).toEqual([]);
    expect(second.ledgerAccounts.present).toHaveLength(15);
    expect(second.vatCodes.present).toHaveLength(3);
    expect(await counts()).toEqual(before);
    expect(JSON.stringify(await db.ledgerAccount.findMany({ orderBy: { number: "asc" } }))).toBe(rowsBefore);
  });

  it("adds only what is absent: a list that accounting partly typed in is completed, not redone", async () => {
    await createLedgerAccount("welld_ch", { number: "5901", name: "Spese viaggi in treno" }, manual);
    await createVatCode("welld_ch", { code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0 }, manual);
    const report = await seedWelldCh();
    expect(report.ledgerAccounts.added).toHaveLength(14);
    expect(report.ledgerAccounts.added).not.toContain("5901");
    expect(report.ledgerAccounts.present).toEqual(["5901"]);
    expect(report.vatCodes.added).toEqual(["IMP81", "IMP77"]);
    expect((await db.ledgerAccount.findFirstOrThrow({ where: { number: "5901" } })).createdByUserId).toBe("user-accounting");
  });

  it("an existing entry that was deactivated stays deactivated, with its status rows as they were", async () => {
    await createLedgerAccount("welld_ch", { number: "5905", name: "Spese rimborsi chilometrici (viaggi)" }, manual);
    await createVatCode("welld_ch", { code: "IMP77", label: "IVA 7.7%", rateBasisPoints: 770 }, manual);
    await setLedgerAccountActive("welld_ch", "5905", false, manual);
    await setVatCodeActive("welld_ch", "IMP77", false, manual);
    const statuses = JSON.stringify(await db.catalogStatusChange.findMany({ orderBy: { createdAt: "asc" } }));

    await seedWelldCh();
    await seedWelldCh();

    expect(JSON.stringify(await db.catalogStatusChange.findMany({ orderBy: { createdAt: "asc" } }))).toBe(statuses);
    const account = await db.ledgerAccount.findFirstOrThrow({ where: { entity: "welld_ch", number: "5905" }, include: { statusChanges: true } });
    expect(account.statusChanges.map((s) => s.active)).toEqual([false]);
    expect(account.createdByUserId).toBe("user-accounting");
    const code = await db.vatCode.findFirstOrThrow({ where: { entity: "welld_ch", code: "IMP77" }, include: { statusChanges: true } });
    expect(code.statusChanges.map((s) => s.active)).toEqual([false]);
  });

  it("an existing entry that differs from the seed is not changed, and the report names it", async () => {
    await createLedgerAccount("welld_ch", { number: "5901", name: "Treno (nome di accounting)" }, manual);
    await createVatCode("welld_ch", { code: "IMP81", label: "IVA 8.1% (altro)", rateBasisPoints: 800 }, manual);
    const report = await seedWelldCh();
    expect(report.ledgerAccounts.differing).toEqual(["5901"]);
    expect(report.vatCodes.differing).toEqual(["IMP81"]);
    expect(await db.ledgerAccount.findFirstOrThrow({ where: { number: "5901", entity: "welld_ch" } })).toMatchObject({ name: "Treno (nome di accounting)" });
    expect(await db.vatCode.findFirstOrThrow({ where: { code: "IMP81", entity: "welld_ch" } })).toMatchObject({ label: "IVA 8.1% (altro)", rateBasisPoints: 800 });
    expect(formatReport(report).join("\n")).toContain("another name than the seed (left as they are): 5901");
  });
});

describe("--dry-run", () => {
  it("writes nothing, and reports exactly what the real run then adds", async () => {
    await createLedgerAccount("welld_ch", { number: "6101", name: "Spese materiale ufficio" }, manual);
    const before = await counts();
    const dry = await seedWelldCh({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.ledgerAccounts.added).toHaveLength(14);
    expect(await counts()).toEqual(before);

    const real = await seedWelldCh();
    expect({ ...real, dryRun: true }).toEqual(dry);
    expect(await counts()).toEqual({ accounts: 15, vatCodes: 3, statuses: 0 });
  });

  it("through the CLI: says so, and writes nothing", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(["--dry-run"], (l) => out.push(l), (l) => err.push(l))).toBe(0);
    expect(out[0]).toContain("(dry run)");
    expect(out.at(-1)).toBe("dry run: nothing was written");
    expect(err).toEqual([]);
    expect(await counts()).toEqual({ accounts: 0, vatCodes: 0, statuses: 0 });
  });
});

describe("one transaction", () => {
  it("a failure while adding the VAT codes adds no account either", async () => {
    const broken = {
      ledgerAccounts: seed.ledgerAccounts,
      // The same code twice is refused by the database's unique index at the second insert of the same statement.
      vatCodes: [seed.vatCodes[0]!, seed.vatCodes[0]!],
    };
    await expect(seedWelldCh({ seed: broken })).rejects.toBeDefined();
    expect(await counts()).toEqual({ accounts: 0, vatCodes: 0, statuses: 0 });
  });

  it("two runs at once end with the list complete and no entry twice", async () => {
    const results = await Promise.allSettled([seedWelldCh(), seedWelldCh()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await counts()).toEqual({ accounts: 15, vatCodes: 3, statuses: 0 });
    const again = await seedWelldCh();
    expect(again.ledgerAccounts.added).toEqual([]);
  });
});

describe("the seed is checked with the app's own limits", () => {
  const account = (over: Record<string, unknown> = {}) => ({ number: "5901", name: "Spese", ...over });
  const vat = (over: Record<string, unknown> = {}) => ({ code: "IMP81", label: "IVA", ratePercent: "8.1", ...over });
  const parse = (accounts: unknown[], codes: unknown[]) => parseSeed({ ledgerAccounts: accounts, vatCodes: codes });

  it("accepts a valid seed, upper-cases a code, and trims", () => {
    expect(parse([account({ number: " 2620.1 ", name: " Conto " })], [vat({ code: "imp81" })])).toEqual({
      ledgerAccounts: [{ number: "2620.1", name: "Conto" }],
      vatCodes: [{ code: "IMP81", label: "IVA", rateBasisPoints: 810 }],
    });
  });

  it("refuses what the app refuses, and names the entry", () => {
    const bad: [unknown[], unknown[], RegExp][] = [
      [[account({ number: "59 01" })], [], /ledgerAccounts\[0\]: number is refused \(format\)/],
      [[account({ number: "" })], [], /number is refused \(empty\)/],
      [[account({ number: "1".repeat(21) })], [], /number is refused \(too_long\)/],
      [[account({ name: "x".repeat(121) })], [], /name is refused \(too_long\)/],
      [[account({ name: "a\u0000b" })], [], /name is refused \(format\)/],
      [[account({ name: 5 })], [], /name is refused \(format\)/],
      [[account(), account({ name: "Altro" })], [], /the number 5901 appears twice/],
      [[], [vat({ code: "IMP 81" })], /vatCodes\[0\]: code is refused \(format\)/],
      [[], [vat({ code: "A".repeat(17) })], /code is refused \(too_long\)/],
      [[], [vat({ ratePercent: "100.5" })], /ratePercent is refused \(range\)/],
      [[], [vat({ ratePercent: "8.123" })], /ratePercent is refused \(format\)/],
      [[], [vat({ label: "" })], /label is refused \(empty\)/],
      [[], [vat(), vat({ code: "imp81", label: "Doppio" })], /the code IMP81 appears twice/],
      [["x"], [], /ledgerAccounts\[0\] is not an object/],
    ];
    for (const [accounts, codes, message] of bad) expect(() => parse(accounts, codes)).toThrow(message);
    expect(() => parseSeed(null)).toThrow(SeedFileError);
    expect(() => parseSeed({ ledgerAccounts: [] })).toThrow(SeedFileError);
    expect(() => loadSeed("/nonexistent/seed.json")).toThrow(SeedFileError);
  });

  it("a refused seed adds nothing", async () => {
    expect(() => parse([account(), account({ number: "x" })], [])).toThrow(SeedFileError);
    expect(await counts()).toEqual({ accounts: 0, vatCodes: 0, statuses: 0 });
  });
});

describe("the report and the CLI", () => {
  it("prints counts and numbers and codes, and no personal data", async () => {
    const out: string[] = [];
    expect(await runCli([], (l) => out.push(l), () => undefined)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("ledger accounts: 15 in the seed, 15 added, 0 already there");
    expect(text).toContain("vat codes: 3 in the seed, 3 added, 0 already there");
    expect(text).toContain("added: 5901, 5904");
    expect(text).toContain("added: IMP81, IMP77, NOVAT");
    expect(out.at(-1)).toBe("done");
    expect(text).not.toMatch(/@|carla|Spese|IVA/);
    const second: string[] = [];
    await runCli([], (l) => second.push(l), () => undefined);
    expect(second.join("\n")).toContain("0 added, 15 already there");
  });

  it("refuses an argument it does not know, with the usage, and writes nothing", async () => {
    const err: string[] = [];
    expect(await runCli(["--dryrun"], () => undefined, (l) => err.push(l))).toBe(1);
    expect(await runCli(["--dry-run", "x"], () => undefined, (l) => err.push(l))).toBe(1);
    expect(err).toEqual([USAGE, USAGE]);
    expect(await counts()).toEqual({ accounts: 0, vatCodes: 0, statuses: 0 });
  });
});
