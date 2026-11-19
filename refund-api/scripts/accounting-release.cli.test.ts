/**
 * The release script as an OPERATOR runs it: `bun run scripts/accounting-release.ts [--dry-run] [--offsets <csv>]`
 * (QE pass T35, specs/20261118-refund-accounting-export; AC-7.1, AC-7.2, AC-7.3, plan D2, D6, R5).
 *
 * `accounting-release.test.ts` drives `runAccountingRelease()` in process. What no test ran is the entry point
 * itself (argument parsing, the report on stdout, the exit code, "nothing was changed" on failure), and that is the
 * one thing the owner types in production (T40, infra/README.md runbook). A bad flag or a crash that still exits 0
 * would leave approvals blocked (409 `accounting_release_pending`) or, worse, report a success that did not happen.
 *
 * Real Postgres (the `refund` database of DATABASE_URL), the script run as a child process with the same environment.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { isAccountingReleased } from "../src/accounting/release";
import { truncateRefundTables } from "../src/test-support/dbCleanup";

const SCRIPT = join(import.meta.dir, "accounting-release.ts");
const tmp = mkdtempSync(join(tmpdir(), "accounting-release-cli-"));

beforeEach(async () => {
  await truncateRefundTables({ released: false });
});
afterAll(async () => {
  await truncateRefundTables({ released: false });
  rmSync(tmp, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

/** An approved request of Matteo Codogno with one WellD CH line per spec, plus an approved WellD Italia line. */
async function legacyRequest(dates: string[]) {
  const request = await db.refundRequest.create({
    data: { ownerUserId: "u-matteo", ownerEmail: "matteo.codogno@welld.ch", ownerName: "Matteo Codogno", status: "approved", submittedAt: new Date("2026-03-01") },
  });
  const ids: string[] = [];
  for (const date of dates) {
    const l = await db.refundLine.create({
      data: { requestId: request.id, date: new Date(date), type: "travel_train", motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 1000, approvedTotalCents: 1000 },
    });
    ids.push(l.id);
  }
  const it = await db.refundLine.create({
    data: { requestId: request.id, date: new Date("2026-03-01"), type: "travel_train", motivo: "it", entity: "welld_it", currency: "CHF", requestedAmountCents: 500, approvedTotalCents: 500 },
  });
  return { ids, itId: it.id };
}

const released = () => db.$transaction((tx) => isAccountingReleased(tx));
const numbers = async (ids: string[]) =>
  (await db.refundLine.findMany({ where: { id: { in: ids } }, orderBy: { date: "asc" } })).map((l) => l.receiptNumber);

describe("accounting:release, run as the operator runs it", () => {
  it("an unknown argument exits 1 with the usage and changes nothing", async () => {
    const { ids } = await legacyRequest(["2026-03-02"]);
    const res = await cli("--dryrun");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("accounting:release failed, nothing was changed");
    expect(res.stderr).toContain("unknown argument --dryrun");
    expect(res.stdout).not.toContain("Accounting release completed");
    expect(await released()).toBe(false);
    expect(await numbers(ids)).toEqual([null]);
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("--offsets with no value exits 1 and changes nothing", async () => {
    await legacyRequest(["2026-03-02"]);
    const res = await cli("--offsets");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--offsets needs a value");
    expect(await released()).toBe(false);
  });

  it("--dry-run prints what would happen, every line, and writes nothing: no marker, no seed, no number", async () => {
    const { ids } = await legacyRequest(["2026-03-02", "2026-03-10"]);
    const res = await cli("--dry-run");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("DRY RUN: nothing was written");
    expect(res.stdout).toContain("Numbered legacy WellD CH lines (2)");
    // D-1 (qe-report.md): the report must not claim the marker was written by a dry run.
    expect(res.stdout).not.toContain("Release marker written: yes");
    expect(res.stdout).toMatch(/Release marker written: no \(dry run: the real run would write it\)/);
    expect(res.stdout).not.toContain("Accounting release completed");
    expect(res.stdout).toMatch(/MC26\/001 {2}2026-03-02/);
    expect(res.stdout).toMatch(/MC26\/002 {2}2026-03-10/);
    expect(res.stdout).toContain("WellD Italia lines of approved or paid requests left without a number: 1");
    expect(await released()).toBe(false);
    expect(await numbers(ids)).toEqual([null, null]);
    expect(await db.ledgerAccount.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
  });

  it("the real run releases: marker, seed, classification and numbers by date, the Italian line untouched; a second run changes nothing", async () => {
    const { ids, itId } = await legacyRequest(["2026-03-10", "2026-03-02"]);
    const first = await cli();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Accounting release completed.");
    expect(first.stdout).toContain("Release marker written: yes");
    expect(await released()).toBe(true);
    expect(await numbers(ids)).toEqual(["MC26/001", "MC26/002"]); // by expense date: 03-02 first
    const classified = await db.refundLine.findMany({ where: { id: { in: ids } } });
    expect(classified.every((l) => l.ledgerAccountId !== null && l.vatCodeId !== null)).toBe(true);
    const it = await db.refundLine.findUniqueOrThrow({ where: { id: itId } });
    expect([it.receiptNumber, it.ledgerAccountId, it.vatCodeId]).toEqual([null, null, null]); // AC-7.3

    const audit = await db.refundAuditEntry.count();
    const second = await cli();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("The release marker was already set");
    expect(await numbers(ids)).toEqual(["MC26/001", "MC26/002"]);
    expect(await db.refundAuditEntry.count()).toBe(audit);
    expect(await db.receiptCounter.count()).toBe(1);
  });

  it("--offsets <csv> continues numbering after the paper-era number, and the file is read from the path given", async () => {
    const { ids } = await legacyRequest(["2026-03-02"]);
    const csv = join(tmp, "offsets.csv");
    writeFileSync(csv, "email,year,lastIssuedSeq\nmatteo.codogno@welld.ch,2026,81\n");
    const res = await cli("--offsets", csv);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("MC · u-matteo 2026: numbering continues after 81"); // SR-4: no email without --show-emails
    expect(await numbers(ids)).toEqual(["MC26/082"]);
  });

  it("(SR-4, S-04) no `@` anywhere in the report without --show-emails: dry run and real run, offsets and unclassified lines included", async () => {
    await legacyRequest(["2026-03-02", "2026-03-10"]);
    const csv = join(tmp, "mask-offsets.csv");
    writeFileSync(csv, "matteo.codogno@welld.ch,2026,81\n");
    const dry = await cli("--dry-run", "--offsets", csv);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("Every line");
    expect(dry.stdout).not.toContain("@");
    expect(dry.stdout).toContain("MC · u-matteo");
    expect(dry.stderr).not.toContain("@");
    const real = await cli("--offsets", csv);
    expect(real.exitCode).toBe(0);
    expect(real.stdout).not.toContain("@");
  });

  it("(SR-4) --show-emails prints the full address, in the report only when asked", async () => {
    await legacyRequest(["2026-03-02"]);
    const res = await cli("--dry-run", "--show-emails");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("matteo.codogno@welld.ch");
  });

  it("(SR-4) a refused offset names the employee masked, as m***@welld.ch, in the error", async () => {
    await legacyRequest(["2026-03-02"]);
    expect((await cli()).exitCode).toBe(0);
    const csv = join(tmp, "masked-error.csv");
    writeFileSync(csv, "matteo.codogno@welld.ch,2026,81\n");
    const res = await cli("--offsets", csv);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("m***@welld.ch");
    expect(res.stderr).not.toContain("matteo.codogno");
    const withEmails = await cli("--offsets", csv, "--show-emails");
    expect(withEmails.stderr).toContain("matteo.codogno@welld.ch");
  });

  it("(SR-3, S-03) an --offsets path inside a git worktree prints a warning (stderr), a path outside does not; the run goes on", async () => {
    await legacyRequest(["2026-03-02"]);
    const repo = join(tmp, "some-checkout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "nested"), { recursive: true });
    const inside = join(repo, "nested", "offsets.csv");
    writeFileSync(inside, "matteo.codogno@welld.ch,2026,81\n");
    const warned = await cli("--dry-run", "--offsets", inside);
    expect(warned.exitCode).toBe(0);
    expect(warned.stderr).toContain("WARNING");
    expect(warned.stderr).toContain("inside a git worktree");
    expect(warned.stderr).not.toContain("@");

    const outside = join(tmp, "outside-offsets.csv");
    writeFileSync(outside, "matteo.codogno@welld.ch,2026,81\n");
    const quiet = await cli("--dry-run", "--offsets", outside);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stderr).not.toContain("WARNING");
  });

  it("an offset for an employee and year that already hold numbers is refused: exit 1, and the whole release is rolled back", async () => {
    const { ids } = await legacyRequest(["2026-03-02"]);
    expect((await cli()).exitCode).toBe(0); // numbers MC26/001
    const csv = join(tmp, "late-offsets.csv");
    writeFileSync(csv, "matteo.codogno@welld.ch,2026,81\n");
    const res = await cli("--offsets", csv);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("nothing was changed");
    expect(await numbers(ids)).toEqual(["MC26/001"]);
    expect((await db.receiptCounter.findFirstOrThrow()).lastSeq).toBe(1);
  });

  it("a malformed offsets file is refused before anything is written", async () => {
    await legacyRequest(["2026-03-02"]);
    const csv = join(tmp, "bad.csv");
    writeFileSync(csv, "not-an-email,2026,81\n");
    const res = await cli("--offsets", csv);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("nothing was changed");
    expect(res.stderr).not.toContain("not-an-email"); // the bad cell is echoed masked (SR-4)
    expect(res.stderr).toContain('"n***"');
    expect(await released()).toBe(false);
  });
});
