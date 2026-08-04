/**
 * Audit trail helper (T7, specs/004-auth-roles-permissions).
 *
 * Every mutating admin route (roles, departments, users — T8/T9/T10) MUST
 * route its write through `withAudit()` so that, in a single Prisma
 * transaction:
 *
 *   1. the domain mutation itself runs (role/department/user_role/etc.),
 *   2. an immutable `audit_log` row is written (actor, action, target,
 *      human summary, before/after `data` diff) — AC-5.1,
 *   3. `user.permissionEpoch` is bumped for every affected user — AC-4.3.
 *
 * If any step fails, the whole transaction rolls back — there is never a
 * domain mutation without a matching audit row, and never an audit row
 * without the epoch bump that makes revocation/grant immediate.
 *
 * There is deliberately no update/delete path for `audit_log` anywhere in
 * this module (AC-5.3) — rows are only ever created, never mutated.
 */

import { db } from "../lib/db";
import type { AuditLog, Prisma } from "../lib/generated/prisma/client";

/**
 * The audit row to write. Mirrors the `audit_log` columns (plan.md "Data
 * model"). `data` carries the before/after diff — shape varies by `action`
 * and is opaque to this helper.
 */
export interface AuditEntryInput {
  /** Who performed the change. Null only for system-initiated mutations (e.g. seed). */
  actorUserId: string | null;
  /** e.g. "role.create", "user_role.revoke" — dot-namespaced `<targetType>.<verb>`. */
  action: string;
  /** e.g. "role", "department", "user_role". */
  targetType: string;
  /** The id of the primary affected record, if any. */
  targetId?: string | null;
  /** Human-readable one-liner for the audit list UI. */
  summary: string;
  /** Before/after (or other) diff payload. Omit/null when there is nothing to diff. */
  data?: Prisma.InputJsonValue | null;
}

/** Runs the domain mutation inside the shared transaction. */
export type AuditedMutation<T> = (tx: Prisma.TransactionClient) => Promise<T>;

/**
 * Builds the audit entry. Accepts either a fixed entry (when the caller
 * already knows before/after ahead of time) or a function of the mutation's
 * result (when the "after" state — e.g. a generated id — only exists once
 * the mutation has run).
 */
export type AuditEntryOrBuilder<T> =
  | AuditEntryInput
  | ((result: T) => AuditEntryInput);

export interface WithAuditParams<T> {
  /** The ids of every user whose effective permissions may have changed. De-duplicated internally. */
  affectedUserIds: readonly string[];
  /** The domain write(s) to perform, using the shared transaction client. */
  mutate: AuditedMutation<T>;
  /** The audit_log row to write for this mutation, or a builder derived from its result. */
  entry: AuditEntryOrBuilder<T>;
}

/**
 * The one seam every mutating admin route must call. Opens a single Prisma
 * interactive transaction, runs `mutate`, then atomically writes the audit
 * row and bumps `permissionEpoch` for `affectedUserIds`. Returns whatever
 * `mutate` returned.
 *
 * A thrown error from `mutate` (or from the audit/epoch writes themselves)
 * rolls back the entire transaction — no partial state (AC-5.1 + AC-4.3
 * "in one transaction", plan.md).
 */
export async function withAudit<T>({
  affectedUserIds,
  mutate,
  entry,
}: WithAuditParams<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    const result = await mutate(tx);

    const resolvedEntry = typeof entry === "function" ? entry(result) : entry;

    await tx.auditLog.create({
      data: {
        actorUserId: resolvedEntry.actorUserId,
        action: resolvedEntry.action,
        targetType: resolvedEntry.targetType,
        targetId: resolvedEntry.targetId ?? null,
        summary: resolvedEntry.summary,
        // Omit the key entirely (rather than passing `undefined`) when there is
        // nothing to diff — `exactOptionalPropertyTypes` forbids an explicit
        // `undefined` here, and omission lets the nullable column default to NULL.
        ...(resolvedEntry.data !== undefined && resolvedEntry.data !== null
          ? { data: resolvedEntry.data }
          : {}),
      },
    });

    const uniqueUserIds = Array.from(new Set(affectedUserIds));
    if (uniqueUserIds.length > 0) {
      await tx.user.updateMany({
        where: { id: { in: uniqueUserIds } },
        data: { permissionEpoch: { increment: 1 } },
      });
    }

    return result;
  });
}

/**
 * Pagination input for {@link listAuditLog}. `targetType`/`targetId`/`action`
 * (T5, specs/012-employee-address — refs AC-5.3) are additive, optional
 * filters on the existing `@@index([targetType, targetId])` — every other
 * line of this function is unchanged.
 */
export interface AuditLogPageParams {
  /** 1-based page number. */
  page: number;
  /** Rows per page. */
  pageSize: number;
  /** Optional filter, e.g. "user". */
  targetType?: string;
  /** Optional filter — the id of the affected record. */
  targetId?: string;
  /** Optional filter, e.g. "user.address.set". */
  action?: string;
}

export interface AuditLogEntryWithActor extends AuditLog {
  actor: { id: string; name: string; email: string } | null;
}

export interface AuditLogPage {
  items: AuditLogEntryWithActor[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Read-only, reverse-chronological, paginated view of the audit trail
 * (AC-5.2). There is intentionally no corresponding write/update/delete
 * export in this module — see the module doc comment.
 */
export async function listAuditLog({
  page,
  pageSize,
  targetType,
  targetId,
  action,
}: AuditLogPageParams): Promise<AuditLogPage> {
  const skip = (page - 1) * pageSize;

  // Additive optional filter (T5, AC-5.3) — an unfiltered call (all three
  // undefined) produces `where: {}`, i.e. exactly today's unfiltered query.
  const where: Prisma.AuditLogWhereInput = {
    ...(targetType !== undefined ? { targetType } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
    ...(action !== undefined ? { action } : {}),
  };

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: pageSize,
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
    }),
    db.auditLog.count({ where }),
  ]);

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
