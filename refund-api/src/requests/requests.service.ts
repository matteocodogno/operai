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
import type {
  CurrencyValue,
  EntityValue,
  Subtotal,
  RefundLineResponse,
  RequestDetail,
  RequestListItem,
} from "./requests.schemas";

// ─── Row shapes this module maps FROM (subset of what requests.repo.ts returns) ──

export interface LineRow {
  readonly id: string;
  readonly date: Date;
  readonly type: string;
  readonly motivo: string;
  readonly entity: string;
  readonly currency: string;
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
  // AC-5.2 (specs/008-refund-monthly-processing): the request's CURRENT
  // batch claim (RefundRequest.batchId → RefundBatch), if any — a `compiled`
  // (not yet paid) batch has `paidAt`/`paidByEmail` still null, so no extra
  // status gate is needed at the query layer; mapRequestDetail still asserts
  // status==='paid' as belt-and-suspenders (see its own comment). Optional
  // because listOwnRequests' lighter query never selects this relation — only
  // findRequestWithLines (GET /requests/:id) does; mapRequestListItem never
  // reads it.
  readonly batch?: { readonly paidAt: Date | null; readonly paidByEmail: string | null } | null;
}

// ─── Subtotals (AC-3.5/6.6) ─────────────────────────────────────────────────

/**
 * Per-currency subtotals — NEVER blended across currencies (plan.md § API
 * contracts). 2026-07-17 amendment: grouped PURELY by the stored `currency`
 * field, never by `entity` — currency is independently-stored and decoupled
 * from entity, so a single request may now produce EUR + CHF + USD (+ GBP)
 * subtotals regardless of how many entities its lines touch.
 * `approvedCents` is `null` for a currency group where NO line has an
 * `approvedTotalCents` set yet (draft/submitted, before T12's approve
 * finalizes/defaults it) — distinguishing "not decided" from "decided to
 * zero". Sorted by currency for deterministic output.
 */
export function computeSubtotals(lines: readonly LineRow[]): Subtotal[] {
  const byCurrency = new Map<string, LineRow[]>();
  for (const line of lines) {
    const group = byCurrency.get(line.currency);
    if (group) {
      group.push(line);
    } else {
      byCurrency.set(line.currency, [line]);
    }
  }

  return Array.from(byCurrency.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, group]) => {
      const requestedCents = group.reduce(
        (sum, l) => sum + l.requestedAmountCents,
        0,
      );
      const anyApproved = group.some((l) => l.approvedTotalCents !== null);
      const approvedCents = anyApproved
        ? group.reduce((sum, l) => sum + (l.approvedTotalCents ?? 0), 0)
        : null;
      return {
        currency: currency as CurrencyValue,
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
  return {
    id: line.id,
    date: isoDateOnly(line.date),
    type: line.type as RefundLineResponse["type"],
    motivo: line.motivo,
    entity: line.entity as EntityValue,
    currency: line.currency as CurrencyValue,
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
    // AC-5.2: only a `paid` request carries these — a `compiled` (not yet
    // paid) batch claim already yields null paidAt/paidByEmail on its own,
    // but gating on status explicitly keeps the contract exact regardless of
    // batch lifecycle nuance.
    paidAt:
      request.status === "paid" ? (request.batch?.paidAt?.toISOString() ?? null) : null,
    paidBy: request.status === "paid" ? (request.batch?.paidByEmail ?? null) : null,
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
