/**
 * Data access and decisions of the accounting export (T18, specs/20261118-refund-accounting-export; reworked by T21,
 * specs/20261119-accounting; AC-4.6, AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.8, AC-6.9, AC-6.10, AC-6.12, AC-7.2 of 20261118 and
 * AC-5.3 to AC-5.6, AC-6.6, AC-6.7, AC-7.2, AC-7.3 here; ADR 20261118-the-accounting-export-is-generated-on-request-never-
 * stored-and-logged-append-only-with-its-content-hash-and-format-version, ADR 20261119-accounting-reference-data-belongs-to-
 * accounting-api-...).
 *
 * `prepareExport` is the ONE computation behind both routes: the summary (`GET …/accounting-export`) and the file
 * (`GET …/accounting-export/csv`) call it, so what the page is told and what the file contains cannot disagree. It writes
 * nothing; only `exportBatchCsv` does, and only the CSV route calls it.
 *
 * Where the rows come from
 * - The batch's `RefundBatchItem`s (the append-only membership), never the live `RefundRequest.batchId`, so a batch is read the
 *   same way whatever happened to its requests since. A `discarded` batch is refused before anything else is computed (AC-6.9).
 * - One row per approved, NOT rejected WellD CH line (AC-6.1). WellD Italia lines are not rows; the approved, not rejected ones
 *   are counted as `excludedLineCount` (AC-6.6), so the screen can say how many were left out. A rejected line of either entity
 *   is neither a row nor counted: it was never going to be booked or paid.
 *
 * What the file is built from: COPIES (AC-5.3, AC-5.4). The line holds what it books: the account's number and name, the VAT
 * code and its rate, and (a foreign-currency line) the exchange rate with its month. A batch whose lines all hold their copies
 * is exported with NO call to Accounting, while Accounting is unreachable, and twice gives the same bytes whatever changed in
 * Accounting between the two (AC-5.4). CHF and VAT amounts are derived on read from `fxRateMicros` and `vatRateBasisPoints`
 * (`amounts.ts`), so the export agrees with the review view to the cent (AC-5.5: copied at 0.9246, Accounting now at 0.9300,
 * the file says `10.40;0.9246;9.62`).
 *
 * How a line is classified here (BINDING, as T13/T14 and the header of `classification.repo.ts`): a batch holds only `approved`
 * and `paid` requests, whose classification is FROZEN, so it is read STORED-ONLY: `resolveClassification` with EMPTY defaults and
 * NO snapshot. A half the approval or the release could not resolve (AC-7.2) stays missing and blocks the export until accounting
 * sets it (AC-3.6); a default added next month never silently classifies a booked line. This is exactly what the review view
 * shows, so the export and the screen agree. A stored entry deactivated since is kept (AC-1.4 of 20261118, AC-5.3).
 *
 * Rate pending (AC-5.6). A foreign-currency row with no `fxRateMicros` waits for its rate. Only then does the export ask
 * Accounting, once, for the rates in effect of the distinct (currency, expense month) pairs of those rows; with none pending it
 * asks nothing. The answer, per pair, is the rate in effect, or why there is none (G7, `reason`); `fetchAttempted` is true when
 * Accounting says it asked its official source for any of them (G10). The file is produced only when every pending row has a
 * rate; the CSV route then copies them inside its transaction (`rateCopy.repo.ts`).
 *
 * Blockers (all-or-nothing, ADR decision 4): Accounting cannot be read while a row waits for its rate (`accountingUnavailable`,
 * AC-6.6: NOT a missing rate, `missingRates` is then empty); a (currency, month) with no rate in effect, with its reason
 * (AC-6.7); a row with no account or no VAT code (AC-7.2); a row with no receipt number (cannot happen after the release).
 */

import { createHash } from "node:crypto";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  accountingPort,
  AccountingUnavailableError,
  ratePairKey,
  type AccountingPort,
  type RatePair,
} from "./accountingClient";
import type { RatePairWire, WireRateCurrency } from "./accountingWire";
import { classifiableInput, monthOf, resolveClassification } from "./classification";
import { compareCodePoints, employeeCell, buildAccountingCsv, type AccountingCsv, type AccountingExportLine } from "./export";
import type { ExportBlockers, ExportSummary } from "./export.schemas";
import { FORMAT_VERSION } from "./exportFormat";
import { copyPendingRates, type PendingRateCopy } from "./rateCopy.repo";
import { UNVERIFIED_SNAPSHOT } from "./referenceSnapshot";

type Client = Prisma.TransactionClient;

// ─── Reading the batch ───────────────────────────────────────────────────────

const exportLineSelect = {
  id: true,
  date: true,
  type: true,
  entity: true,
  currency: true,
  motivo: true,
  km: true,
  requestedAmountCents: true,
  approvedTotalCents: true,
  rejectionReason: true,
  receiptNumber: true,
  receiptYear: true,
  receiptSeq: true,
  createdAt: true,
  // The copies (T16): what the line books. The old foreign keys are never read.
  accountNumber: true,
  accountName: true,
  ledgerAccountIsDefault: true,
  vatCodeCopy: true,
  vatRateBasisPoints: true,
  vatCodeIsDefault: true,
  fxRateMicros: true,
  fxRateMonth: true,
} satisfies Prisma.RefundLineSelect;

const exportItemSelect = {
  request: {
    select: {
      id: true,
      ownerUserId: true,
      ownerEmail: true,
      ownerName: true,
      lines: { select: exportLineSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  },
} satisfies Prisma.RefundBatchItemSelect;

type ItemRow = Prisma.RefundBatchItemGetPayload<{ select: typeof exportItemSelect }>;
type SourceLineRow = ItemRow["request"]["lines"][number];

interface SourceLine {
  readonly line: SourceLineRow;
  readonly requestId: string;
  readonly ownerUserId: string;
  readonly ownerName: string | null;
  readonly ownerEmail: string;
}

export interface ExportSource {
  readonly batch: { readonly id: string; readonly status: "compiled" | "paid" | "discarded"; readonly cutoff: Date };
  /** Approved, not rejected WellD CH lines: the rows of the file. */
  readonly rows: readonly SourceLine[];
  /** Approved, not rejected WellD Italia lines: left out of the file and counted. */
  readonly excludedLineCount: number;
}

/** The batch with its member requests' lines, split into rows and the excluded count; `null` when there is no such batch. */
export async function loadExportSource(batchId: string, client: Client = db): Promise<ExportSource | null> {
  const batch = await client.refundBatch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, cutoff: true },
  });
  if (!batch) return null;
  const items = await client.refundBatchItem.findMany({ where: { batchId }, select: exportItemSelect });

  const rows: SourceLine[] = [];
  let excludedLineCount = 0;
  for (const { request } of items) {
    for (const line of request.lines) {
      if (line.rejectionReason !== null) continue;
      if (line.entity === "welld_ch") {
        rows.push({
          line,
          requestId: request.id,
          ownerUserId: request.ownerUserId,
          ownerName: request.ownerName,
          ownerEmail: request.ownerEmail,
        });
      } else excludedLineCount++;
    }
  }
  return { batch, rows, excludedLineCount };
}

// ─── What Accounting said about the pending rates ────────────────────────────

/**
 * The one read of Accounting an export makes (or does not make):
 * - `none`: no row waits for a rate, so Accounting was not asked (AC-5.4);
 * - `unavailable`: Accounting could not be read, completely and cleanly (AC-6.6, AC-6.8);
 * - `answers`: the answer for each pending (currency, month) pair, and whether any was attempted at the source (G10).
 */
export type ExportRates =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "answers"; readonly byPair: ReadonlyMap<string, RatePairWire>; readonly attempted: boolean };

const isPending = (line: SourceLineRow): boolean => line.currency !== "CHF" && line.fxRateMicros === null;

const pairOf = (line: SourceLineRow): RatePair => ({ currency: line.currency as WireRateCurrency, month: monthOf(line.date) });

/** The distinct (currency, expense month) pairs of the rows that wait for a rate, in a stable order. */
export function pendingPairs(source: ExportSource): RatePair[] {
  const pairs = new Map<string, RatePair>();
  for (const { line } of source.rows) {
    if (!isPending(line)) continue;
    const pair = pairOf(line);
    pairs.set(ratePairKey(pair), pair);
  }
  return [...pairs.values()].sort((a, b) => compareCodePoints(a.month, b.month) || compareCodePoints(a.currency, b.currency));
}

/**
 * Asks Accounting for the pending pairs: one operation, one deadline. Anything but a clean, complete answer is `unavailable`
 * (never a stale or a guessed rate); any other failure is a bug and propagates.
 */
export async function readPendingRates(source: ExportSource, accounting: AccountingPort): Promise<ExportRates> {
  const pairs = pendingPairs(source);
  if (pairs.length === 0) return { kind: "none" };
  try {
    const answers = await accounting.begin("export").rates(pairs, "welld_ch");
    return {
      kind: "answers",
      byPair: new Map(answers.map((answer) => [ratePairKey(answer), answer] as const)),
      attempted: answers.some((answer) => answer.attempted),
    };
  } catch (error) {
    if (error instanceof AccountingUnavailableError) return { kind: "unavailable" };
    throw error;
  }
}

// ─── The evaluation (pure) ───────────────────────────────────────────────────

/** The summary without `viewer`: that is the caller's permissions, not the batch's data. */
export type ExportEvaluation = Omit<ExportSummary, "viewer">;

export interface Evaluated {
  readonly summary: ExportEvaluation;
  /** The lines of the file; empty unless `summary.exportable`. */
  readonly lines: readonly AccountingExportLine[];
  /** The rates to copy onto the pending rows when the file is produced; empty unless `summary.exportable`. */
  readonly copies: readonly PendingRateCopy[];
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Employee, then date, then line id: a stable order for blockers, which have no receipt number to sort by. */
const compareBlocked = (
  a: { employee: string; date: string; lineId: string },
  b: { employee: string; date: string; lineId: string },
): number =>
  compareCodePoints(a.employee, b.employee) || compareCodePoints(a.date, b.date) || compareCodePoints(a.lineId, b.lineId);

/**
 * Everything the two routes need to know about one batch, from what was read: classifies every row from its copies, decides the
 * rate of every foreign-currency row (its copy, or the rate in effect that this export would copy) and lists what blocks.
 *
 * `copiesOnly` is for the export transaction, after the copies were written: a row that still waits for its rate then is a
 * programming error, never a rate to take from the answer, so the file can only ever be built from copies.
 */
export function evaluateExport(source: ExportSource, rates: ExportRates, options: { copiesOnly?: boolean } = {}): Evaluated {
  const missingRates = new Map<string, ExportBlockers["missingRates"][number]>();
  const unclassified: (ExportBlockers["unclassifiedLines"][number] & { employee: string })[] = [];
  const unnumbered: ExportBlockers["unnumberedLines"] = [];
  const lines: AccountingExportLine[] = [];
  const copies: PendingRateCopy[] = [];
  let ratePendingLineCount = 0;
  let waitsForAccounting = false;

  for (const src of source.rows) {
    const { line } = src;
    const employee = employeeCell(src);
    const date = isoDate(line.date);

    // Stored only: no defaults, no snapshot (see the header).
    const classification = resolveClassification(classifiableInput(line), {}, null, UNVERIFIED_SNAPSHOT);
    const missing = classification?.missing ?? (["account", "vatCode"] as const);
    if (missing.length > 0) {
      unclassified.push({
        lineId: line.id,
        requestId: src.requestId,
        date,
        type: line.type,
        employee,
        receiptNumber: line.receiptNumber,
        missing: [...missing],
      });
    }

    if (line.receiptNumber === null || line.receiptYear === null || line.receiptSeq === null) {
      unnumbered.push({ lineId: line.id, requestId: src.requestId, employee });
    }

    // The rate of a foreign-currency row: its own copy, else the rate in effect that the export would copy (AC-5.6).
    let rateMicros: number | null = null;
    if (line.currency !== "CHF") {
      if (line.fxRateMicros !== null) {
        rateMicros = line.fxRateMicros;
      } else {
        ratePendingLineCount++;
        if (options.copiesOnly === true) throw new Error(`line ${line.id} still waits for its exchange rate inside the export`);
        const pair = pairOf(line);
        if (rates.kind === "answers") {
          const answer = rates.byPair.get(ratePairKey(pair));
          if (answer?.status === "in_effect") {
            rateMicros = answer.rateMicros;
            copies.push({
              lineId: line.id,
              requestId: src.requestId,
              currency: line.currency,
              month: pair.month,
              rateMicros: answer.rateMicros,
            });
          } else {
            // `missing`, or (cannot happen: the client refuses an answer that skips a pair) no answer at all.
            missingRates.set(ratePairKey(pair), {
              currency: pair.currency,
              month: pair.month,
              reason: answer?.status === "missing" ? answer.reason : "fetch_failed",
            });
          }
        } else {
          // Accounting was not read: it is "cannot be read", never "no rate" (AC-6.6).
          waitsForAccounting = true;
        }
      }
    }

    if (
      classification?.bookable.account &&
      classification.bookable.vatCode &&
      line.receiptNumber !== null &&
      line.receiptYear !== null &&
      line.receiptSeq !== null &&
      (line.currency === "CHF" || rateMicros !== null)
    ) {
      lines.push({
        lineId: line.id,
        ownerUserId: src.ownerUserId,
        ownerName: src.ownerName,
        ownerEmail: src.ownerEmail,
        receiptNumber: line.receiptNumber,
        receiptYear: line.receiptYear,
        receiptSeq: line.receiptSeq,
        date,
        type: line.type,
        motivo: line.motivo,
        km: line.km,
        currency: line.currency,
        // The same figure the accounting view shows (`amountCents`); an approved line always has its approved total.
        approvedCents: line.approvedTotalCents ?? line.requestedAmountCents,
        rateMicros,
        accountNumber: classification.bookable.account.number,
        accountName: classification.bookable.account.name,
        vatCode: classification.bookable.vatCode.code,
        vatRateBasisPoints: classification.bookable.vatCode.rateBasisPoints,
        batchId: source.batch.id,
      });
    }
  }

  const blockers: ExportBlockers = {
    missingRates: [...missingRates.values()].sort(
      (a, b) => compareCodePoints(a.month, b.month) || compareCodePoints(a.currency, b.currency),
    ),
    unclassifiedLines: unclassified.sort(compareBlocked),
    unnumberedLines: unnumbered.sort((a, b) => compareCodePoints(a.employee, b.employee) || compareCodePoints(a.lineId, b.lineId)),
    accountingUnavailable: waitsForAccounting,
  };
  const exportable =
    blockers.missingRates.length === 0 &&
    blockers.unclassifiedLines.length === 0 &&
    blockers.unnumberedLines.length === 0 &&
    !blockers.accountingUnavailable;

  return {
    summary: {
      batchId: source.batch.id,
      batchStatus: source.batch.status === "paid" ? "paid" : "compiled",
      exportable,
      rowCount: source.rows.length,
      excludedLineCount: source.excludedLineCount,
      ratePendingLineCount,
      blockers,
      fetchAttempted: rates.kind === "answers" && rates.attempted,
    },
    lines: exportable ? lines : [],
    copies: exportable ? copies : [],
  };
}

// ─── The computation ─────────────────────────────────────────────────────────

export type ExportComputation =
  | { readonly kind: "not_found" }
  /** A discarded batch has no export (AC-6.9). */
  | { readonly kind: "discarded" }
  | {
      readonly kind: "ready";
      readonly summary: ExportEvaluation;
      readonly batch: { readonly id: string; readonly cutoff: Date };
      /** The lines of the file; empty unless `summary.exportable`. */
      readonly lines: readonly AccountingExportLine[];
      readonly copies: readonly PendingRateCopy[];
      /** What Accounting said, kept so the export transaction evaluates the re-read lines against the same answers. */
      readonly rates: ExportRates;
    };

/**
 * Loads the batch, reads Accounting if (and only if) a row waits for its rate, and evaluates. Writes nothing. `accounting`
 * defaults to the port every route reads through.
 */
export async function prepareExport(
  batchId: string,
  accounting: AccountingPort = accountingPort(),
  client: Client = db,
): Promise<ExportComputation> {
  const source = await loadExportSource(batchId, client);
  if (!source) return { kind: "not_found" };
  if (source.batch.status === "discarded") return { kind: "discarded" };
  const rates = await readPendingRates(source, accounting);
  const evaluated = evaluateExport(source, rates);
  return {
    kind: "ready",
    batch: { id: source.batch.id, cutoff: source.batch.cutoff },
    summary: evaluated.summary,
    lines: evaluated.lines,
    copies: evaluated.copies,
    rates,
  };
}

// ─── The export ──────────────────────────────────────────────────────────────

export interface ExportActor {
  readonly userId: string;
  readonly email: string;
}

export type ExportOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "discarded" }
  /** Something blocks the file: the summary is the refusal's body (G10). Nothing was copied, nothing was logged. */
  | { readonly kind: "blocked"; readonly summary: ExportEvaluation }
  | {
      readonly kind: "exported";
      readonly csv: AccountingCsv;
      readonly sha256: string;
      readonly summary: ExportEvaluation;
      readonly batch: { readonly id: string; readonly cutoff: Date };
      /** The rate copies this export wrote (the pending lines it was first to copy). */
      readonly copied: readonly PendingRateCopy[];
    };

/** Thrown inside the export transaction to roll it back with a refusal that is an answer, not an error. */
class ExportRefused extends Error {
  constructor(readonly outcome: Exclude<ExportOutcome, { kind: "exported" }>) {
    super("export refused");
  }
}

/**
 * The file of a batch, or why there is none.
 *
 * Accounting is read BEFORE the transaction (no lock is held across an HTTP call). Then ONE transaction:
 * 1. lock the pending lines `FOR UPDATE` and copy their rate, first writer wins, audit `line_rate_copied` with the exporter
 *    (`copyPendingRates`);
 * 2. re-read the batch and evaluate it again against the same answers: the file is built from what the lines hold NOW, so a
 *    concurrent export's copy is the one both files carry, and a batch discarded or changed in between is refused here;
 * 3. build the CSV, write the export-log row;
 * 4. commit. The caller sends the bytes only after this returns.
 *
 * A refusal at step 2, a failed log write or a failed commit leaves the lines exactly as they were: a refused export copies
 * nothing to any line (AC-5.6), and no file leaves without its log row (AC-6.10).
 */
export async function exportBatchCsv(
  batchId: string,
  actor: ExportActor,
  accounting: AccountingPort = accountingPort(),
): Promise<ExportOutcome> {
  const first = await prepareExport(batchId, accounting);
  if (first.kind !== "ready") return first;
  if (!first.summary.exportable) return { kind: "blocked", summary: first.summary };

  try {
    return await db.$transaction(async (tx): Promise<ExportOutcome> => {
      const copied = await copyPendingRates(tx, first.copies, actor, batchId);

      const source = await loadExportSource(batchId, tx);
      if (!source) throw new ExportRefused({ kind: "not_found" });
      if (source.batch.status === "discarded") throw new ExportRefused({ kind: "discarded" });
      const again = evaluateExport(source, first.rates, { copiesOnly: true });
      if (!again.summary.exportable) throw new ExportRefused({ kind: "blocked", summary: again.summary });

      const csv = buildAccountingCsv(again.lines);
      const sha256 = sha256Hex(csv.bytes);
      await recordExport(
        {
          batchId,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          rowCount: csv.rowCount,
          excludedLineCount: again.summary.excludedLineCount,
          contentSha256: sha256,
        },
        tx,
      );
      return {
        kind: "exported",
        csv,
        sha256,
        summary: again.summary,
        batch: { id: source.batch.id, cutoff: source.batch.cutoff },
        copied,
      };
    });
  } catch (error) {
    if (error instanceof ExportRefused) return error.outcome;
    throw error;
  }
}

// ─── The log ─────────────────────────────────────────────────────────────────

/** SHA-256 of the bytes that leave, as lowercase hex: what the export log keeps instead of the file. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ExportLogEntry {
  readonly batchId: string;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly rowCount: number;
  readonly excludedLineCount: number;
  readonly contentSha256: string;
}

/**
 * Appends one `refund_batch_export` row (AC-6.10): who exported which batch, when, how many rows, the hash of the
 * bytes and the format version. Throws on failure, and the route then sends NO file (record, then deliver).
 */
export async function recordExport(entry: ExportLogEntry, client: Client = db): Promise<void> {
  await client.refundBatchExport.create({ data: { ...entry, formatVersion: FORMAT_VERSION } });
}
