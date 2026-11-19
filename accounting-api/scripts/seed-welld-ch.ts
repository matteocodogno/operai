/**
 * `seed:welld-ch` (T14, specs/20261119-accounting, plan § Release scripts 1, D20; AC-1.1, AC-1.13, AC-7.5; moved here from
 * refund-api's `accounting:release`, which no longer creates a catalog): loads the list accounting signed off, WellD CH's
 * ledger accounts and VAT codes, into Accounting.
 *
 *   bun run seed:welld-ch [--dry-run]
 *
 * An OPERATOR-RUN command, run once on the release day BEFORE Refund's release (runbook in infra/README.md), and OPTIONAL: when
 * accounting prefers to type the list in the app, skip it. It is not a feature offered to users (spec non-goal "Bulk import",
 * amendment SA-1).
 *
 * What it does, in ONE transaction (a failure anywhere adds nothing):
 * - for each account number and VAT code of `scripts/data/seed.welld-ch.json` that does not exist yet in WellD CH, adds it,
 *   active, as `system:accounting-seed` (AC-1.13: who added it, and when);
 * - never touches an entry that exists: not deactivated or reactivated, not renamed, no rate changed. An existing entry that
 *   differs from the seed (another name, another label or rate) is left as it is and named in the report;
 * - never touches WellD Italia, nor anything but the two catalog tables.
 *
 * It is idempotent: run twice, the second run adds nothing. `--dry-run` runs all of it and rolls it back, so the report shows
 * exactly what the real run would add.
 *
 * The report gives counts and the account numbers and VAT codes involved. There is no personal data in the seed, in the
 * actor, or in the report. The seed file is validated with the same limits as the app (`catalog/limits.ts`) before anything is
 * written: an entry the app would refuse stops the run, so the seed can never hold what a person could not have entered.
 *
 * Like `settings:seed`, the script is run by the operator from a checkout (or the image) with accounting-api's environment
 * (`DATABASE_URL`), never from CI or a job whose output is shipped to a log service.
 */

import { readFileSync } from "node:fs";
import { percentToBasisPoints } from "../src/catalog/catalog.repo";
import {
  checkLedgerName,
  checkLedgerNumber,
  checkVatCode,
  checkVatLabel,
  checkVatRatePercent,
  type LimitCheck,
} from "../src/catalog/limits";
import { db } from "../src/lib/db";
import type { Entity } from "../src/entities";

/** The actor of every row the seed adds (AC-1.13). */
export const SEED_ACTOR = { userId: "system:accounting-seed", email: "system-accounting-seed@welld.ch" } as const;

/** The seed is WellD CH's, and only WellD CH's. */
export const SEED_ENTITY: Entity = "welld_ch";

export const DEFAULT_SEED_PATH = new URL("./data/seed.welld-ch.json", import.meta.url).pathname;

export interface SeedLedgerAccount {
  readonly number: string;
  readonly name: string;
}

export interface SeedVatCode {
  readonly code: string;
  readonly label: string;
  readonly rateBasisPoints: number;
}

export interface Seed {
  readonly ledgerAccounts: readonly SeedLedgerAccount[];
  readonly vatCodes: readonly SeedVatCode[];
}

/** The seed file is wrong: nothing was read into the database. The message names the entry and the field, never a value of the system. */
export class SeedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedFileError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checked(what: string, field: string, result: LimitCheck): string {
  if (!result.ok) throw new SeedFileError(`${what}: ${field} is refused (${result.reason})`);
  return result.value;
}

/**
 * Reads a seed from parsed JSON, checking every entry as the app would: the number, name, code, label and rate limits of
 * `catalog/limits.ts`, a code upper-cased, no number or code twice. Members other than the two lists (`_note`) are ignored.
 */
export function parseSeed(raw: unknown): Seed {
  if (!isRecord(raw) || !Array.isArray(raw["ledgerAccounts"]) || !Array.isArray(raw["vatCodes"])) {
    throw new SeedFileError("the seed must hold the lists `ledgerAccounts` and `vatCodes`");
  }
  const numbers = new Set<string>();
  const ledgerAccounts = raw["ledgerAccounts"].map((item: unknown, index): SeedLedgerAccount => {
    const what = `ledgerAccounts[${index}]`;
    if (!isRecord(item)) throw new SeedFileError(`${what} is not an object`);
    const number = checked(what, "number", checkLedgerNumber(item["number"]));
    const name = checked(what, "name", checkLedgerName(item["name"]));
    if (numbers.has(number)) throw new SeedFileError(`${what}: the number ${number} appears twice`);
    numbers.add(number);
    return { number, name };
  });
  const codes = new Set<string>();
  const vatCodes = raw["vatCodes"].map((item: unknown, index): SeedVatCode => {
    const what = `vatCodes[${index}]`;
    if (!isRecord(item)) throw new SeedFileError(`${what} is not an object`);
    const code = checked(what, "code", checkVatCode(item["code"]));
    const label = checked(what, "label", checkVatLabel(item["label"]));
    const ratePercent = checked(what, "ratePercent", checkVatRatePercent(item["ratePercent"]));
    if (codes.has(code)) throw new SeedFileError(`${what}: the code ${code} appears twice`);
    codes.add(code);
    return { code, label, rateBasisPoints: percentToBasisPoints(ratePercent) };
  });
  return { ledgerAccounts, vatCodes };
}

/** Reads and checks the seed file; a file that is not there, not JSON or not a valid seed is a {@link SeedFileError}. */
export function loadSeed(path: string = DEFAULT_SEED_PATH): Seed {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SeedFileError("the seed file cannot be read or is not JSON");
  }
  return parseSeed(raw);
}

export interface SeedReport {
  readonly dryRun: boolean;
  readonly ledgerAccounts: {
    readonly inSeed: number;
    readonly added: readonly string[];
    readonly present: readonly string[];
    /** Present with another name than the seed's: left as it is. */
    readonly differing: readonly string[];
  };
  readonly vatCodes: {
    readonly inSeed: number;
    readonly added: readonly string[];
    readonly present: readonly string[];
    /** Present with another label or rate than the seed's: left as it is. */
    readonly differing: readonly string[];
  };
}

/** Thrown inside the transaction of a dry run, to roll it back; never leaves this module. */
class DryRunRollback extends Error {
  constructor(readonly report: SeedReport) {
    super("dry run");
  }
}

async function apply(seed: Seed, dryRun: boolean): Promise<SeedReport> {
  // Four statements however long the list: two reads and two multi-row inserts, so a database a continent away does not stretch
  // the transaction past its time limit.
  return db.$transaction(
    async (tx) => {
      const existingAccounts = new Map(
        (await tx.ledgerAccount.findMany({ where: { entity: SEED_ENTITY }, select: { number: true, name: true } })).map((row) => [row.number, row.name]),
      );
      const accounts = { added: [] as SeedLedgerAccount[], present: [] as string[], differing: [] as string[] };
      for (const entry of seed.ledgerAccounts) {
        const name = existingAccounts.get(entry.number);
        if (name === undefined) {
          accounts.added.push(entry);
          continue;
        }
        accounts.present.push(entry.number);
        if (name !== entry.name) accounts.differing.push(entry.number);
      }
      if (accounts.added.length > 0) {
        await tx.ledgerAccount.createMany({
          data: accounts.added.map(({ number, name }) => ({
            entity: SEED_ENTITY,
            number,
            name,
            createdByUserId: SEED_ACTOR.userId,
            createdByEmail: SEED_ACTOR.email,
          })),
        });
      }

      const existingVat = new Map(
        (await tx.vatCode.findMany({ where: { entity: SEED_ENTITY }, select: { code: true, label: true, rateBasisPoints: true } })).map((row) => [row.code, row]),
      );
      const vat = { added: [] as SeedVatCode[], present: [] as string[], differing: [] as string[] };
      for (const entry of seed.vatCodes) {
        const row = existingVat.get(entry.code);
        if (row === undefined) {
          vat.added.push(entry);
          continue;
        }
        vat.present.push(entry.code);
        if (row.label !== entry.label || row.rateBasisPoints !== entry.rateBasisPoints) vat.differing.push(entry.code);
      }
      if (vat.added.length > 0) {
        await tx.vatCode.createMany({
          data: vat.added.map(({ code, label, rateBasisPoints }) => ({
            entity: SEED_ENTITY,
            code,
            label,
            rateBasisPoints,
            createdByUserId: SEED_ACTOR.userId,
            createdByEmail: SEED_ACTOR.email,
          })),
        });
      }

      const report: SeedReport = {
        dryRun,
        ledgerAccounts: { ...accounts, inSeed: seed.ledgerAccounts.length, added: accounts.added.map((a) => a.number) },
        vatCodes: { ...vat, inSeed: seed.vatCodes.length, added: vat.added.map((v) => v.code) },
      };
      if (dryRun) throw new DryRunRollback(report);
      return report;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/**
 * Seeds WellD CH from `seed` (default: the signed-off list) in one transaction. With `dryRun` everything runs and is rolled
 * back, so the report is exactly what a real run would add and nothing is written.
 */
export async function seedWelldCh(options: { readonly dryRun?: boolean; readonly seed?: Seed } = {}): Promise<SeedReport> {
  const dryRun = options.dryRun ?? false;
  const seed = options.seed ?? loadSeed();
  try {
    return await apply(seed, dryRun);
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

/** The report as lines: counts and the numbers and codes involved, nothing else. */
export function formatReport(report: SeedReport): string[] {
  const { ledgerAccounts: a, vatCodes: v } = report;
  const lines = [
    `seed:welld-ch${report.dryRun ? " (dry run)" : ""}: entity ${SEED_ENTITY}, actor ${SEED_ACTOR.userId}`,
    `ledger accounts: ${a.inSeed} in the seed, ${a.added.length} added, ${a.present.length} already there`,
    `  added: ${list(a.added)}`,
    `vat codes: ${v.inSeed} in the seed, ${v.added.length} added, ${v.present.length} already there`,
    `  added: ${list(v.added)}`,
  ];
  if (a.differing.length > 0) lines.push(`ledger accounts there with another name than the seed (left as they are): ${list(a.differing)}`);
  if (v.differing.length > 0) lines.push(`vat codes there with another label or rate than the seed (left as they are): ${list(v.differing)}`);
  lines.push(report.dryRun ? "dry run: nothing was written" : "done");
  return lines;
}

export const USAGE = "Usage: bun run seed:welld-ch [--dry-run]";

/**
 * The CLI without `process`: the arguments after the script name, a sink for the output, the exit code. 0 done, 1 refused
 * (arguments or seed file) or failed (nothing was added: one transaction).
 */
export async function runCli(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    err(USAGE);
    return 1;
  }
  try {
    const report = await seedWelldCh({ dryRun: args.includes("--dry-run") });
    for (const line of formatReport(report)) out(line);
    return 0;
  } catch (error) {
    // The kind only: a driver error can carry a connection string.
    err(error instanceof SeedFileError ? `seed:welld-ch refused: ${error.message}` : "seed:welld-ch failed: nothing was added; run it again");
    return 1;
  }
}

// Only when executed directly (`bun run seed:welld-ch`), not when a test imports the module.
if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line));
  await db.$disconnect();
  process.exitCode = code;
}
