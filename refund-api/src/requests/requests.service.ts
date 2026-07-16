/**
 * Pure, DB-free mapping + access-predicate helpers shared by every
 * request/line/attachment/lifecycle route handler (T7-T10,
 * specs/007-refund-service).
 *
 * Kept separate from requests.repo.ts (Prisma I/O) so the response-shaping
 * and authorization-predicate logic can be unit tested without a database,
 * and so lines.routes.ts / attachments.routes.ts / lifecycle.routes.ts can
 * reuse the SAME `canReadRequest` predicate that GET /requests/:id uses —
 * the plan is explicit that queue visibility and record-level access must
 * never desync (ADR-0015 Risks).
 */

import type { AuthzContext } from "../auth/authz.middleware";
import {
  hasCapability,
  findPermission,
  ownershipOwn,
  requestInScope,
  entityScopeForPermission,
} from "../authz/conditions";
import {
  currencyForEntity,
  type EntityValue,
  type Subtotal,
  type RefundLineResponse,
  type RequestDetail,
  type RequestListItem,
} from "./requests.schemas";

// ─── Row shapes this module maps FROM (subset of what requests.repo.ts returns) ──

export interface LineRow {
  readonly id: string;
  readonly date: Date;
  readonly type: string;
  readonly motivo: string;
  readonly entity: string;
  readonly requestedAmountCents: number;
  readonly km: number | null;
  readonly approvedTotalCents: number | null;
  readonly attachments?: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }[];
}

export interface RequestRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerName: string | null;
  readonly status: string;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly decidedByEmail: string | null;
  readonly rejectionMotivation: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lines: readonly LineRow[];
}

// ─── Subtotals (AC-3.5/6.6) ─────────────────────────────────────────────────

/**
 * Per-currency subtotals grouped by entity — NEVER blended across entities
 * (plan.md § API contracts). `approvedCents` is `null` for an entity group
 * where NO line has an `approvedTotalCents` set yet (draft/submitted, before
 * T12's approve finalizes/defaults it) — distinguishing "not decided" from
 * "decided to zero". Sorted by entity for deterministic output.
 */
export function computeSubtotals(lines: readonly LineRow[]): Subtotal[] {
  const byEntity = new Map<string, LineRow[]>();
  for (const line of lines) {
    const group = byEntity.get(line.entity);
    if (group) {
      group.push(line);
    } else {
      byEntity.set(line.entity, [line]);
    }
  }

  return Array.from(byEntity.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entity, group]) => {
      const requestedCents = group.reduce(
        (sum, l) => sum + l.requestedAmountCents,
        0,
      );
      const anyApproved = group.some((l) => l.approvedTotalCents !== null);
      const approvedCents = anyApproved
        ? group.reduce((sum, l) => sum + (l.approvedTotalCents ?? 0), 0)
        : null;
      return {
        entity: entity as EntityValue,
        currency: currencyForEntity(entity as EntityValue),
        requestedCents,
        approvedCents,
      };
    });
}

// ─── Response mapping ───────────────────────────────────────────────────────

const isoDateOnly = (d: Date): string => {
  // Prisma returns @db.Date columns as a Date at UTC midnight — slice the
  // ISO string to YYYY-MM-DD rather than using local-timezone formatting.
  const iso = d.toISOString();
  return iso.slice(0, 10);
};

export function mapLine(line: LineRow): RefundLineResponse {
  const entity = line.entity as EntityValue;
  return {
    id: line.id,
    date: isoDateOnly(line.date),
    type: line.type as RefundLineResponse["type"],
    motivo: line.motivo,
    entity,
    currency: currencyForEntity(entity),
    requestedAmountCents: line.requestedAmountCents,
    km: line.km,
    approvedTotalCents: line.approvedTotalCents,
    attachments: (line.attachments ?? []).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    })),
  };
}

export function mapRequestDetail(request: RequestRow): RequestDetail {
  return {
    id: request.id,
    status: request.status as RequestDetail["status"],
    owner: {
      userId: request.ownerUserId,
      email: request.ownerEmail,
      name: request.ownerName,
    },
    submittedAt: request.submittedAt?.toISOString() ?? null,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decidedBy: request.decidedByEmail
      ? { email: request.decidedByEmail }
      : null,
    rejectionMotivation: request.rejectionMotivation,
    lines: request.lines.map(mapLine),
    subtotals: computeSubtotals(request.lines),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

export function mapRequestListItem(request: RequestRow): RequestListItem {
  return {
    id: request.id,
    status: request.status as RequestListItem["status"],
    updatedAt: request.updatedAt.toISOString(),
    subtotals: computeSubtotals(request.lines),
  };
}

// ─── Shared access predicate (ADR-0014/0015) ───────────────────────────────
//
// Backs every "/requests/:id and its subroutes" denial (GET detail, the
// attachment signed-GET mint) that must be a record-level 404, NEVER a
// wholesale 403 — see plan.md's denial-semantics table. An owner who has
// since lost the `request:read` capability (e.g. an admin revoked their
// refund access) is treated the same as a stranger: 404, not a leaked 200.

export function canReadRequest(
  request: { readonly ownerUserId: string; readonly lines: readonly LineRow[] },
  authz: AuthzContext,
  sub: string,
): boolean {
  const isOwnerWithReadCapability =
    ownershipOwn(request, sub) &&
    hasCapability(authz.permissions, "request", "read");
  if (isOwnerWithReadCapability) return true;

  if (!hasCapability(authz.permissions, "request", "review")) return false;

  const reviewGrant = findPermission(authz.permissions, "request", "review");
  const scope = entityScopeForPermission(
    reviewGrant?.conditions ?? null,
    authz.entity,
  );
  if (scope === null) return false;
  return requestInScope(request.lines, scope);
}

/**
 * Backs the DRAFT-owner-only surfaces: DELETE request, all line mutations,
 * attachment mint/confirm/delete, submit, withdraw. There is no accounting
 * alternative for these — only the owning employee, holding `request:create`,
 * may ever reach them (plan.md § API contracts, "authorized by request:create
 * + ownership of the request").
 */
export function canMutateAsOwner(
  request: { readonly ownerUserId: string },
  authz: AuthzContext,
  sub: string,
): boolean {
  return (
    ownershipOwn(request, sub) &&
    hasCapability(authz.permissions, "request", "create")
  );
}
