/**
 * Append-only financial audit trail writer (T10, specs/20260716-refund-service,
 * US-8, ADR 20260716-immutable-financial-audit-trail-refund; +`batchId`/`batch_compiled|batch_paid|batch_discarded`,
 * T3, specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-audit-trail-extension).
 *
 * Every write happens INSIDE the same transaction as the state-relevant
 * event it records (`submitted`, `withdrawn` here; `approved`/`rejected`/
 * `approved_total_set` land with T12; `batch_compiled`/`batch_paid`/
 * `batch_discarded` land with T3/T6/T8 — one row per AFFECTED REQUEST per
 * batch action, `batchId` set on these three only) — AC-8.1/AC-7.1. There is
 * deliberately NO update/delete function in this module: the database-level
 * trigger (0001_init migration) is the enforcement backstop (AC-8.2), and
 * the application layer never even offers a code path to try.
 */

import type { Prisma } from "../lib/generated/prisma/client";

export type AuditAction =
  | "submitted"
  | "withdrawn"
  | "approved"
  | "rejected"
  | "approved_total_set"
  | "line_rejected"
  | "line_restored"
  | "batch_compiled"
  | "batch_paid"
  | "batch_discarded"
  // specs/20261118-refund-accounting-export (T8): the classification frozen or
  // changed on a line, and the receipt number issued to it.
  | "line_classified"
  | "receipt_number_assigned"
  // specs/20261119-accounting (T18, D34): a pending exchange-rate copy written by the first successful export of a batch
  // (actor = the exporter, AC-5.6). `detail` is {@link LineRateCopiedDetail}.
  | "line_rate_copied";

export interface WriteAuditEntryParams {
  readonly requestId: string;
  readonly lineId?: string;
  readonly batchId?: string;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: AuditAction;
  readonly detail?: Record<string, unknown>;
}

export async function writeAuditEntry(
  tx: Prisma.TransactionClient,
  params: WriteAuditEntryParams,
): Promise<void> {
  await tx.refundAuditEntry.create({
    data: {
      requestId: params.requestId,
      ...(params.lineId !== undefined ? { lineId: params.lineId } : {}),
      ...(params.batchId !== undefined ? { batchId: params.batchId } : {}),
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      action: params.action as never,
      ...(params.detail !== undefined
        ? { detail: params.detail as never }
        : {}),
    },
  });
}

// ─── Detail shapes (specs/20261119-accounting T18, D34; plan § Data model "Audit detail v2") ──────────────────

/** An account as copied: natural key and the name it had. */
export interface AuditAccountCopy {
  readonly number: string;
  readonly name: string;
}

/** A VAT code as copied: natural key and rate. */
export interface AuditVatCopy {
  readonly code: string;
  readonly rateBasisPoints: number;
}

/** Why a line's classification was written. `withdrawn`: the hand copies went with the request back to draft. */
export type ClassifiedCause = "review" | "post_approval" | "approval" | "release" | "withdrawn";

/** The exchange rate copied with the classification (`approval`, `release`): the rate and its month, or `"pending"`. */
export type AuditFxRate = { readonly rateMicros: number; readonly month: string } | "pending";

/**
 * `line_classified`, detail v2: the copies, by natural key, from and to. `fxRate` is present for the causes `approval` and
 * `release` only. Rows written by 20261118 are v1 (`{ cause, account: {from:{id,number}...}, vatCode: {...} }`, no `v`):
 * {@link readClassifiedDetail} reads both.
 */
export interface LineClassifiedDetail {
  readonly v: 2;
  readonly cause: ClassifiedCause;
  readonly account: {
    readonly from: AuditAccountCopy | null;
    readonly to: AuditAccountCopy | null;
    readonly fromDefault: boolean;
    readonly toDefault: boolean;
  };
  readonly vatCode: {
    readonly from: AuditVatCopy | null;
    readonly to: AuditVatCopy | null;
    readonly fromDefault: boolean;
    readonly toDefault: boolean;
  };
  readonly fxRate?: AuditFxRate;
}

/** `line_rate_copied`, detail v2: the rate copied at the first successful export of a batch (AC-5.6). */
export interface LineRateCopiedDetail {
  readonly v: 2;
  readonly cause: "export";
  readonly batchId: string;
  readonly rateMicros: number;
  /** `YYYY-MM` of the expense month. */
  readonly month: string;
  readonly currency: string;
}

/** A `line_classified` detail of either version, as a reader sees it: v1's `name` is unknown (`null`), its ids are dropped. */
export interface ReadClassifiedDetail {
  readonly v: 1 | 2;
  readonly cause: string;
  readonly account: {
    readonly from: { readonly number: string; readonly name: string | null } | null;
    readonly to: { readonly number: string; readonly name: string | null } | null;
    readonly fromDefault: boolean;
    readonly toDefault: boolean;
  };
  readonly vatCode: {
    readonly from: AuditVatCopy | null;
    readonly to: AuditVatCopy | null;
    readonly fromDefault: boolean;
    readonly toDefault: boolean;
  };
  readonly fxRate?: AuditFxRate;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readAccount(value: unknown): { number: string; name: string | null } | null {
  if (!isRecord(value) || typeof value["number"] !== "string") return null;
  return { number: value["number"], name: typeof value["name"] === "string" ? value["name"] : null };
}

function readVat(value: unknown): AuditVatCopy | null {
  if (!isRecord(value) || typeof value["code"] !== "string" || typeof value["rateBasisPoints"] !== "number") return null;
  return { code: value["code"], rateBasisPoints: value["rateBasisPoints"] };
}

/**
 * Reads a `line_classified` detail, version 1 (20261118, with ids) or 2, into one shape; `null` for anything else. A
 * reader never fails on an old row (D34: "readers accept v1").
 */
export function readClassifiedDetail(detail: unknown): ReadClassifiedDetail | null {
  if (!isRecord(detail) || typeof detail["cause"] !== "string") return null;
  const account = detail["account"];
  const vatCode = detail["vatCode"];
  if (!isRecord(account) || !isRecord(vatCode)) return null;
  const version = detail["v"] === 2 ? 2 : 1;
  const fx = detail["fxRate"];
  const fxRate: AuditFxRate | undefined =
    fx === "pending"
      ? "pending"
      : isRecord(fx) && typeof fx["rateMicros"] === "number" && typeof fx["month"] === "string"
        ? { rateMicros: fx["rateMicros"], month: fx["month"] }
        : undefined;
  return {
    v: version,
    cause: detail["cause"],
    account: {
      from: readAccount(account["from"]),
      to: readAccount(account["to"]),
      fromDefault: account["fromDefault"] === true,
      toDefault: account["toDefault"] === true,
    },
    vatCode: {
      from: readVat(vatCode["from"]),
      to: readVat(vatCode["to"]),
      fromDefault: vatCode["fromDefault"] === true,
      toDefault: vatCode["toDefault"] === true,
    },
    ...(fxRate !== undefined ? { fxRate } : {}),
  };
}
