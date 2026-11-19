/**
 * The pending exchange-rate copy of an export (specs/20261119-accounting T21; plan § Interaction flows 7, D12; AC-5.6, AC-5.3,
 * AC-5.7; ADR 20261119-accounting-reference-data-belongs-to-accounting-api-...).
 *
 * A foreign-currency WellD CH line approved while its expense month had no rate in effect is "rate pending": it holds no
 * `fx*` copy and shows no CHF and no VAT amount. The FIRST export of its batch that succeeds copies the rate in effect at that
 * moment onto the line, INSIDE the export transaction, and the audit trail records who exported (`line_rate_copied`, actor =
 * the exporter). From then on the line is as in AC-5.3: the copy is write-once (trigger `refund_line_accounting_guard`), so
 * whatever Accounting does afterwards, the line books the rate it was copied with.
 *
 * `copyPendingRates` runs INSIDE the caller's transaction and makes no call to Accounting: the caller read the rates before
 * opening it (no lock is held across an HTTP call, D11) and passes what it read. A refused or failed export rolls the caller's
 * transaction back, so it copies nothing and audits nothing.
 *
 * First writer wins. Two exports of one batch that evaluated the same pending line both arrive here with a rate; the lines are
 * locked `FOR UPDATE` in id order, and each is written with `UPDATE … WHERE "fxRateMicros" IS NULL`: the second export finds
 * the first one's copy (Postgres re-checks the predicate on the committed row after the lock wait), writes nothing and audits
 * nothing, and its file is built from the first one's copy, so both files are equal. A copy already there is never replaced.
 *

 * The audit row names the batch in its `detail` (plan § Audit detail v2), not in the `batchId` column, which stays for the
 * `batch_*` actions (AC-7.1 of 20260719).
 *
 * Only the three `fx*` columns are written, never the classification, the money, the status or the decision, so the paid-line
 * guard of the copies (IS-1) has nothing to refuse: a pending line of a PAID batch is copied at its first export too (AC-5.3).
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { writeAuditEntry, type LineRateCopiedDetail } from "../requests/audit";
import { monthStart } from "./classification";

/** A rate to copy onto one pending line: the answer Accounting gave for the line's (currency, expense month). */
export interface PendingRateCopy {
  readonly lineId: string;
  readonly requestId: string;
  readonly currency: string;
  /** `YYYY-MM`, the month of the line's expense date. */
  readonly month: string;
  /** CHF per 1 unit of `currency`, times 1e6 (Accounting's wire range: 1..999_999_999). */
  readonly rateMicros: number;
}

export interface RateCopier {
  readonly userId: string;
  readonly email: string;
}

/**
 * Copies each rate onto its line unless the line already holds one, and audits the copies it wrote. Returns exactly those
 * (a line copied by a concurrent export is not in the result and is not audited a second time).
 */
export async function copyPendingRates(
  tx: Prisma.TransactionClient,
  copies: readonly PendingRateCopy[],
  by: RateCopier,
  batchId: string,
  at: Date = new Date(),
): Promise<PendingRateCopy[]> {
  if (copies.length === 0) return [];
  const ordered = [...copies].sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  await tx.$queryRaw`
    SELECT "id" FROM "refund_line" WHERE "id" = ANY(${ordered.map((c) => c.lineId)}::text[]) ORDER BY "id" FOR UPDATE`;

  const written: PendingRateCopy[] = [];
  for (const copy of ordered) {
    const result = await tx.refundLine.updateMany({
      where: { id: copy.lineId, fxRateMicros: null },
      data: { fxRateMicros: copy.rateMicros, fxRateMonth: monthStart(copy.month), fxRateCopiedAt: at },
    });
    if (result.count !== 1) continue;
    const detail: LineRateCopiedDetail = {
      v: 2,
      cause: "export",
      batchId,
      rateMicros: copy.rateMicros,
      month: copy.month,
      currency: copy.currency,
    };
    await writeAuditEntry(tx, {
      requestId: copy.requestId,
      lineId: copy.lineId,
      actorUserId: by.userId,
      actorEmail: by.email,
      action: "line_rate_copied",
      detail: detail as unknown as Record<string, unknown>,
    });
    written.push(copy);
  }
  return written;
}
