/**
 * The accounting release script (T11, specs/20261118-refund-accounting-export, plan "refund-api: new script", D2, D6, D7, D13;
 * AC-2.5, AC-7.1, AC-7.2, AC-7.3; rewritten by T22, specs/20261119-accounting, plan § Release scripts, D20; AC-7.4, AC-7.5,
 * AC-6.8).
 *
 * A one-time, OPERATOR-RUN command, run once after refund-api is deployed (the precedent of `settings:seed`,
 * specs/20260722-refund-settings D7). Until it has run, approving a request is refused with `accounting_release_pending` (D6), so no
 * number can be issued before the legacy lines are numbered and any starting offset is loaded.
 *
 *   bun run accounting:release [--dry-run] --offsets <csv> [--defaults <json>] [--show-emails]
 *
 * `--offsets` IS REQUIRED since 2026-11-19 (20261118 SO-13, AC-7.4, SO-22): the list of the last receipt numbers issued by hand in the
 * 2026 register, `email,year,lastIssuedSeq`. Without it the run writes NOTHING (no default, no number, no baseline row, no marker),
 * prints why and EXITS 3; since approvals stay refused until the marker exists, no number is consumed meanwhile, and a rerun with the
 * list is safe. A file with the header line and no row is an explicit "no employee has a hand-issued 2026 number" and is accepted
 * (numbering starts at 001, AC-4.12). Accounting is read first, so an unreadable Accounting still exits 2 before the list is looked
 * at. `--dry-run` without the list reads Accounting, writes nothing and reports `BLOCKED: list missing` (and exits 3, as the real
 * run would).
 *
 * ACCOUNTING IS READ FIRST (AC-7.4, AC-6.8). The release no longer owns a catalog: WellD CH's ledger accounts and VAT codes are
 * Accounting's, already live and entered by accounting (or loaded by `seed:welld-ch` there), and nothing here creates them. Before
 * anything is written the script reads, as `system:refund-api`, the WellD CH reference data and the rate in effect of every
 * (currency, month) of the legacy foreign-currency lines (asked in chunks of 6 months, the most the producer fetches on a consumer's
 * behalf in one call, one deadline each). If any read does not come back clean and complete, it exits 2 with "Accounting cannot be
 * read: nothing was numbered or classified; run again later" and has written nothing: not a number, a copy, a default, a designation
 * or the marker. Running it again later is safe.
 *
 * Then ALL in ONE transaction (a failure anywhere changes nothing):
 * 1. DEFAULTS. Refund's fourteen type defaults, ACCOUNTS ONLY (20261118 SO-16, SO-17: there is no VAT default and no foreign-currency
 *    VAT code, and the defaults file refuses both), from `scripts/data/accounting-defaults.welld-ch.json` by natural key, each only
 *    where Refund holds no row yet (an admin's earlier choice, even "none", is never overridden) and only for an account ACTIVE in
 *    Accounting (else skipped and reported). The rows are copies, as an admin's own choice would be (number and name), written as
 *    `system:accounting-seed`.
 * 2. BASELINE (`--offsets`, CSV `email,year,lastIssuedSeq`, never committed because it names employees): each row is appended to the
 *    `receipt_number_baseline` table, keyed by the lower-cased email. It is NOT a counter: the counter of an employee is created by
 *    `classifyAndNumber` when their first 2026 line is numbered (here in the backfill, or later at an approval) and starts after the
 *    baseline, so an employee with no Refund request yet is covered too (AC-4.11). Only 2026 is accepted (AC-4.12), twice the same
 *    email is refused, and a row is refused when the employee's 2026 counter already exists with another start; the same value again
 *    is "already-applied" and writes nothing, so a rerun changes nothing. The report names each row `<initials Refund will use> ·
 *    <user ref>`, or "not yet in Refund", so accounting can check the initials against the register (AC-4.8).
 * 3. BACKFILL: every non-rejected WellD CH line of an approved or paid request that has no number is classified and numbered, per
 *    employee, by expense date, then creation time, then id (`classifyAndNumber`, cause `release`, actor
 *    `system:accounting-release`; AC-7.1). The classification is the COPY of the current default ACCOUNT of its expense type, as
 *    Accounting holds the entry now, and no VAT code (the VAT code is optional and never pre-set); a foreign-currency line also gets
 *    the copy of the rate in effect for its month, or stays "rate pending" and is copied at the first export of its batch (AC-5.6).
 *    A line whose account cannot be resolved (no default, or the entry is not active in Accounting, or Accounting holds no WellD CH
 *    accounts at all, AC-7.5) is still numbered; the missing account is listed in the report and blocks its export until accounting
 *    sets it (AC-7.2). An empty VAT code list refuses nothing (AC-7.5). WellD Italia lines are never touched (AC-7.3).
 * 4. MARKER: `accounting-release-completed-at`, which lets approvals through.
 *
 * `--dry-run` reads Accounting, runs all of it (given the list) and rolls it back, so the report shows the exact numbers, classifications and rates the
 * real run would give (R1). Run twice, the second run finds nothing to do and writes nothing, not even a second marker.
 *
 * The script is not part of the production image (as `settings:seed`): the operator runs it from a checkout against the production
 * database, with refund-api's environment (`ACCOUNTING_INTERNAL_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`, `AUTH_BASE_URL`),
 * so it reaches Accounting as `system:refund-api` (runbook in infra/README.md).
 *
 * Personal data (security review S-03, S-04; plan SR-3, SR-4). The offsets file names employees by email: keep it OUTSIDE the
 * repository (the script warns when the path is inside a git worktree, and `.gitignore` refuses the usual names). The report names an
 * employee as `<initials> · <first 8 characters of the user id>`; full emails only with `--show-emails`, and error messages (and the
 * row of an employee not yet in Refund) mask them as `m***@welld.ch`. Run it from an operator shell, never from CI or any job whose output is shipped to a log service. Nothing the
 * script prints about Accounting names a URL, a host or a token: only the failure kind is logged, by the client.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createQuietDb, db as serviceDb } from "../src/lib/db";
import type { Prisma } from "../src/lib/generated/prisma/client";
import { ExpenseType } from "../src/lib/generated/prisma/enums";
import {
  accountingPort,
  AccountingUnavailableError,
  ratePairKey,
  type AccountingPort,
  type RatePair,
} from "../src/accounting/accountingClient";
import type { RatePairWire, ReferenceDataWire } from "../src/accounting/accountingWire";
import { formatRate, monthOf } from "../src/accounting/classification";
import { DEFAULTS_ENTITY } from "../src/accounting/defaults.repo";
import { BASELINE_YEAR, baselineKey, classifyAndNumber, type AccountingReads } from "../src/accounting/numbering.repo";
import { initials } from "../src/accounting/receiptNumber";
import { referenceSnapshot, type ReferenceSnapshot } from "../src/accounting/referenceSnapshot";
import { isAccountingReleased, RELEASE_MARKER_KEY } from "../src/accounting/release";

export const SEED_ACTOR = { userId: "system:accounting-seed", email: "system-accounting-seed@welld.ch" } as const;
export const RELEASE_ACTOR = { userId: "system:accounting-release", email: "system-accounting-release@welld.ch" } as const;

export const DEFAULT_DEFAULTS_PATH = new URL("./data/accounting-defaults.welld-ch.json", import.meta.url).pathname;

/** The message of AC-7.4, printed when Accounting cannot be read (exit code 2). */
export const ACCOUNTING_UNREADABLE_MESSAGE =
  "Accounting cannot be read: nothing was numbered or classified; run again later";

/** The message of AC-7.4, printed when the list of hand-issued numbers is missing (exit code 3, nothing written). */
export const BASELINE_MISSING_MESSAGE =
  "the list of last hand-issued 2026 numbers is missing: nothing was numbered (AC-7.4). Run it again with --offsets <csv> " +
  "(a file with only the header line `email,year,lastIssuedSeq` states that there are none)";

/** The exit codes: 0 done, 1 any other failure, 2 Accounting unreadable (AC-7.4), 3 the baseline list missing (AC-7.4, SO-13). */
export const EXIT_ACCOUNTING_UNREADABLE = 2;
export const EXIT_BASELINE_MISSING = 3;

/** Distinct months per call to Accounting: the most it fetches from its official source on a consumer's behalf in one call (D4). */
export const RATE_CHUNK_MONTHS = 6;

// ─── Inputs ──────────────────────────────────────────────────────────────────

const EXPENSE_TYPES = Object.values(ExpenseType) as [ExpenseType, ...ExpenseType[]];

/**
 * Accounts only, and strict at both levels: an entry with a `vatCode` and a file with `foreignCurrencyVatCode` are refused, so a
 * stale file of the old world fails loudly instead of being half-read (20261118 SO-17). `_note` is the one free key.
 */
const DefaultsSchema = z.strictObject({
  _note: z.string().optional(),
  typeDefaults: z.partialRecord(z.enum(EXPENSE_TYPES), z.strictObject({ ledgerAccount: z.string().trim().min(1).nullable() })),
});
export type DefaultsData = z.infer<typeof DefaultsSchema>;

export function parseDefaults(raw: unknown): DefaultsData {
  const parsed = DefaultsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseError("defaults_invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

// ─── Personal data in output (SR-3, SR-4) ────────────────────────────────────

/** `matteo.codogno@welld.ch` → `m***@welld.ch`; a value with no local part or no `@` keeps one character at most. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at === 0) return "***";
  if (at < 0) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/** `MC · 1a2b3c4d`: the initials and the first eight characters of the user id; no email, no name. */
export function employeeRef(initialsValue: string, userId: string): string {
  return `${initialsValue} · ${userId.slice(0, 8)}`;
}

/**
 * A warning when `path` lies inside a git worktree (a directory with `.git`, a directory in a clone or a file in a
 * linked worktree, at any level above it), else `null`. The offsets file holds employee emails and must never be
 * committed (SR-3). The check follows symlinks of the directory, and says nothing about the file's content.
 */
export function offsetsPathWarning(path: string): string | null {
  const absolute = resolve(path);
  let dir = dirname(absolute);
  try {
    dir = realpathSync(dir);
  } catch {
    // a directory that does not exist yet: the read will fail on its own
  }
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return (
        `WARNING: the offsets file ${absolute} is inside a git worktree (${dir}). It lists employee emails and must ` +
        "never be committed: keep it outside the repository and delete it after the release (infra/README.md)."
      );
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface OffsetRow {
  readonly email: string;
  readonly year: number;
  readonly lastIssuedSeq: number;
}

/**
 * `email,year,lastIssuedSeq` per line; a header line, blank lines and `#` comments are allowed. Only 2026 is accepted (AC-4.12), and
 * the same email twice is refused, whatever its case. A file with no row must say so with the header line: an empty or truncated file
 * is refused, because "no employee has a hand-issued number" would number from 001 and could repeat a paper number.
 */
export function parseOffsetsCsv(text: string, options: { readonly showEmails?: boolean } = {}): OffsetRow[] {
  const shown = (value: string) => (options.showEmails === true ? value : maskEmail(value));
  const rows: OffsetRow[] = [];
  const seen = new Set<string>();
  let headerSeen = false;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const cells = line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    if (cells[0]?.toLowerCase() === "email") {
      headerSeen = true; // the header line
      return;
    }
    const where = `offsets line ${index + 1}`;
    if (cells.length !== 3) throw new ReleaseError("offsets_invalid", `${where}: expected email,year,lastIssuedSeq`);
    const [email, yearText, seqText] = cells as [string, string, string];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ReleaseError("offsets_invalid", `${where}: "${shown(email)}" is not an email`);
    if (!/^\d{4}$/.test(yearText) || Number(yearText) < 2000) throw new ReleaseError("offsets_invalid", `${where}: year must be four digits`);
    if (Number(yearText) !== BASELINE_YEAR) {
      throw new ReleaseError("offsets_invalid", `${where}: only ${BASELINE_YEAR} continues the paper register (AC-4.12), got ${yearText}`);
    }
    if (!/^\d{1,5}$/.test(seqText) || Number(seqText) < 1) throw new ReleaseError("offsets_invalid", `${where}: lastIssuedSeq must be a whole number from 1 to 99999`);
    const key = `${baselineKey(email)}|${yearText}`;
    if (seen.has(key)) throw new ReleaseError("offsets_invalid", `${where}: ${shown(email)} ${yearText} appears twice`);
    seen.add(key);
    rows.push({ email, year: Number(yearText), lastIssuedSeq: Number(seqText) });
  });
  if (rows.length === 0 && !headerSeen) {
    throw new ReleaseError(
      "offsets_invalid",
      "the offsets file has no header line and no row. For an empty list, write only the header line: email,year,lastIssuedSeq",
    );
  }
  return rows;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface ReleaseLineReport {
  readonly lineId: string;
  readonly requestId: string;
  /** The employee's email: printed only with `--show-emails` (SR-4). */
  readonly employee: string;
  /** `MC · 1a2b3c4d`: what the report prints instead of the email. */
  readonly employeeRef: string;
  readonly date: string;
  readonly type: string;
  readonly currency: string;
  readonly receiptNumber: string;
  /** The account number copied onto the line, or `null`. */
  readonly account: string | null;
  readonly missing: readonly string[];
  /** A foreign-currency line left with no rate: the first export of its batch copies it (AC-5.6). */
  readonly ratePending: boolean;
  /** The rate copied onto the line (`0.9246`), `"pending"`, or `null` for a CHF line. */
  readonly rate: string | null;
}

export interface ReleaseReport {
  readonly dryRun: boolean;
  /** The marker was already there when the run started. */
  readonly alreadyReleased: boolean;
  /** What Accounting held for WellD CH when it was read, and how many (currency, month) rates were asked. */
  readonly accounting: {
    readonly ledgerAccounts: { readonly active: number; readonly total: number };
    readonly vatCodes: { readonly active: number; readonly total: number };
    readonly ratePairsAsked: number;
  };
  readonly seeded: {
    readonly typeDefaults: string[];
    readonly warnings: string[];
  };
  /**
   * The baseline rows of the list, in file order. `employeeRef` is `<initials Refund will use> · <user ref>` for an employee who has a
   * Refund request, `null` for one who has none yet (the report says "not yet in Refund"). Empty for an explicit empty list.
   */
  readonly baseline: { email: string; employeeRef: string | null; year: number; lastIssuedSeq: number; outcome: "applied" | "already-applied" }[];
  /**
   * `"baseline_missing"`: a DRY RUN with no `--offsets` list. Nothing was numbered (the real run would stop with exit 3); `numbered`,
   * `lines` and `baseline` are empty and `legacyLinesWaiting` counts what the real run would number once the list is given.
   */
  readonly blocked: "baseline_missing" | null;
  readonly legacyLinesWaiting: number;
  readonly numbered: { employee: string; employeeRef: string; year: number; count: number; first: string; last: string }[];
  readonly lines: ReleaseLineReport[];
  /** Numbered lines whose account could not be resolved (AC-7.2, AC-7.5). */
  readonly unclassified: ReleaseLineReport[];
  /** Numbered foreign-currency lines with no rate in effect: "rate pending" (AC-5.6). */
  readonly ratePending: ReleaseLineReport[];
  /** WellD Italia lines of approved or paid requests, left without a number (AC-7.3). */
  readonly itLinesLeftUnnumbered: number;
  /** The marker was written by this run; in a dry run, the marker the real run WOULD write (nothing is written). */
  readonly markerWritten: boolean;
}

export class ReleaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** A real run with no `--offsets` list (AC-7.4): thrown before any write; the CLI exits {@link EXIT_BASELINE_MISSING}. */
export class BaselineMissingError extends ReleaseError {
  constructor() {
    super("baseline_missing", BASELINE_MISSING_MESSAGE);
    this.name = "BaselineMissingError";
  }
}

/**
 * What the operator's terminal and any session log get for a failure (F-03). A `ReleaseError` is the script's own: its message was
 * written here and masks emails unless asked. Anything else (a Prisma or driver error) can carry the invocation arguments, an
 * employee's address, a host or connection text, so only its KIND is printed: the error name, and its `code` when that is a
 * plain identifier (`ENOENT`, `P1001`). The same rule as `seed:welld-ch` in accounting-api.
 */
export function describeReleaseFailure(error: unknown): string {
  if (error instanceof ReleaseError) return error.message;
  if (!(error instanceof Error)) return "an unknown error";
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? `${name} (${code})` : name;
}

/**
 * The client of the run. As a command (`bun run accounting:release`) it is the quiet one: Prisma's own error log would print the
 * invocation, the source path and the host before `describeReleaseFailure` speaks (T57, F-03). Imported (the in-process tests of
 * `accounting-release.test.ts`), it is the shared `db`, which the tests seed and read through.
 */
const db: typeof serviceDb = import.meta.main ? createQuietDb() : serviceDb;

/** Thrown to roll a dry run back; carries the finished report. */
class DryRunRollback extends Error {
  constructor(readonly report: ReleaseReport) {
    super("dry run");
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface ReleaseOptions {
  readonly dryRun?: boolean;
  /**
   * The list of last hand-issued 2026 numbers (REQUIRED, SO-13). `undefined` is "no list": a real run throws
   * {@link BaselineMissingError} having written nothing, a dry run reports it as blocked. `[]` is the explicit empty list.
   */
  readonly offsets?: readonly OffsetRow[] | undefined;
  /** Refund's defaults by natural key; default: the file of `scripts/data`. */
  readonly defaults?: DefaultsData;
  readonly now?: () => Date;
  /** Emails in error messages unmasked (SR-4). */
  readonly showEmails?: boolean;
  /** How Accounting is read; default: the port every route reads through (the real client of `ACCOUNTING_INTERNAL_URL`). */
  readonly accounting?: AccountingPort;
}

type Tx = Prisma.TransactionClient;

/** The legacy lines that will be classified and numbered: the same predicate as the backfill below. */
const legacyLineWhere = {
  entity: "welld_ch",
  rejectionReason: null,
  receiptNumber: null,
  request: { status: { in: ["approved", "paid"] } },
} satisfies Prisma.RefundLineWhereInput;

/** The distinct (currency, month) pairs of the legacy foreign-currency lines: what Accounting is asked for rates. */
async function legacyRatePairs(client: Tx | typeof db): Promise<RatePair[]> {
  const lines = await client.refundLine.findMany({
    where: { ...legacyLineWhere, currency: { not: "CHF" } },
    select: { currency: true, date: true },
  });
  const pairs = new Map<string, RatePair>();
  for (const line of lines) {
    const pair: RatePair = { currency: line.currency as RatePair["currency"], month: monthOf(line.date) };
    pairs.set(ratePairKey(pair), pair);
  }
  return [...pairs.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/** The pairs split into groups of at most {@link RATE_CHUNK_MONTHS} distinct months, oldest months first. */
export function chunkByMonths(pairs: readonly RatePair[], months: number = RATE_CHUNK_MONTHS): RatePair[][] {
  const order = [...new Set(pairs.map((p) => p.month))].sort();
  const chunks: RatePair[][] = [];
  for (let start = 0; start < order.length; start += months) {
    const group = new Set(order.slice(start, start + months));
    chunks.push(pairs.filter((p) => group.has(p.month)));
  }
  return chunks;
}

interface AccountingRead {
  readonly data: ReferenceDataWire;
  readonly snapshot: ReferenceSnapshot;
  readonly rates: ReadonlyMap<string, RatePairWire>;
  readonly pairsAsked: number;
}

/**
 * Step zero: Accounting, BEFORE anything is written (AC-7.4). The reference data in one operation, then the rates chunk by chunk,
 * each chunk its own operation and so its own 10 s deadline (a long history cannot make one deadline fail the run, nor can one
 * slow month starve the others). Anything but a clean, complete answer throws `AccountingUnavailableError`.
 */
async function readAccounting(accounting: AccountingPort, pairs: readonly RatePair[]): Promise<AccountingRead> {
  const data = await accounting.begin("release").referenceData("welld_ch");
  const rates = new Map<string, RatePairWire>();
  for (const chunk of chunkByMonths(pairs)) {
    for (const answer of await accounting.begin("release").rates(chunk, "welld_ch")) rates.set(ratePairKey(answer), answer);
  }
  return { data, snapshot: referenceSnapshot(data), rates, pairsAsked: pairs.length };
}

export async function runAccountingRelease(options: ReleaseOptions = {}): Promise<ReleaseReport> {
  const defaults = options.defaults ?? parseDefaults(JSON.parse(readFileSync(DEFAULT_DEFAULTS_PATH, "utf8")));
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  const accounting = options.accounting ?? accountingPort();

  // Read first, write after: an unreachable Accounting ends the run here with nothing changed (AC-7.4).
  const read = await readAccounting(accounting, await legacyRatePairs(db));

  // Then the list. A missing list writes nothing at all: no default, no baseline row, no number, no marker (AC-7.4, SO-13).
  const offsets = options.offsets;
  if (offsets === undefined && !dryRun) throw new BaselineMissingError();

  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('accounting-release'))`;
        const alreadyReleased = await isAccountingReleased(tx);
        const seeded = await seedDefaults(tx, defaults, read.snapshot);
        // A dry run with no list numbers nothing (the numbers would be wrong: they would ignore the paper register): it counts.
        const blocked = offsets === undefined;
        const baseline = blocked ? [] : await applyBaseline(tx, offsets, options.showEmails === true);
        const backfill = blocked
          ? { numbered: [], lines: [], itLinesLeftUnnumbered: await countItLines(tx) }
          : await backfillLegacyLines(tx, { snapshot: read.snapshot, rates: read.rates });
        const legacyLinesWaiting = blocked ? await tx.refundLine.count({ where: legacyLineWhere }) : 0;
        let markerWritten = false;
        if (!alreadyReleased && !blocked) {
          await tx.refundSetting.create({
            data: {
              key: RELEASE_MARKER_KEY,
              value: now().toISOString(),
              createdByUserId: RELEASE_ACTOR.userId,
              createdByEmail: RELEASE_ACTOR.email,
            },
          });
          markerWritten = true;
        }
        const report: ReleaseReport = {
          dryRun,
          alreadyReleased,
          accounting: {
            ledgerAccounts: { active: read.data.ledgerAccounts.filter((a) => a.active).length, total: read.data.ledgerAccounts.length },
            vatCodes: { active: read.data.vatCodes.filter((v) => v.active).length, total: read.data.vatCodes.length },
            ratePairsAsked: read.pairsAsked,
          },
          seeded,
          baseline,
          blocked: blocked ? "baseline_missing" : null,
          legacyLinesWaiting,
          numbered: backfill.numbered,
          lines: backfill.lines,
          unclassified: backfill.lines.filter((l) => l.missing.length > 0),
          ratePending: backfill.lines.filter((l) => l.ratePending),
          itLinesLeftUnnumbered: backfill.itLinesLeftUnnumbered,
          markerWritten,
        };
        if (dryRun) throw new DryRunRollback(report);
        return report;
      },
      { timeout: 5 * 60_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

// ── 1. Defaults ──────────────────────────────────────────────────────────────

async function seedDefaults(tx: Tx, defaults: DefaultsData, snapshot: ReferenceSnapshot): Promise<ReleaseReport["seeded"]> {
  const out = { typeDefaults: [] as string[], warnings: [] as string[] };
  const actor = { createdByUserId: SEED_ACTOR.userId, createdByEmail: SEED_ACTOR.email };

  /** The entry as Accounting holds it, when it is active; else a warning and `null`: an entry Accounting no longer offers is never seeded. */
  const usableAccount = (number: string | null, what: string) => {
    if (number === null) return null;
    const found = snapshot.lookupAccount(number);
    if (found.state === "active") return { number: found.number, name: found.name };
    out.warnings.push(`${what}: account ${number} is ${found.state === "deactivated" ? "deactivated" : "not found"} in Accounting, no default account seeded`);
    return null;
  };

  const base = Date.now();
  let tick = 0;
  for (const type of Object.values(ExpenseType)) {
    const entry = defaults.typeDefaults[type];
    if (!entry) continue;
    const existing = await tx.expenseTypeAccountingDefault.count({ where: { entity: DEFAULTS_ENTITY, type } });
    if (existing > 0) continue; // an admin's choice, even an explicit "none", is never overridden
    const account = usableAccount(entry.ledgerAccount, type);
    if (account === null) continue;
    await tx.expenseTypeAccountingDefault.create({
      data: {
        entity: DEFAULTS_ENTITY,
        type,
        accountNumber: account.number,
        accountName: account.name,
        createdAt: new Date(base + tick++),
        ...actor,
      },
    });
    out.typeDefaults.push(type);
  }
  return out;
}

// ── 2. Baseline ──────────────────────────────────────────────────────────────

/**
 * Appends the list to `receipt_number_baseline` (append-only: the latest row per email and year counts), refusing what cannot be
 * applied. Nothing here creates a counter: `classifyAndNumber` does, when the employee's first 2026 line is numbered, and starts it
 * after the baseline (so an employee with no Refund request yet is covered).
 */
async function applyBaseline(tx: Tx, rows: readonly OffsetRow[], showEmails: boolean): Promise<ReleaseReport["baseline"]> {
  const out: ReleaseReport["baseline"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const who = showEmails ? row.email : maskEmail(row.email);
    const key = baselineKey(row.email);
    // Re-checked here, not only in the file parser: a caller can hand rows in directly.
    if (row.year !== BASELINE_YEAR) {
      throw new ReleaseError("offsets_invalid", `offsets: ${who} ${row.year}: only ${BASELINE_YEAR} continues the paper register (AC-4.12)`);
    }
    if (!Number.isInteger(row.lastIssuedSeq) || row.lastIssuedSeq < 1 || row.lastIssuedSeq > 99_999) {
      throw new ReleaseError("offsets_invalid", `offsets: ${who}: lastIssuedSeq must be a whole number from 1 to 99999`);
    }
    if (seen.has(key)) throw new ReleaseError("offsets_invalid", `offsets: ${who} ${row.year} appears twice`);
    seen.add(key);

    // Who Refund knows by this email, case-insensitively. None is fine (AC-4.11: the employee has no request yet).
    const owners = await tx.refundRequest.findMany({
      where: { ownerEmail: { equals: key, mode: "insensitive" } },
      distinct: ["ownerUserId"],
      orderBy: { createdAt: "desc" },
      select: { ownerUserId: true, ownerName: true, ownerEmail: true },
    });
    if (owners.length > 1) {
      // The baseline is keyed by email: two user ids behind one email would each start after it and repeat each other's numbers.
      throw new ReleaseError("offset_ambiguous_employee", `offsets: ${who} belongs to more than one user id`);
    }
    const known = owners[0];
    let ref: string | null = null;
    if (known) {
      const latest = await tx.refundRequest.findFirstOrThrow({
        where: { ownerUserId: known.ownerUserId },
        orderBy: { createdAt: "desc" },
        select: { ownerName: true, ownerEmail: true },
      });
      // The counter is created from the email of the request being numbered (the newest at release): the list must name that one,
      // or the baseline would be missed and the employee would be numbered from 001 over the paper numbers.
      if (baselineKey(latest.ownerEmail) !== key) {
        throw new ReleaseError(
          "offset_email_changed",
          `offsets: the newest request of ${who} carries another email: list the one Refund holds now (${showEmails ? latest.ownerEmail : maskEmail(latest.ownerEmail)})`,
        );
      }
      ref = employeeRef(initials(latest.ownerName, latest.ownerEmail), known.ownerUserId);

      const counter = await tx.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId: known.ownerUserId, year: row.year } } });
      if (counter) {
        // The counter exists: the baseline can no longer start it. Same start (set by a baseline or an earlier offset) = done already.
        if (counter.startAfter === row.lastIssuedSeq && counter.startAfterSetBy !== null) {
          out.push({ ...row, employeeRef: ref, outcome: "already-applied" });
          continue;
        }
        throw new ReleaseError(
          "offset_pair_has_numbers",
          `offsets: ${who} already has receipt numbers for ${row.year} (last ${counter.lastSeq}); a baseline can only be loaded before the first one`,
        );
      }
      const numbered = await tx.refundLine.count({ where: { receiptOwnerUserId: known.ownerUserId, receiptYear: row.year } });
      if (numbered > 0) throw new ReleaseError("offset_pair_has_numbers", `offsets: ${who} already has receipt numbers for ${row.year}`);
    }

    const latestRow = await tx.receiptNumberBaseline.findFirst({
      where: { emailKey: key, year: row.year },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { lastIssuedSeq: true },
    });
    if (latestRow?.lastIssuedSeq === row.lastIssuedSeq) {
      out.push({ ...row, employeeRef: ref, outcome: "already-applied" });
      continue;
    }
    await tx.receiptNumberBaseline.create({
      data: { emailKey: key, year: row.year, lastIssuedSeq: row.lastIssuedSeq, createdByUserId: RELEASE_ACTOR.userId, createdByEmail: RELEASE_ACTOR.email },
    });
    out.push({ ...row, employeeRef: ref, outcome: "applied" });
  }
  return out;
}

// ── 3. Backfill ──────────────────────────────────────────────────────────────

/** WellD Italia lines of approved or paid requests: never numbered by the release (AC-7.3), only counted. */
const countItLines = (tx: Tx): Promise<number> =>
  tx.refundLine.count({
    where: { entity: "welld_it", rejectionReason: null, receiptNumber: null, request: { status: { in: ["approved", "paid"] } } },
  });

async function backfillLegacyLines(
  tx: Tx,
  reference: AccountingReads,
): Promise<{
  numbered: ReleaseReport["numbered"];
  lines: ReleaseLineReport[];
  itLinesLeftUnnumbered: number;
}> {
  const candidates = await tx.refundLine.findMany({
    where: legacyLineWhere,
    select: { requestId: true },
    distinct: ["requestId"],
  });
  const requests = await tx.refundRequest.findMany({
    where: { id: { in: candidates.map((c) => c.requestId) } },
    select: { id: true, ownerUserId: true, ownerEmail: true, ownerName: true, submittedAt: true, createdAt: true },
  });
  const byOwner = new Map<string, typeof requests>();
  for (const request of requests) byOwner.set(request.ownerUserId, [...(byOwner.get(request.ownerUserId) ?? []), request]);

  const lines: ReleaseLineReport[] = [];
  for (const ownerUserId of [...byOwner.keys()].sort()) {
    const ownerRequests = byOwner.get(ownerUserId)!;
    // The newest request carries the name the employee has now; the initials are fixed by the first number issued.
    const latest = [...ownerRequests].sort(
      (a, b) => (b.submittedAt ?? b.createdAt).getTime() - (a.submittedAt ?? a.createdAt).getTime(),
    )[0]!;
    const result = await classifyAndNumber(tx, {
      owner: { userId: ownerUserId, name: latest.ownerName, email: latest.ownerEmail },
      requestIds: ownerRequests.map((r) => r.id),
      cause: "release",
      actor: { userId: RELEASE_ACTOR.userId, email: RELEASE_ACTOR.email },
      reference,
      entities: ["welld_ch"],
    });
    if (!result.ok) {
      // Only `approval` refuses on a missing classification; `reference_missing` means a legacy line appeared between the read of
      // Accounting and this transaction (a rate pair that was never asked). Nothing is guessed: the run is rolled back.
      throw new ReleaseError(
        "legacy_lines_changed",
        "the legacy lines changed while the release was running, so Accounting was not asked about all of them; run it again",
      );
    }

    const details = await tx.refundLine.findMany({
      where: { id: { in: result.lines.map((l) => l.lineId) } },
      select: { id: true, date: true, type: true, currency: true, accountNumber: true, fxRateMicros: true },
    });
    const detailOf = new Map(details.map((d) => [d.id, d]));
    for (const numbered of result.lines) {
      const d = detailOf.get(numbered.lineId)!;
      lines.push({
        lineId: numbered.lineId,
        requestId: numbered.requestId,
        employee: latest.ownerEmail,
        employeeRef: employeeRef(numbered.receiptNumber.match(/^[A-Z]{2}/)?.[0] ?? "??", ownerUserId),
        date: d.date.toISOString().slice(0, 10),
        type: d.type,
        currency: d.currency,
        receiptNumber: numbered.receiptNumber,
        account: d.accountNumber,
        missing: numbered.missing ?? [],
        ratePending: numbered.ratePending,
        rate: d.currency === "CHF" ? null : d.fxRateMicros !== null ? formatRate(d.fxRateMicros) : "pending",
      });
    }
  }

  const groups = new Map<string, ReleaseReport["numbered"][number]>();
  for (const line of lines) {
    const year = Number(line.receiptNumber.slice(2, 4)) + 2000;
    const key = `${line.employeeRef}|${line.employee}|${year}`;
    const group = groups.get(key);
    if (group) {
      groups.set(key, { ...group, count: group.count + 1, last: line.receiptNumber });
    } else {
      groups.set(key, {
        employee: line.employee,
        employeeRef: line.employeeRef,
        year,
        count: 1,
        first: line.receiptNumber,
        last: line.receiptNumber,
      });
    }
  }

  const itLinesLeftUnnumbered = await countItLines(tx);
  return {
    numbered: [...groups.values()].sort((a, b) => a.employee.localeCompare(b.employee) || a.year - b.year),
    lines,
    itLinesLeftUnnumbered,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function formatReport(report: ReleaseReport, options: { readonly showEmails?: boolean } = {}): string {
  const who = (entry: { employee: string; employeeRef: string }) => (options.showEmails === true ? entry.employee : entry.employeeRef);
  const out: string[] = [];
  out.push(report.dryRun ? "DRY RUN: nothing was written. This is what the real run would do." : "Accounting release completed.");
  if (report.blocked === "baseline_missing") {
    out.push(
      "",
      `BLOCKED: list missing. ${BASELINE_MISSING_MESSAGE}`,
      "The real run would stop here with exit code 3, having written nothing, so no number would be consumed.",
      `Legacy WellD CH lines the real run would number once the list is given: ${report.legacyLinesWaiting}`,
    );
  }
  if (report.alreadyReleased) out.push("The release marker was already set: this run only completed what was left.");
  const a = report.accounting;
  const s = report.seeded;
  const blocked = report.blocked !== null;
  const shownEmail = (email: string) => (options.showEmails === true ? email : maskEmail(email));
  out.push(
    "",
    "Accounting (WellD CH, read before anything was written)",
    `  ledger accounts: ${a.ledgerAccounts.active} active of ${a.ledgerAccounts.total}`,
    `  VAT codes: ${a.vatCodes.active} active of ${a.vatCodes.total}`,
    `  exchange rates asked for ${a.ratePairsAsked} (currency, month) pairs of the legacy lines`,
    // No VAT code is needed to approve, release or export (AC-7.5): only an empty account list is worth a warning.
    ...(a.ledgerAccounts.active === 0
      ? [
          "  WARNING: Accounting holds no active WellD CH ledger accounts. Every legacy line is numbered but left without an account,",
          "  and every WellD CH approval is refused until accounting enters them in Accounting.",
        ]
      : []),
    "",
    "Default accounts of Refund (by natural key, each only where Refund held no row)",
    `  type defaults set (${s.typeDefaults.length}): ${s.typeDefaults.join(", ") || "none"}`,
    ...s.warnings.map((w) => `  WARNING: ${w}`),
  );
  if (!blocked) {
    out.push(
      "",
      `Baseline: last hand-issued ${BASELINE_YEAR} numbers (${report.baseline.length})`,
      ...(report.baseline.length === 0
        ? [`  an empty list: no employee has a hand-issued ${BASELINE_YEAR} number, numbering starts at 001 (AC-4.12)`]
        : report.baseline.map((b) => {
            // The initials are the ones Refund will put on the number (AC-4.8): accounting checks them against the register.
            const name = b.employeeRef !== null ? (options.showEmails === true ? `${b.employeeRef} · ${b.email}` : b.employeeRef) : `not yet in Refund (${shownEmail(b.email)})`;
            return `  ${name} ${b.year}: numbering continues after ${b.lastIssuedSeq} (${b.outcome})`;
          })),
      "",
      `Numbered legacy WellD CH lines (${report.lines.length})`,
      ...report.numbered.map((n) => `  ${who(n)} ${n.year}: ${n.count} lines, ${n.first} to ${n.last}`),
      "",
      `Rate pending: ${report.ratePending.length} lines (no rate in effect yet: the first export of their batch copies it)`,
      ...report.ratePending.map((l) => `  ${l.receiptNumber} ${who(l)} ${l.date} ${l.type} ${l.currency} (line ${l.lineId})`),
      "",
      `Left without an account (${report.unclassified.length})`,
      ...report.unclassified.map(
        (l) => `  ${l.receiptNumber} ${who(l)} ${l.date} ${l.type} ${l.currency}: missing ${l.missing.join(" and ")} (line ${l.lineId})`,
      ),
    );
  }
  out.push(
    "",
    `WellD Italia lines of approved or paid requests left without a number: ${report.itLinesLeftUnnumbered}`,
    // D-1: `markerWritten` means "would be written" in a dry run, and a dry run writes nothing: say so.
    `Release marker written: ${
      blocked ? "no (blocked: the list is missing)" : !report.markerWritten ? "no (already set)" : report.dryRun ? "no (dry run: the real run would write it)" : "yes"
    }`,
  );
  if (report.dryRun && !blocked) {
    out.push("", "Every line (receipt number, date, type, currency, account, rate)");
    for (const l of report.lines) {
      out.push(`  ${l.receiptNumber}  ${l.date}  ${l.type}  ${l.currency}  ${l.account ?? "-"}  ${l.rate ?? "-"}  ${who(l)}`);
    }
  }
  return out.join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  const dryRun = args.includes("--dry-run");
  const take = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ReleaseError("usage", `${flag} needs a value`);
    return value;
  };
  const showEmails = args.includes("--show-emails");
  const offsetsPath = take("--offsets");
  const defaultsPath = take("--defaults");
  const known = new Set(["--dry-run", "--show-emails", "--offsets", "--defaults", ...(offsetsPath ? [offsetsPath] : []), ...(defaultsPath ? [defaultsPath] : [])]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new ReleaseError(
      "usage",
      `unknown argument ${unknown[0]}. Usage: bun run accounting:release [--dry-run] --offsets <csv> [--defaults <json>] [--show-emails]`,
    );
  }
  if (offsetsPath) {
    const warning = offsetsPathWarning(offsetsPath);
    if (warning) console.warn(warning);
  }
  const report = await runAccountingRelease({
    dryRun,
    showEmails,
    ...(offsetsPath ? { offsets: parseOffsetsCsv(readFileSync(offsetsPath, "utf8"), { showEmails }) } : {}),
    ...(defaultsPath ? { defaults: parseDefaults(JSON.parse(readFileSync(defaultsPath, "utf8"))) } : {}),
  });
  console.log(formatReport(report, { showEmails }));
  // A dry run that was blocked by the missing list says what the real run would do: it ends with the same exit code (AC-7.4).
  if (report.blocked === "baseline_missing") process.exitCode = EXIT_BASELINE_MISSING;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .catch((error) => {
      if (error instanceof AccountingUnavailableError) {
        // AC-7.4: exit 2, nothing written. The kind is for the operator (it names no URL, host or token); the client logged it too.
        console.error(`accounting:release stopped: ${ACCOUNTING_UNREADABLE_MESSAGE}. (${error.kind})`);
        process.exitCode = EXIT_ACCOUNTING_UNREADABLE;
        return;
      }
      if (error instanceof BaselineMissingError) {
        // AC-7.4, SO-13: exit 3, nothing written. Accounting was read first, so an unreadable one would have exited 2 above.
        console.error(`accounting:release stopped: ${error.message}`);
        process.exitCode = EXIT_BASELINE_MISSING;
        return;
      }
      console.error(`accounting:release failed, nothing was changed: ${describeReleaseFailure(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
