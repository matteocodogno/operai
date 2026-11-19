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

describe("the seed file (the signed-off list of 2026-11-19, SO-20, AC-7.6)", () => {
  it("holds exactly the 19 ledger accounts and 6 VAT codes of the signed-off list, and nothing of Refund's defaults", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_SEED_PATH, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["_note", "ledgerAccounts", "vatCodes"]);
    expect(seed.ledgerAccounts.map((a) => a.number).sort()).toEqual(
      [
        "2620.1", "5808", "5901", "5902", "5903", "5904", "5905", "5906", "5907", "5909", "5999",
        "6101", "6102", "6104", "6405", "6501", "6701", "6720", "7122",
      ].sort(),
    );
    expect(seed.ledgerAccounts).toHaveLength(19);
    expect(seed.vatCodes.map((v) => [v.code, v.rateBasisPoints])).toEqual([
      ["IPM81", 810],
      ["IPM77", 770],
      ["IP00", 0],
      ["BZM81", 810],
      ["IPM26", 260],
      ["IPM38", 380],
    ]);
  });

  it("(AC-7.6) no code named IMP81, IMP77 or NOVAT, in the seed or anywhere in the file", () => {
    const text = readFileSync(DEFAULT_SEED_PATH, "utf8");
    for (const retired of ["IMP81", "IMP77", "NOVAT"]) {
      expect(seed.vatCodes.some((v) => v.code === retired)).toBe(false);
      expect(text).not.toContain(retired);
    }
  });

  it("(AC-7.6) carries the accounts the sign-off added, named as the owner wrote them, and 7122 under its new name", () => {
    const byNumber = new Map(seed.ledgerAccounts.map((a) => [a.number, a.name]));
    expect(byNumber.get("5902")).toBe("Spese viaggi in aereo");
    expect(byNumber.get("5903")).toBe("Spese viaggi taxi");
    expect(byNumber.get("6501")).toBe("Libri e manuali");
    expect(byNumber.get("6701")).toBe("Spese pranzi e cene con clienti");
    expect(byNumber.get("7122")).toBe("Spese da riaddebitare a WellD Italia");
    expect(byNumber.get("2620.1")).toBe("Altri debiti verso soci - CHF (CH)");
  });

  it("carries the names of the WellD CH chart of accounts, not the drafts marked `(to confirm)`", () => {
    const byNumber = new Map(seed.ledgerAccounts.map((a) => [a.number, a.name]));
    expect(byNumber.get("5808")).toBe("Contributo aziendale abbonamento mezzi pubblici personale");
    expect(byNumber.get("5909")).toBe("Spese di alloggio (viaggi)");
    expect(byNumber.get("5999")).toBe("Altre spese di viaggio");
    expect(byNumber.get("6405")).toBe("Spese licenze software");
    expect(byNumber.get("6720")).toBe("Spese pranzi e cene di lavoro (interni)");
    expect(seed.ledgerAccounts.some((a) => /to confirm/i.test(a.name))).toBe(false);
  });

  it("the labels of the six codes, written from the rates (provisional for IPM26 and IPM38)", () => {
    expect(seed.vatCodes.map((v) => [v.code, v.label])).toEqual([
      ["IPM81", "IVA 8.1%"],
      ["IPM77", "IVA 7.7%"],
      ["IP00", "IVA 0%"],
      ["BZM81", "IVA 8.1% reverse charge (servizi dall'estero)"],
      ["IPM26", "IVA 2.6% (aliquota ridotta)"],
      ["IPM38", "IVA 3.8% (alloggio)"],
    ]);
  });

  it("(seeds agree, SO-20) every default account Refund's 14 defaults name exists in this seed; the defaults carry no VAT code of any kind", () => {
    const defaultsPath = new URL("../../refund-api/scripts/data/accounting-defaults.welld-ch.json", import.meta.url);
    const defaults = JSON.parse(readFileSync(defaultsPath, "utf8")) as {
      typeDefaults: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
    const numbers = new Set(seed.ledgerAccounts.map((a) => a.number));
    expect(Object.keys(defaults.typeDefaults).sort()).toEqual(
      [
        "company_manuals", "office_material", "postal", "representation_gifts", "representation_meals", "stationery", "telephone",
        "travel_flight", "travel_highway", "travel_km", "travel_other_public_transport", "travel_parking", "travel_taxi", "travel_train",
      ].sort(),
    );
    expect(Object.keys(defaults).sort()).toEqual(["_note", "typeDefaults"]); // no `foreignCurrencyVatCode`
    const named = new Set<string>();
    for (const [type, entry] of Object.entries(defaults.typeDefaults)) {
      expect([type, Object.keys(entry)]).toEqual([type, ["ledgerAccount"]]); // an account and nothing else: no `vatCode`
      const number = entry["ledgerAccount"];
      if (number !== null) named.add(number as string);
    }
    expect(named.size).toBe(12); // 13 of the 14 types name an account (gifts none); 6101 serves three, so 12 distinct numbers
    for (const number of named) expect([number, numbers.has(number)]).toEqual([number, true]);
    // The signed-off defaults of SO-17, one by one.
    expect(Object.fromEntries(Object.entries(defaults.typeDefaults).map(([type, e]) => [type, e["ledgerAccount"]]))).toEqual({
      travel_km: "5905",
      travel_train: "5901",
      travel_other_public_transport: "5904",
      travel_flight: "5902",
      travel_taxi: "5903",
      travel_highway: "5906",
      travel_parking: "5907",
      representation_meals: "6701",
      representation_gifts: null,
      office_material: "6101",
      stationery: "6101",
      company_manuals: "6501",
      postal: "6104",
      telephone: "6102",
    });
  });
});

describe("a run (AC-1.1, AC-1.13)", () => {
  it("adds every account and VAT code of the seed to WellD CH, active, as the system actor, and touches nothing else", async () => {
    const report = await seedWelldCh();
    expect(report.dryRun).toBe(false);
    expect(report.ledgerAccounts).toMatchObject({ inSeed: 19, present: [], differing: [] });
    expect(report.ledgerAccounts.added).toEqual(seed.ledgerAccounts.map((a) => a.number));
    expect(report.vatCodes.added).toEqual(["IPM81", "IPM77", "IP00", "BZM81", "IPM26", "IPM38"]);

    const accounts = await db.ledgerAccount.findMany();
    expect(accounts).toHaveLength(19);
    for (const row of accounts) {
      expect([row.entity, row.createdByUserId, row.createdByEmail]).toEqual(["welld_ch", SEED_ACTOR.userId, "system-accounting-seed@welld.ch"]);
    }
    const vat = await db.vatCode.findMany();
    expect(vat).toHaveLength(6);
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
    expect(second.ledgerAccounts.present).toHaveLength(19);
    expect(second.vatCodes.present).toHaveLength(6);
    expect(await counts()).toEqual(before);
    expect(JSON.stringify(await db.ledgerAccount.findMany({ orderBy: { number: "asc" } }))).toBe(rowsBefore);
  });

  it("adds only what is absent: a list that accounting partly typed in is completed, not redone", async () => {
    await createLedgerAccount("welld_ch", { number: "5901", name: "Spese viaggi in treno" }, manual);
    await createVatCode("welld_ch", { code: "IP00", label: "IVA 0%", rateBasisPoints: 0 }, manual);
    const report = await seedWelldCh();
    expect(report.ledgerAccounts.added).toHaveLength(18);
    expect(report.ledgerAccounts.added).not.toContain("5901");
    expect(report.ledgerAccounts.present).toEqual(["5901"]);
    expect(report.vatCodes.added).toEqual(["IPM81", "IPM77", "BZM81", "IPM26", "IPM38"]);
    expect((await db.ledgerAccount.findFirstOrThrow({ where: { number: "5901" } })).createdByUserId).toBe("user-accounting");
  });

  it("an existing entry that was deactivated stays deactivated, with its status rows as they were", async () => {
    await createLedgerAccount("welld_ch", { number: "5905", name: "Spese rimborsi chilometrici (viaggi)" }, manual);
    await createVatCode("welld_ch", { code: "IPM77", label: "IVA 7.7%", rateBasisPoints: 770 }, manual);
    await setLedgerAccountActive("welld_ch", "5905", false, manual);
    await setVatCodeActive("welld_ch", "IPM77", false, manual);
    const statuses = JSON.stringify(await db.catalogStatusChange.findMany({ orderBy: { createdAt: "asc" } }));

    await seedWelldCh();
    await seedWelldCh();

    expect(JSON.stringify(await db.catalogStatusChange.findMany({ orderBy: { createdAt: "asc" } }))).toBe(statuses);
    const account = await db.ledgerAccount.findFirstOrThrow({ where: { entity: "welld_ch", number: "5905" }, include: { statusChanges: true } });
    expect(account.statusChanges.map((s) => s.active)).toEqual([false]);
    expect(account.createdByUserId).toBe("user-accounting");
    const code = await db.vatCode.findFirstOrThrow({ where: { entity: "welld_ch", code: "IPM77" }, include: { statusChanges: true } });
    expect(code.statusChanges.map((s) => s.active)).toEqual([false]);
  });

  it("an existing entry that differs from the seed is not changed, and the report names it", async () => {
    await createLedgerAccount("welld_ch", { number: "5901", name: "Treno (nome di accounting)" }, manual);
    await createVatCode("welld_ch", { code: "IPM81", label: "IVA 8.1% (altro)", rateBasisPoints: 800 }, manual);
    const report = await seedWelldCh();
    expect(report.ledgerAccounts.differing).toEqual(["5901"]);
    expect(report.vatCodes.differing).toEqual(["IPM81"]);
    expect(await db.ledgerAccount.findFirstOrThrow({ where: { number: "5901", entity: "welld_ch" } })).toMatchObject({ name: "Treno (nome di accounting)" });
    expect(await db.vatCode.findFirstOrThrow({ where: { code: "IPM81", entity: "welld_ch" } })).toMatchObject({ label: "IVA 8.1% (altro)", rateBasisPoints: 800 });
    expect(formatReport(report).join("\n")).toContain("another name than the seed (left as they are): 5901");
  });
});

describe("--dry-run", () => {
  it("writes nothing, and reports exactly what the real run then adds", async () => {
    await createLedgerAccount("welld_ch", { number: "6101", name: "Spese materiale ufficio" }, manual);
    const before = await counts();
    const dry = await seedWelldCh({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.ledgerAccounts.added).toHaveLength(18);
    expect(await counts()).toEqual(before);

    const real = await seedWelldCh();
    expect({ ...real, dryRun: true }).toEqual(dry);
    expect(await counts()).toEqual({ accounts: 19, vatCodes: 6, statuses: 0 });
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
    expect(await counts()).toEqual({ accounts: 19, vatCodes: 6, statuses: 0 });
    const again = await seedWelldCh();
    expect(again.ledgerAccounts.added).toEqual([]);
  });
});

describe("the seed is checked with the app's own limits", () => {
  const account = (over: Record<string, unknown> = {}) => ({ number: "5901", name: "Spese", ...over });
  const vat = (over: Record<string, unknown> = {}) => ({ code: "IPM81", label: "IVA", ratePercent: "8.1", ...over });
  const parse = (accounts: unknown[], codes: unknown[]) => parseSeed({ ledgerAccounts: accounts, vatCodes: codes });

  it("accepts a valid seed, upper-cases a code, and trims", () => {
    expect(parse([account({ number: " 2620.1 ", name: " Conto " })], [vat({ code: "ipm81" })])).toEqual({
      ledgerAccounts: [{ number: "2620.1", name: "Conto" }],
      vatCodes: [{ code: "IPM81", label: "IVA", rateBasisPoints: 810 }],
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
      [[], [vat(), vat({ code: "ipm81", label: "Doppio" })], /the code IPM81 appears twice/],
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
    expect(text).toContain("ledger accounts: 19 in the seed, 19 added, 0 already there");
    expect(text).toContain("vat codes: 6 in the seed, 6 added, 0 already there");
    expect(text).toContain("added: 2620.1, 5808, 5901, 5902");
    expect(text).toContain("added: IPM81, IPM77, IP00, BZM81, IPM26, IPM38");
    expect(out.at(-1)).toBe("done");
    expect(text).not.toMatch(/@|carla|Spese|IVA/);
    const second: string[] = [];
    await runCli([], (l) => second.push(l), () => undefined);
    expect(second.join("\n")).toContain("0 added, 19 already there");
  });

  it("refuses an argument it does not know, with the usage, and writes nothing", async () => {
    const err: string[] = [];
    expect(await runCli(["--dryrun"], () => undefined, (l) => err.push(l))).toBe(1);
    expect(await runCli(["--dry-run", "x"], () => undefined, (l) => err.push(l))).toBe(1);
    expect(err).toEqual([USAGE, USAGE]);
    expect(await counts()).toEqual({ accounts: 0, vatCodes: 0, statuses: 0 });
  });
});
