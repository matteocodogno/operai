/**
 * The accounting release script (T11, specs/20261118-refund-accounting-export,
 * plan "refund-api: new script", D2, D6, D7, D13; AC-2.5, AC-7.1, AC-7.2, AC-7.3).
 *
 * A one-time, OPERATOR-RUN command, run once after refund-api is deployed (the
 * precedent of `settings:seed`, specs/20260722-refund-settings D7). Until it has
 * run, approving a request is refused with `accounting_release_pending` (D6),
 * so no number can be issued before the legacy lines are numbered and any
 * starting offset is loaded.
 *
 *   bun run accounting:release [--dry-run] [--offsets <csv>] [--seed <json>] [--show-emails]
 *
 * All in ONE transaction (a failure anywhere changes nothing):
 * 1. SEED the catalog, the twelve type defaults and the foreign-currency VAT
 *    code from `scripts/data/accounting-seed.welld-ch.json`, each only where
 *    nothing exists yet, so an admin's earlier entry is never overridden. Actor
 *    `system:accounting-seed`. The designation is an ordinary `refund_setting`
 *    row, so it shows in the designation history (AC-2.5).
 * 2. OFFSETS (`--offsets`, CSV `email,year,lastIssuedSeq`, never committed
 *    because it names employees): the counter of (employee, year) starts after
 *    `lastIssuedSeq`. Refused for a pair that already has numbers (D2).
 * 3. BACKFILL: every non-rejected WellD CH line of an approved or paid request
 *    that has no number is classified with the current defaults and numbered,
 *    per employee, by expense date, then creation time, then id
 *    (`classifyAndNumber`, cause `release`, actor `system:accounting-release`;
 *    AC-7.1). A line whose account or VAT code cannot be resolved is still
 *    numbered and keeps the half that did resolve; what is missing is listed in
 *    the report and blocks its export until accounting sets it (AC-7.2).
 *    WellD Italia lines are never touched (AC-7.3).
 * 4. MARKER: `accounting-release-completed-at`, which lets approvals through.
 *
 * `--dry-run` runs all of it and rolls it back, so the report shows the exact
 * numbers and classifications the real run would give (R1). Run twice, the
 * second run finds nothing to do and writes nothing, not even a second marker.
 *
 * The script is not part of the production image (as `settings:seed`): the
 * operator runs it from a checkout against the production database (runbook in
 * infra/README.md).
 *
 * Personal data (security review S-03, S-04; plan SR-3, SR-4). The offsets file
 * names employees by email: keep it OUTSIDE the repository (the script warns when
 * the path is inside a git worktree, and `.gitignore` refuses the usual names).
 * The report names an employee as `<initials> · <first 8 characters of the user id>`;
 * full emails only with `--show-emails`, and error messages mask them as
 * `m***@welld.ch`. Run it from an operator shell, never from CI or any job whose
 * output is shipped to a log service.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { db } from "../src/lib/db";
import type { Prisma } from "../src/lib/generated/prisma/client";
import { ExpenseType } from "../src/lib/generated/prisma/enums";
import { CATALOG_ENTITY, loadActiveFlags, percentToBasisPoints } from "../src/accounting/catalog.repo";
import { FOREIGN_CURRENCY_VAT_CODE_KEY, loadDefaultsSnapshot } from "../src/accounting/defaults.repo";
import { classifyAndNumber } from "../src/accounting/numbering.repo";
import { initials } from "../src/accounting/receiptNumber";
import { isAccountingReleased, RELEASE_MARKER_KEY } from "../src/accounting/release";
import {
  AddLedgerAccountBodySchema,
  AddVatCodeBodySchema,
} from "../src/accounting/catalog.schemas";

export const SEED_ACTOR = { userId: "system:accounting-seed", email: "system-accounting-seed@welld.ch" } as const;
export const RELEASE_ACTOR = { userId: "system:accounting-release", email: "system-accounting-release@welld.ch" } as const;

export const DEFAULT_SEED_PATH = new URL("./data/accounting-seed.welld-ch.json", import.meta.url).pathname;

// ─── Inputs ──────────────────────────────────────────────────────────────────

const SeedSchema = z
  .object({
    ledgerAccounts: z.array(AddLedgerAccountBodySchema),
    vatCodes: z.array(AddVatCodeBodySchema),
    typeDefaults: z.partialRecord(
      z.enum(Object.values(ExpenseType) as [ExpenseType, ...ExpenseType[]]),
      z.object({ ledgerAccount: z.string().nullable(), vatCode: z.string().nullable() }),
    ),
    foreignCurrencyVatCode: z.string().nullable(),
  })
  .superRefine((seed, ctx) => {
    const accounts = new Set(seed.ledgerAccounts.map((a) => a.number));
    const codes = new Set(seed.vatCodes.map((v) => v.code.toUpperCase()));
    if (accounts.size !== seed.ledgerAccounts.length) ctx.addIssue({ code: "custom", message: "duplicate ledger account number" });
    if (codes.size !== seed.vatCodes.length) ctx.addIssue({ code: "custom", message: "duplicate VAT code" });
    for (const [type, d] of Object.entries(seed.typeDefaults)) {
      if (d.ledgerAccount !== null && !accounts.has(d.ledgerAccount)) ctx.addIssue({ code: "custom", message: `${type}: unknown account ${d.ledgerAccount}` });
      if (d.vatCode !== null && !codes.has(d.vatCode.toUpperCase())) ctx.addIssue({ code: "custom", message: `${type}: unknown VAT code ${d.vatCode}` });
    }
    if (seed.foreignCurrencyVatCode !== null && !codes.has(seed.foreignCurrencyVatCode.toUpperCase())) {
      ctx.addIssue({ code: "custom", message: `unknown foreign-currency VAT code ${seed.foreignCurrencyVatCode}` });
    }
  });
export type SeedData = z.infer<typeof SeedSchema>;

export function parseSeed(raw: unknown): SeedData {
  const parsed = SeedSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseError("seed_invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
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

/** `email,year,lastIssuedSeq` per line; a header line, blank lines and `#` comments are allowed. */
export function parseOffsetsCsv(text: string, options: { readonly showEmails?: boolean } = {}): OffsetRow[] {
  const shown = (value: string) => (options.showEmails === true ? value : maskEmail(value));
  const rows: OffsetRow[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const cells = line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    if (cells[0]?.toLowerCase() === "email") return; // the header line
    const where = `offsets line ${index + 1}`;
    if (cells.length !== 3) throw new ReleaseError("offsets_invalid", `${where}: expected email,year,lastIssuedSeq`);
    const [email, yearText, seqText] = cells as [string, string, string];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ReleaseError("offsets_invalid", `${where}: "${shown(email)}" is not an email`);
    if (!/^\d{4}$/.test(yearText) || Number(yearText) < 2000) throw new ReleaseError("offsets_invalid", `${where}: year must be four digits`);
    if (!/^\d{1,5}$/.test(seqText) || Number(seqText) < 1) throw new ReleaseError("offsets_invalid", `${where}: lastIssuedSeq must be a whole number from 1 to 99999`);
    const key = `${email.toLowerCase()}|${yearText}`;
    if (seen.has(key)) throw new ReleaseError("offsets_invalid", `${where}: ${shown(email)} ${yearText} appears twice`);
    seen.add(key);
    rows.push({ email, year: Number(yearText), lastIssuedSeq: Number(seqText) });
  });
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
  readonly account: string | null;
  readonly vatCode: string | null;
  readonly missing: readonly string[];
}

export interface ReleaseReport {
  readonly dryRun: boolean;
  /** The marker was already there when the run started. */
  readonly alreadyReleased: boolean;
  readonly seeded: {
    readonly ledgerAccounts: string[];
    readonly vatCodes: string[];
    readonly typeDefaults: string[];
    /** The code designated by this run, or `null` when the key already had a designation (or the seed names none). */
    readonly foreignCurrencyVatCode: string | null;
    readonly warnings: string[];
  };
  readonly offsets: { email: string; employeeRef: string; year: number; lastIssuedSeq: number; outcome: "applied" | "already-applied" }[];
  readonly numbered: { employee: string; employeeRef: string; year: number; count: number; first: string; last: string }[];
  readonly lines: ReleaseLineReport[];
  /** Numbered lines whose account or VAT code could not be resolved (AC-7.2). */
  readonly unclassified: ReleaseLineReport[];
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

/** Thrown to roll a dry run back; carries the finished report. */
class DryRunRollback extends Error {
  constructor(readonly report: ReleaseReport) {
    super("dry run");
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface ReleaseOptions {
  readonly dryRun?: boolean;
  readonly offsets?: readonly OffsetRow[];
  readonly seed?: SeedData;
  readonly now?: () => Date;
  /** Emails in error messages unmasked (SR-4). */
  readonly showEmails?: boolean;
}

type Tx = Prisma.TransactionClient;

export async function runAccountingRelease(options: ReleaseOptions = {}): Promise<ReleaseReport> {
  const seed = options.seed ?? parseSeed(JSON.parse(readFileSync(DEFAULT_SEED_PATH, "utf8")));
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('accounting-release'))`;
        const alreadyReleased = await isAccountingReleased(tx);
        const seeded = await seedCatalog(tx, seed);
        const offsets = await applyOffsets(tx, options.offsets ?? [], options.showEmails === true);
        const backfill = await backfillLegacyLines(tx);
        let markerWritten = false;
        if (!alreadyReleased) {
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
          seeded,
          offsets,
          numbered: backfill.numbered,
          lines: backfill.lines,
          unclassified: backfill.lines.filter((l) => l.missing.length > 0),
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

// ── 1. Seed ──────────────────────────────────────────────────────────────────

async function seedCatalog(tx: Tx, seed: SeedData): Promise<ReleaseReport["seeded"]> {
  const out = {
    ledgerAccounts: [] as string[],
    vatCodes: [] as string[],
    typeDefaults: [] as string[],
    foreignCurrencyVatCode: null as string | null,
    warnings: [] as string[],
  };
  const actor = { createdByUserId: SEED_ACTOR.userId, createdByEmail: SEED_ACTOR.email };

  for (const account of seed.ledgerAccounts) {
    const exists = await tx.ledgerAccount.findUnique({
      where: { entity_number: { entity: CATALOG_ENTITY, number: account.number } },
      select: { id: true },
    });
    if (exists) continue;
    await tx.ledgerAccount.create({ data: { entity: CATALOG_ENTITY, number: account.number, name: account.name, ...actor } });
    out.ledgerAccounts.push(account.number);
  }
  for (const vat of seed.vatCodes) {
    const code = vat.code.toUpperCase();
    const exists = await tx.vatCode.findUnique({
      where: { entity_code: { entity: CATALOG_ENTITY, code } },
      select: { id: true },
    });
    if (exists) continue;
    await tx.vatCode.create({
      data: { entity: CATALOG_ENTITY, code, label: vat.label, rateBasisPoints: percentToBasisPoints(vat.ratePercent), ...actor },
    });
    out.vatCodes.push(code);
  }

  const accountIds = new Map(
    (await tx.ledgerAccount.findMany({ where: { entity: CATALOG_ENTITY }, select: { id: true, number: true } })).map((a) => [a.number, a.id]),
  );
  const vatIds = new Map(
    (await tx.vatCode.findMany({ where: { entity: CATALOG_ENTITY }, select: { id: true, code: true } })).map((v) => [v.code, v.id]),
  );
  const accountActive = await loadActiveFlags(tx, "ledger_account", [...accountIds.values()]);
  const vatActive = await loadActiveFlags(tx, "vat_code", [...vatIds.values()]);
  const usableAccount = (number: string | null, type: string): string | null => {
    if (number === null) return null;
    const id = accountIds.get(number);
    if (id === undefined || accountActive.get(id) === false) {
      out.warnings.push(`${type}: account ${number} is ${id === undefined ? "missing" : "deactivated"}, no default account seeded`);
      return null;
    }
    return id;
  };
  const usableVat = (code: string | null, what: string): string | null => {
    if (code === null) return null;
    const id = vatIds.get(code.toUpperCase());
    if (id === undefined || vatActive.get(id) === false) {
      out.warnings.push(`${what}: VAT code ${code} is ${id === undefined ? "missing" : "deactivated"}, none seeded`);
      return null;
    }
    return id;
  };

  const base = Date.now();
  let tick = 0;
  for (const type of Object.values(ExpenseType)) {
    const entry = seed.typeDefaults[type];
    if (!entry) continue;
    const existing = await tx.expenseTypeDefault.count({ where: { entity: CATALOG_ENTITY, type } });
    if (existing > 0) continue; // an admin's choice, even an explicit "none", is never overridden
    const ledgerAccountId = usableAccount(entry.ledgerAccount, type);
    const vatCodeId = usableVat(entry.vatCode, type);
    if (ledgerAccountId === null && vatCodeId === null) continue;
    await tx.expenseTypeDefault.create({
      data: { entity: CATALOG_ENTITY, type, ledgerAccountId, vatCodeId, createdAt: new Date(base + tick++), ...actor },
    });
    out.typeDefaults.push(type);
  }

  if (seed.foreignCurrencyVatCode !== null) {
    const designations = await tx.refundSetting.count({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } });
    if (designations === 0) {
      const id = usableVat(seed.foreignCurrencyVatCode, "foreign-currency VAT code");
      if (id !== null) {
        await tx.refundSetting.create({
          data: { key: FOREIGN_CURRENCY_VAT_CODE_KEY, value: id, ...actor },
        });
        out.foreignCurrencyVatCode = seed.foreignCurrencyVatCode.toUpperCase();
      }
    }
  }
  return out;
}

// ── 2. Offsets ───────────────────────────────────────────────────────────────

async function applyOffsets(tx: Tx, offsets: readonly OffsetRow[], showEmails: boolean): Promise<ReleaseReport["offsets"]> {
  const out: ReleaseReport["offsets"] = [];
  for (const offset of offsets) {
    const who = showEmails ? offset.email : maskEmail(offset.email);
    const owners = await tx.refundRequest.findMany({
      where: { ownerEmail: { equals: offset.email, mode: "insensitive" } },
      distinct: ["ownerUserId"],
      orderBy: { createdAt: "desc" },
      select: { ownerUserId: true, ownerName: true, ownerEmail: true },
    });
    if (owners.length === 0) {
      throw new ReleaseError(
        "offset_unknown_employee",
        `offsets: ${who} has no refund request, so the employee cannot be identified. Remove the row, or run the release after their first request.`,
      );
    }
    if (owners.length > 1) {
      throw new ReleaseError("offset_ambiguous_employee", `offsets: ${who} belongs to more than one user id`);
    }
    const ownerUserId = owners[0]!.ownerUserId;
    const employeeRefOfOffset = employeeRef(initials(owners[0]!.ownerName, owners[0]!.ownerEmail), ownerUserId);
    const counter = await tx.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId, year: offset.year } } });
    if (counter) {
      const same =
        counter.startAfter === offset.lastIssuedSeq && counter.lastSeq === offset.lastIssuedSeq && counter.startAfterSetBy !== null;
      if (same) {
        out.push({ ...offset, employeeRef: employeeRefOfOffset, outcome: "already-applied" });
        continue;
      }
      throw new ReleaseError(
        "offset_pair_has_numbers",
        `offsets: ${who} already has receipt numbers for ${offset.year} (last ${counter.lastSeq}); an offset can only be loaded before the first one`,
      );
    }
    const numbered = await tx.refundLine.count({ where: { receiptOwnerUserId: ownerUserId, receiptYear: offset.year } });
    if (numbered > 0) {
      throw new ReleaseError("offset_pair_has_numbers", `offsets: ${who} already has receipt numbers for ${offset.year}`);
    }
    await tx.receiptCounter.create({
      data: {
        ownerUserId,
        year: offset.year,
        lastSeq: offset.lastIssuedSeq,
        startAfter: offset.lastIssuedSeq,
        startAfterSetBy: RELEASE_ACTOR.userId,
      },
    });
    out.push({ ...offset, employeeRef: employeeRefOfOffset, outcome: "applied" });
  }
  return out;
}

// ── 3. Backfill ──────────────────────────────────────────────────────────────

async function backfillLegacyLines(tx: Tx): Promise<{
  numbered: ReleaseReport["numbered"];
  lines: ReleaseLineReport[];
  itLinesLeftUnnumbered: number;
}> {
  const candidates = await tx.refundLine.findMany({
    where: {
      entity: "welld_ch",
      rejectionReason: null,
      receiptNumber: null,
      request: { status: { in: ["approved", "paid"] } },
    },
    select: { requestId: true },
    distinct: ["requestId"],
  });
  const requests = await tx.refundRequest.findMany({
    where: { id: { in: candidates.map((c) => c.requestId) } },
    select: { id: true, ownerUserId: true, ownerEmail: true, ownerName: true, submittedAt: true, createdAt: true },
  });
  const byOwner = new Map<string, typeof requests>();
  for (const request of requests) byOwner.set(request.ownerUserId, [...(byOwner.get(request.ownerUserId) ?? []), request]);

  const snapshot = await loadDefaultsSnapshot(tx);
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
      snapshot,
      entities: ["welld_ch"],
    });
    if (!result.ok) throw new Error("classifyAndNumber refused a release call"); // unreachable: only `approval` refuses

    const details = await tx.refundLine.findMany({
      where: { id: { in: result.lines.map((l) => l.lineId) } },
      select: {
        id: true,
        date: true,
        type: true,
        currency: true,
        ledgerAccount: { select: { number: true } },
        vatCode: { select: { code: true } },
      },
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
        account: d.ledgerAccount?.number ?? null,
        vatCode: d.vatCode?.code ?? null,
        missing: numbered.missing ?? [],
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

  const itLinesLeftUnnumbered = await tx.refundLine.count({
    where: {
      entity: "welld_it",
      rejectionReason: null,
      receiptNumber: null,
      request: { status: { in: ["approved", "paid"] } },
    },
  });
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
  if (report.alreadyReleased) out.push("The release marker was already set: this run only completed what was left.");
  const s = report.seeded;
  out.push(
    "",
    "Seed",
    `  ledger accounts added (${s.ledgerAccounts.length}): ${s.ledgerAccounts.join(", ") || "none, all existed"}`,
    `  VAT codes added (${s.vatCodes.length}): ${s.vatCodes.join(", ") || "none, all existed"}`,
    `  type defaults set (${s.typeDefaults.length}): ${s.typeDefaults.join(", ") || "none"}`,
    `  foreign-currency VAT code designated: ${s.foreignCurrencyVatCode ?? "no (already designated, or none seeded)"}`,
    ...s.warnings.map((w) => `  WARNING: ${w}`),
    "",
    `Offsets (${report.offsets.length})`,
    ...report.offsets.map(
      (o) => `  ${options.showEmails === true ? o.email : o.employeeRef} ${o.year}: numbering continues after ${o.lastIssuedSeq} (${o.outcome})`,
    ),
    "",
    `Numbered legacy WellD CH lines (${report.lines.length})`,
    ...report.numbered.map((n) => `  ${who(n)} ${n.year}: ${n.count} lines, ${n.first} to ${n.last}`),
    "",
    `Left unclassified, account or VAT code missing (${report.unclassified.length})`,
    ...report.unclassified.map(
      (l) => `  ${l.receiptNumber} ${who(l)} ${l.date} ${l.type} ${l.currency}: missing ${l.missing.join(" and ")} (line ${l.lineId})`,
    ),
    "",
    `WellD Italia lines of approved or paid requests left without a number: ${report.itLinesLeftUnnumbered}`,
    // D-1: `markerWritten` means "would be written" in a dry run, and a dry run writes nothing: say so.
    `Release marker written: ${
      !report.markerWritten ? "no (already set)" : report.dryRun ? "no (dry run: the real run would write it)" : "yes"
    }`,
  );
  if (report.dryRun) {
    out.push("", "Every line (receipt number, date, type, currency, account, VAT code)");
    for (const l of report.lines) {
      out.push(`  ${l.receiptNumber}  ${l.date}  ${l.type}  ${l.currency}  ${l.account ?? "-"}  ${l.vatCode ?? "-"}  ${who(l)}`);
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
  const seedPath = take("--seed");
  const known = new Set(["--dry-run", "--show-emails", "--offsets", "--seed", ...(offsetsPath ? [offsetsPath] : []), ...(seedPath ? [seedPath] : [])]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new ReleaseError(
      "usage",
      `unknown argument ${unknown[0]}. Usage: bun run accounting:release [--dry-run] [--offsets <csv>] [--seed <json>] [--show-emails]`,
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
    ...(seedPath ? { seed: parseSeed(JSON.parse(readFileSync(seedPath, "utf8"))) } : {}),
  });
  console.log(formatReport(report, { showEmails }));
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .catch((error) => {
      console.error(`accounting:release failed, nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
