/**
 * Append-only financial audit trail writer (T10, specs/007-refund-service,
 * US-8, ADR-0018).
 *
 * Every write happens INSIDE the same transaction as the state-relevant
 * event it records (`submitted`, `withdrawn` here; `approved`/`rejected`/
 * `approved_total_set` land with T12) — AC-8.1. There is deliberately NO
 * update/delete function in this module: the database-level trigger
 * (0001_init migration) is the enforcement backstop (AC-8.2), and the
 * application layer never even offers a code path to try.
 */

import type { Prisma } from "../lib/generated/prisma/client";

export type AuditAction =
  | "submitted"
  | "withdrawn"
  | "approved"
  | "rejected"
  | "approved_total_set";

export interface WriteAuditEntryParams {
  readonly requestId: string;
  readonly lineId?: string;
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
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      action: params.action as never,
      ...(params.detail !== undefined
        ? { detail: params.detail as never }
        : {}),
    },
  });
}
