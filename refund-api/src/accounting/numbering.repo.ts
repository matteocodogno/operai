/**
 * `classifyAndNumber`: the one place a line's classification is frozen and its
 * receipt number issued (T8, specs/20261118-refund-accounting-export; AC-3.5,
 * AC-4.3, AC-4.4, AC-4.5, AC-4.7, AC-4.10; ADR
 * 20261118-accounting-classification-is-live-until-approval-then-frozen-...,
 * ADR 20261118-receipt-numbers-come-from-a-row-locked-per-employee-and-year-
 * counter-inside-the-approval-transaction-...).
 *
 * Used by the approve transaction (T12, `cause: "approval"`) and by the release
 * script (T11, `cause: "release"`). It always runs INSIDE the caller's
 * transaction: a rollback of the caller takes the counters, the numbers, the
 * frozen classification and the audit rows with it, so a refused or failed
 * approval consumes no number (AC-4.3).
 *
 * What it does, in this order
 * 1. Locks the candidate lines (`FOR UPDATE`, by id) and re-reads them, so a
 *    line numbered by someone else a moment ago is skipped, never numbered twice.
 * 2. Resolves every WellD CH line through `resolveClassification`, the same
 *    function the review view and the export use. With `cause: "approval"` a
 *    line that lacks an account or a VAT code REFUSES the whole call, before
 *    anything is written (AC-3.4). With `cause: "release"` such a line is
 *    still numbered and gets whatever half did resolve, the missing half stays
 *    empty and shows up as an export blocker (AC-7.2).
 * 3. Takes the per-(employee, year) counters, years ascending (the lock order
 *    that rules out a deadlock between two approvals of the same employee),
 *    each with ONE upsert that adds the number of lines of that year and
 *    returns the new `lastSeq`; the row stays locked until the caller commits
 *    (AC-4.10).
 * 4. Writes each line in ONE `UPDATE`: the classification and the receipt
 *    columns together. The database guard `refund_line_accounting_guard` locks
 *    the classification of a paid request only once the line has a receipt
 *    number, so the classification must never be written after the number in a
 *    separate statement (plan IS-1): on a legacy line of a paid request that
 *    second statement would be refused.
 * 5. Audits: `line_classified` (WellD CH lines) and `receipt_number_assigned`.
 *
 * Numbering order is the expense date, then the line's `createdAt`, then its id
 * (AC-4.4), across all the lines of one call. Lines of two years are numbered
 * in two independent sequences (AC-4.5). WellD Italia lines are numbered like
 * any other (AC-4.1) but never classified (AC-3.9); a rejected line is neither.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import type { Entity, ExpenseType } from "../lib/generated/prisma/enums";
import { writeAuditEntry } from "../requests/audit";
import { loadActiveFlags } from "./catalog.repo";
import {
  resolveClassification,
  type AccountRef,
  type Classification,
  type MissingPart,
  type TypeDefaultsByType,
  type VatCodeRef,
} from "./classification";
import { formatReceiptNumber, initials } from "./receiptNumber";

/** The live defaults a classification is resolved against: the type defaults and the foreign-currency VAT code, each with its current `active`. */
export interface DefaultsSnapshot {
  readonly defaults: TypeDefaultsByType;
  readonly foreignCurrencyVatCode: VatCodeRef | null;
}

export type NumberingCause = "approval" | "release";

export interface Actor {
  readonly userId: string;
  readonly email: string;
}

export interface ClassifyAndNumberInput {
  /** Every request must belong to this employee: the counters are per employee. */
  readonly owner: { readonly userId: string; readonly name: string | null; readonly email: string };
  /** The requests whose unnumbered, non-rejected lines are to be handled (one for an approval, several for a release). */
  readonly requestIds: readonly string[];
  readonly cause: NumberingCause;
  readonly actor: Actor;
  readonly snapshot: DefaultsSnapshot;
  /** Only lines of these entities are handled; the release script passes `["welld_ch"]` (AC-7.3). Default: all. */
  readonly entities?: readonly Entity[];
}

export interface MissingLine {
  readonly lineId: string;
  readonly requestId: string;
  /** `YYYY-MM-DD` */
  readonly date: string;
  readonly type: ExpenseType;
  readonly missing: readonly MissingPart[];
}

export interface NumberedLine {
  readonly lineId: string;
  readonly requestId: string;
  readonly entity: Entity;
  readonly receiptNumber: string;
  readonly year: number;
  readonly seq: number;
  /** `null` for a WellD Italia line. `missing` is empty when the line is fully classified. */
  readonly missing: readonly MissingPart[] | null;
}

export type ClassifyAndNumberResult =
  | { readonly ok: true; readonly lines: readonly NumberedLine[] }
  /** `cause: "approval"` only: nothing was written. */
  | { readonly ok: false; readonly reason: "classification_missing"; readonly missing: readonly MissingLine[] };

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const accountSummary = (a: Pick<AccountRef, "id" | "number"> | null) => (a ? { id: a.id, number: a.number } : null);
const vatSummary = (v: Pick<VatCodeRef, "id" | "code" | "rateBasisPoints"> | null) =>
  v ? { id: v.id, code: v.code, rateBasisPoints: v.rateBasisPoints } : null;

export async function classifyAndNumber(
  tx: Prisma.TransactionClient,
  input: ClassifyAndNumberInput,
): Promise<ClassifyAndNumberResult> {
  if (input.requestIds.length === 0) return { ok: true, lines: [] };

  // ── 1. Candidates, locked ────────────────────────────────────────────────
  const candidates = await tx.refundLine.findMany({
    where: {
      requestId: { in: [...input.requestIds] },
      rejectionReason: null,
      receiptNumber: null,
      ...(input.entities ? { entity: { in: [...input.entities] } } : {}),
    },
    select: { id: true },
  });
  if (candidates.length === 0) return { ok: true, lines: [] };
  const lockedIds = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "refund_line" WHERE "id" = ANY(${candidates.map((l) => l.id)}::text[]) ORDER BY "id" FOR UPDATE`
  ).map((row) => row.id);

  const lines = await tx.refundLine.findMany({
    where: { id: { in: lockedIds }, rejectionReason: null, receiptNumber: null },
    select: {
      id: true,
      requestId: true,
      date: true,
      type: true,
      entity: true,
      currency: true,
      createdAt: true,
      ledgerAccountId: true,
      ledgerAccountIsDefault: true,
      vatCodeId: true,
      vatCodeIsDefault: true,
      ledgerAccount: { select: { id: true, number: true, name: true } },
      vatCode: { select: { id: true, code: true, label: true, rateBasisPoints: true } },
    },
  });
  lines.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (lines.length === 0) return { ok: true, lines: [] };

  // ── 2. Resolve ───────────────────────────────────────────────────────────
  const accountFlags = await loadActiveFlags(
    tx,
    "ledger_account",
    lines.flatMap((l) => (l.ledgerAccountId ? [l.ledgerAccountId] : [])),
  );
  const vatFlags = await loadActiveFlags(
    tx,
    "vat_code",
    lines.flatMap((l) => (l.vatCodeId ? [l.vatCodeId] : [])),
  );

  const resolved = new Map<string, Classification | null>();
  const missingLines: MissingLine[] = [];
  for (const line of lines) {
    const classification = resolveClassification(
      {
        entity: line.entity,
        currency: line.currency,
        type: line.type,
        rejected: false,
        ledgerAccount: line.ledgerAccount
          ? { ...line.ledgerAccount, active: accountFlags.get(line.ledgerAccount.id) ?? true }
          : null,
        ledgerAccountIsDefault: line.ledgerAccountIsDefault,
        vatCode: line.vatCode ? { ...line.vatCode, active: vatFlags.get(line.vatCode.id) ?? true } : null,
        vatCodeIsDefault: line.vatCodeIsDefault,
      },
      input.snapshot.defaults,
      input.snapshot.foreignCurrencyVatCode,
    );
    resolved.set(line.id, classification);
    if (classification !== null && classification.missing.length > 0) {
      missingLines.push({
        lineId: line.id,
        requestId: line.requestId,
        date: isoDate(line.date),
        type: line.type,
        missing: classification.missing,
      });
    }
  }
  if (input.cause === "approval" && missingLines.length > 0) {
    return { ok: false, reason: "classification_missing", missing: missingLines };
  }

  // ── 3. Counters, years ascending, one upsert each ────────────────────────
  const yearOf = (line: { date: Date }) => line.date.getUTCFullYear();
  const perYear = new Map<number, number>();
  for (const line of lines) perYear.set(yearOf(line), (perYear.get(yearOf(line)) ?? 0) + 1);
  const nextSeq = new Map<number, number>();
  for (const year of [...perYear.keys()].sort((a, b) => a - b)) {
    const count = perYear.get(year)!;
    const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "receipt_counter" ("ownerUserId", "year", "lastSeq", "startAfter", "updatedAt")
      VALUES (${input.owner.userId}, ${year}::int, ${count}::int, 0, now())
      ON CONFLICT ("ownerUserId", "year") DO UPDATE
        SET "lastSeq" = "receipt_counter"."lastSeq" + ${count}::int, "updatedAt" = now()
      RETURNING "lastSeq"`;
    const last = rows[0]?.lastSeq;
    if (typeof last !== "number") throw new Error("receipt_counter upsert returned no row");
    nextSeq.set(year, last - count + 1);
  }

  // ── 4 + 5. One UPDATE per line, then the audit rows ──────────────────────
  const initialsOfOwner = initials(input.owner.name, input.owner.email);
  const numberedAt = new Date();
  const out: NumberedLine[] = [];
  for (const line of lines) {
    const year = yearOf(line);
    const seq = nextSeq.get(year)!;
    nextSeq.set(year, seq + 1);
    const receiptNumber = formatReceiptNumber(initialsOfOwner, year, seq);
    const classification = resolved.get(line.id) ?? null;

    await tx.refundLine.update({
      where: { id: line.id },
      data: {
        receiptNumber,
        receiptOwnerUserId: input.owner.userId,
        receiptYear: year,
        receiptSeq: seq,
        numberedAt,
        ...(classification
          ? {
              ledgerAccountId: classification.account?.id ?? null,
              ledgerAccountIsDefault: classification.account ? classification.accountIsDefault : null,
              vatCodeId: classification.vatCode?.id ?? null,
              vatCodeIsDefault: classification.vatCode ? classification.vatCodeIsDefault : null,
            }
          : {}),
      },
    });

    if (classification) {
      await writeAuditEntry(tx, {
        requestId: line.requestId,
        lineId: line.id,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        action: "line_classified",
        detail: {
          cause: input.cause,
          account: {
            from: accountSummary(line.ledgerAccount),
            to: accountSummary(classification.account),
            fromDefault: line.ledgerAccount === null ? true : line.ledgerAccountIsDefault === true,
            toDefault: classification.accountIsDefault,
          },
          vatCode: {
            from: vatSummary(line.vatCode),
            to: vatSummary(classification.vatCode),
            fromDefault: line.vatCode === null ? true : line.vatCodeIsDefault === true,
            toDefault: classification.vatCodeIsDefault,
          },
        },
      });
    }
    await writeAuditEntry(tx, {
      requestId: line.requestId,
      lineId: line.id,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      action: "receipt_number_assigned",
      detail: { cause: input.cause, receiptNumber, year, seq },
    });

    out.push({
      lineId: line.id,
      requestId: line.requestId,
      entity: line.entity,
      receiptNumber,
      year,
      seq,
      missing: classification ? classification.missing : null,
    });
  }
  return { ok: true, lines: out };
}
