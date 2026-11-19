/**
 * Data access and decisions of the accounting export (T18, specs/20261118-
 * refund-accounting-export; AC-4.6, AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.8,
 * AC-6.9, AC-6.10, AC-6.12, AC-7.2; ADR 20261118-the-accounting-export-is-
 * generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-
 * and-format-version).
 *
 * `computeExport` is the ONE computation behind both routes: the summary
 * (`GET …/accounting-export`) and the file (`GET …/accounting-export/csv`) call
 * it, so what the page is told and what the file contains cannot disagree. It
 * writes nothing; only `recordExport` does, and only the CSV route calls it.
 *
 * Where the rows come from
 * - The batch's `RefundBatchItem`s (the append-only membership), never the live
 *   `RefundRequest.batchId`, so a batch is read the same way whatever happened
 *   to its requests since. A `discarded` batch is refused before anything else
 *   is computed (AC-6.9).
 * - One row per approved, NOT rejected WellD CH line (AC-6.1). WellD Italia lines
 *   are not rows; the approved, not rejected ones are counted as
 *   `excludedLineCount` (AC-6.6), so the screen can say how many were left out.
 *   A rejected line of either entity is neither a row nor counted: it was never
 *   going to be booked or paid.
 *
 * How a line is classified here (BINDING, as T13/T14 and the header of
 * `classification.repo.ts`): a batch holds only `approved` and `paid` requests,
 * whose classification is FROZEN, so it is read STORED-ONLY: `resolveClassification`
 * with EMPTY defaults and NO foreign-currency VAT code. A half the approval or the
 * release could not resolve (AC-7.2) stays missing and blocks the export until
 * accounting sets it (AC-3.6); a default added next month never silently
 * classifies a booked line. This is exactly what the review view shows, so the
 * export and the screen agree. A stored entry deactivated since is kept (AC-1.3).
 *
 * Blockers (all-or-nothing, ADR decision 4): a missing exchange rate for the
 * (currency, month of the expense date) of a foreign-currency line (AC-6.5); a
 * line with no account or no VAT code (AC-7.2); a line with no receipt number
 * (cannot happen after the release). Before they are computed, the rates in
 * effect are completed ON DEMAND, once, bounded and in parallel by
 * `fx.ensureRates` (plan G6, 10 s budget); a slow or failing source ends as a
 * plain "missing rate" blocker, never as an error.
 */

import { createHash } from "node:crypto";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { dateToMonth, type RateCurrency, type RateEntry } from "../fx/fx.repo";
import { rateKey, type FxService } from "../fx/fx.service";
import { classifiableInput } from "./classification.repo";
import { resolveClassification } from "./classification";
import { loadActiveFlags } from "./catalog.repo";
import { compareCodePoints, employeeCell, type AccountingExportLine } from "./export";
import type { ExportBlockers, ExportSummary } from "./export.schemas";
import { FORMAT_VERSION } from "./exportFormat";

type Client = Prisma.TransactionClient;

/** What the export needs of the exchange-rate service: the real one in production, a fake in tests. */
export type ExportFxPort = Pick<FxService, "ensureRates" | "ratesInEffect">;

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
  ledgerAccountId: true,
  ledgerAccountIsDefault: true,
  vatCodeId: true,
  vatCodeIsDefault: true,
  ledgerAccount: { select: { id: true, number: true, name: true } },
  vatCode: { select: { id: true, code: true, label: true, rateBasisPoints: true } },
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

interface ExportSource {
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

// ─── The computation ─────────────────────────────────────────────────────────

export type ExportComputation =
  | { readonly kind: "not_found" }
  /** A discarded batch has no export (AC-6.9). */
  | { readonly kind: "discarded" }
  | {
      readonly kind: "ready";
      readonly summary: ExportSummary;
      readonly batch: { readonly id: string; readonly cutoff: Date };
      /** The lines of the file; empty unless `summary.exportable`. */
      readonly lines: readonly AccountingExportLine[];
    };

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Employee, then date, then line id: a stable order for blockers, which have no receipt number to sort by. */
const compareBlocked = (
  a: { employee: string; date: string; lineId: string },
  b: { employee: string; date: string; lineId: string },
): number =>
  compareCodePoints(a.employee, b.employee) || compareCodePoints(a.date, b.date) || compareCodePoints(a.lineId, b.lineId);

/**
 * Everything the two routes need to know about one batch. Asks the official
 * source for a missing rate first (through `fx.ensureRates`), then reads the
 * rates in effect, classifies every line and lists what blocks the export.
 */
export async function computeExport(
  batchId: string,
  actor: { readonly userId: string },
  fx: ExportFxPort,
  client: Client = db,
): Promise<ExportComputation> {
  const source = await loadExportSource(batchId, client);
  if (!source) return { kind: "not_found" };
  if (source.batch.status === "discarded") return { kind: "discarded" };
  const batchStatus = source.batch.status;

  // 1. The rates: complete the missing ones on demand, then read what is in effect.
  const needed = new Map<string, { currency: RateCurrency; month: string }>();
  for (const { line } of source.rows) {
    if (line.currency === "CHF") continue;
    const pair = { currency: line.currency as RateCurrency, month: dateToMonth(line.date) };
    needed.set(rateKey(pair.currency, pair.month), pair);
  }
  const pairs = [...needed.values()];
  let fetchAttempted = false;
  if (pairs.length > 0) {
    try {
      fetchAttempted = (await fx.ensureRates(pairs, "export", actor)).attempted;
    } catch (error) {
      // A failing source is a blocker, never a 5xx (ADR decision 8). Only the error NAME is logged: no body, no line data.
      console.error(`[accounting-export] on-demand rate fetch failed for batch ${batchId}:`, error instanceof Error ? error.name : "error");
      fetchAttempted = true;
    }
  }
  const rates: ReadonlyMap<string, RateEntry | null> =
    pairs.length > 0 ? await fx.ratesInEffect(pairs) : new Map<string, RateEntry | null>();

  // 2. The classification, stored-only (see the header): the entries' current `active` flags, no defaults.
  const accountFlags = await loadActiveFlags(
    client,
    "ledger_account",
    source.rows.flatMap(({ line }) => (line.ledgerAccountId ? [line.ledgerAccountId] : [])),
  );
  const vatFlags = await loadActiveFlags(
    client,
    "vat_code",
    source.rows.flatMap(({ line }) => (line.vatCodeId ? [line.vatCodeId] : [])),
  );

  const missingRates = new Map<string, { currency: RateCurrency; month: string }>();
  const unclassified: (ExportBlockers["unclassifiedLines"][number] & { employee: string })[] = [];
  const unnumbered: ExportBlockers["unnumberedLines"] = [];
  const lines: AccountingExportLine[] = [];

  for (const src of source.rows) {
    const { line } = src;
    const employee = employeeCell(src);
    const date = isoDate(line.date);

    const classification = resolveClassification(classifiableInput(line, accountFlags, vatFlags), {}, null);
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

    let rate: RateEntry | null = null;
    if (line.currency !== "CHF") {
      const pair = { currency: line.currency as RateCurrency, month: dateToMonth(line.date) };
      rate = rates.get(rateKey(pair.currency, pair.month)) ?? null;
      if (rate === null) missingRates.set(rateKey(pair.currency, pair.month), pair);
    }

    if (
      classification?.account &&
      classification.vatCode &&
      line.receiptNumber !== null &&
      line.receiptYear !== null &&
      line.receiptSeq !== null &&
      (line.currency === "CHF" || rate !== null)
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
        rateMicros: rate?.rateMicros ?? null,
        accountNumber: classification.account.number,
        accountName: classification.account.name,
        vatCode: classification.vatCode.code,
        vatRateBasisPoints: classification.vatCode.rateBasisPoints,
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
  };
  const exportable =
    blockers.missingRates.length === 0 && blockers.unclassifiedLines.length === 0 && blockers.unnumberedLines.length === 0;

  return {
    kind: "ready",
    batch: { id: source.batch.id, cutoff: source.batch.cutoff },
    summary: {
      batchId: source.batch.id,
      batchStatus,
      exportable,
      rowCount: source.rows.length,
      excludedLineCount: source.excludedLineCount,
      blockers,
      fetchAttempted,
    },
    lines: exportable ? lines : [],
  };
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
