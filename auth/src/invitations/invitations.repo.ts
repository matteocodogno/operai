/**
 * Invitation domain repo (T5, specs/006-user-invitations — refs US-1, US-4;
 * ADR-0012, ADR-0013).
 *
 * Centralizes every Prisma access to the `invitation` table so the
 * effective-status computation and the reconcile-on-write step are each
 * implemented EXACTLY ONCE and reused by every consumer (`invitations.routes.ts`
 * (T6), `invite.routes.ts` (T9), and the activation hook (T8)) — ADR-0013's
 * named risk is "inconsistent effective-status computation across call
 * sites" if this logic is re-derived ad hoc per caller.
 *
 * `status` on the row is only ever `pending | accepted | revoked` as a
 * matter of admin-triggered action — with ONE deliberate exception:
 * {@link reconcileExpiredPending} physically writes the literal value
 * `expired` (ADR-0013 point 4), the one place a stored value must be
 * current for the partial-unique index (`invitation_pending_email_key`,
 * `WHERE status = 'pending'`) to correctly release a dead row. Every other
 * consumer of "is this expired" goes through {@link effectiveInvitationStatus}
 * or {@link buildEffectiveStatusWhere}, never re-deriving the check inline.
 */

import { db } from "../lib/db";
import type {
  Invitation,
  Prisma,
  PrismaClient,
} from "../lib/generated/prisma/client";

export type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

/** 72 hours (US-4, AC-4.1) — the invitation lifetime from creation or from the most recent resend. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

/** Stored (physical) status values. `expired` is written ONLY by {@link reconcileExpiredPending} — see module doc. */
export type StoredInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Every value the API/UI ever reasons about — identical set to {@link StoredInvitationStatus}, kept as a distinct alias for call-site clarity (derived vs. stored). */
export type EffectiveInvitationStatus = StoredInvitationStatus;

/** A terminal effective status can never transition again (no resend/revoke). */
export function isTerminalStatus(status: EffectiveInvitationStatus): boolean {
  return status === "accepted" || status === "revoked";
}

/** Normalizes an email the same way on every write and every lookup (lower-case, trimmed) — so `AC-1.4`'s "live pending per email" comparison is never case-sensitive-inconsistent. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * THE single shared effective-status computation (ADR-0013 point 1/2):
 * `status=='pending' && expiresAt<=now ? 'expired' : status`. Every reader
 * (list, detail, landing) MUST go through this function rather than
 * re-deriving the check.
 */
export function effectiveInvitationStatus(
  invitation: Pick<Invitation, "status" | "expiresAt">,
  now: Date = new Date(),
): EffectiveInvitationStatus {
  if (invitation.status === "pending" && invitation.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return invitation.status as EffectiveInvitationStatus;
}

/**
 * A Prisma `where` fragment matching the given EFFECTIVE status — used by
 * `GET /admin/invitations?status=` (T6) so pagination/counts stay correct
 * without fetching a superset and re-filtering in application code. `pending`
 * excludes rows past their window (they are effectively `expired`);
 * `expired` matches BOTH a lazily-expired-but-still-physically-`pending` row
 * AND a row already reconciled to the physical `expired` value.
 */
export function buildEffectiveStatusWhere(
  status: EffectiveInvitationStatus,
  now: Date = new Date(),
): Prisma.InvitationWhereInput {
  switch (status) {
    case "pending":
      return { status: "pending", expiresAt: { gt: now } };
    case "expired":
      return {
        OR: [{ status: "expired" }, { status: "pending", expiresAt: { lte: now } }],
      };
    case "accepted":
      return { status: "accepted" };
    case "revoked":
      return { status: "revoked" };
  }
}

/**
 * Reconcile-on-write (ADR-0013 point 4): inside the SAME transaction as a
 * subsequent insert, flips any of `email`'s past-expiry `status='pending'`
 * rows to the physical terminal value `'expired'`. This is what lets
 * `invitation_pending_email_key` (the partial-unique index scoped to
 * `WHERE status='pending'`) never block a legitimately fresh invitation for
 * an address whose only prior invitation is dead (AC-1.5/AC-1.14). Must be
 * called BEFORE the insert, inside the same `tx` — never as a separate,
 * non-atomic statement (ADR-0013 risk).
 */
export async function reconcileExpiredPending(
  tx: Prisma.TransactionClient,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.invitation.updateMany({
    where: { email: normalizeEmail(email), status: "pending", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
}

/**
 * A LIVE pending invitation for `email` — `status='pending' AND
 * expiresAt>now`, matching ADR-0013 point 3 EXACTLY (the query the
 * activation hook, T8, filters on directly — a lazily-expired row is simply
 * excluded, with the same effect as checking effective status). Also reused
 * by T6's `POST /admin/invitations` 409 "live-pending invitation exists"
 * check (AC-1.4), so both consumers share one predicate.
 */
export async function findLivePendingInvitationByEmail(
  client: PrismaClientLike,
  email: string,
  now: Date = new Date(),
): Promise<Invitation | null> {
  return client.invitation.findFirst({
    where: { email: normalizeEmail(email), status: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findInvitationById(id: string): Promise<Invitation | null> {
  return db.invitation.findUnique({ where: { id } });
}

export interface CreateInvitationInput {
  email: string;
  roleIds: string[];
  departmentIds: string[];
  invitedByUserId: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Inserts a brand-new `pending` invitation row. Callers MUST run {@link reconcileExpiredPending} for the same email in the same `tx` first. */
export async function createInvitationRow(
  tx: Prisma.TransactionClient,
  input: CreateInvitationInput,
): Promise<Invitation> {
  return tx.invitation.create({
    data: {
      email: normalizeEmail(input.email),
      roleIds: input.roleIds,
      departmentIds: input.departmentIds,
      invitedByUserId: input.invitedByUserId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      status: "pending",
    },
  });
}

export interface ResendInvitationInput {
  tokenHash: string;
  expiresAt: Date;
  invitedByUserId: string;
}

/** Resend (AC-3.1/3.3): sets `status='pending'`, rotates the token, resets `expiresAt`, and records who (re-)sent it. */
export async function updateForResend(
  tx: Prisma.TransactionClient,
  id: string,
  input: ResendInvitationInput,
): Promise<Invitation> {
  return tx.invitation.update({
    where: { id },
    data: {
      status: "pending",
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      invitedByUserId: input.invitedByUserId,
    },
  });
}

/** Revoke (AC-1.9): the terminal, physical `status='revoked'` — invalidates the token immediately (no separate token wipe needed; the landing page's status check alone refuses a non-pending-effective invitation). */
export async function updateForRevoke(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<Invitation> {
  return tx.invitation.update({ where: { id }, data: { status: "revoked" } });
}

export interface UpdateEmailDeliveryInput {
  status: "sent" | "failed";
  error?: string | null;
}

/**
 * Records the outcome of the (best-effort) notify-api send AFTER the
 * invitation itself is already committed (plan.md "Failure handling": the
 * invitation is created/committed first, the email is attempted second — a
 * failed send never rolls back or blocks the invitation). Deliberately a
 * plain, non-`withAudit` write: this is delivery metadata about a side
 * effect, not itself a domain mutation that changes anyone's effective
 * permissions.
 */
export async function updateEmailDelivery(
  id: string,
  input: UpdateEmailDeliveryInput,
): Promise<Invitation> {
  return db.invitation.update({
    where: { id },
    data: {
      lastEmailStatus: input.status,
      lastEmailError: input.status === "failed" ? input.error ?? "Unknown error" : null,
    },
  });
}

export interface ListInvitationsParams {
  page: number;
  pageSize: number;
  status?: EffectiveInvitationStatus;
  q?: string;
  now?: Date;
}

export interface ListInvitationsResult {
  items: Invitation[];
  total: number;
}

/** `GET /admin/invitations` (T6) — paginated, filterable by EFFECTIVE status, `q` substring-matches email. */
export async function listInvitations({
  page,
  pageSize,
  status,
  q,
  now = new Date(),
}: ListInvitationsParams): Promise<ListInvitationsResult> {
  const where: Prisma.InvitationWhereInput = {
    ...(status ? buildEffectiveStatusWhere(status, now) : {}),
    ...(q ? { email: { contains: q, mode: "insensitive" } } : {}),
  };

  const [items, total] = await Promise.all([
    db.invitation.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.invitation.count({ where }),
  ]);

  return { items, total };
}
