/**
 * Invitation admin API (T6, specs/006-user-invitations — refs US-1
 * (AC-1.1–1.14), US-3 (AC-3.1–3.6), US-4 (AC-4.1–4.4); plan.md "Invitation
 * admin API"; ADR-0012, ADR-0013).
 *
 * Every route is guarded by `sessionMiddleware` + `requireAuth` +
 * `requireAdmin` (specs/004, T4) — non-admins get RFC 7807 `403`, mirroring
 * every other `admin/*` router in this service.
 *
 *   POST   /admin/invitations              create + send the invite email
 *   GET    /admin/invitations               paginated, `?status=`/`?q=`
 *   POST   /admin/invitations/:id/resend    rotate token, +72h, re-send
 *   POST   /admin/invitations/:id/revoke    terminal, invalidates the link
 *
 * Every mutating route routes its domain write through `withAudit()`
 * (specs/004, `../authz/audit.ts`) so the write and its `audit_log` row
 * commit atomically (AC-1.7/AC-3.5/AC-1.12). `affectedUserIds` is always
 * `[]` here — creating/resending/revoking an INVITATION never changes any
 * EXISTING user's effective permissions (that only happens later, at
 * acceptance — T8's activation hook, which bumps `permissionEpoch` itself).
 *
 * Email send ordering (plan.md "Failure handling", risk R5): the invitation
 * row is committed FIRST (inside `withAudit`'s transaction); the notify-api
 * call happens SECOND, outside that transaction, so a Resend/network
 * failure can NEVER roll back or block invitation creation. The delivery
 * outcome is then written back to `lastEmailStatus`/`lastEmailError` via a
 * plain, non-audited update (`../invitations/invitations.repo.ts`'s
 * `updateEmailDelivery`) — this is metadata about a side effect, not a
 * domain mutation.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { User } from "better-auth";
import {
  requireAdmin,
  requireAuth,
  sessionMiddleware,
} from "../auth/auth.middleware";
import { db } from "../lib/db";
import type { Invitation } from "../lib/generated/prisma/client";
import { withAudit } from "../authz/audit";
import { env } from "../lib/env";
import { sendInvitationEmail } from "../lib/notify";
import {
  createInvitationRow,
  effectiveInvitationStatus,
  findInvitationById,
  findLivePendingInvitationByEmail,
  INVITATION_TTL_MS,
  isTerminalStatus,
  listInvitations,
  normalizeEmail,
  reconcileExpiredPending,
  updateEmailDelivery,
  updateForResend,
  updateForRevoke,
} from "./invitations.repo";
import { generateInvitationToken } from "./token";
import {
  CreateInvitationBodySchema,
  InvitationDetailSchema,
  InvitationIdParamSchema,
  InvitationListResponseSchema,
  ListInvitationsQuerySchema,
  ProblemJsonSchema,
} from "./invitations.schemas";

// ─── Problem-JSON helpers ─────────────────────────────────────────────────────

function notFound(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/404",
    title: "Not Found",
    status: 404,
    detail,
    instance,
  } as const;
}

function conflict(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/409",
    title: "Conflict",
    status: 409,
    detail,
    instance,
  } as const;
}

function unprocessable(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/422",
    title: "Unprocessable Entity",
    status: 422,
    detail,
    instance,
  } as const;
}

// ─── Serialization ────────────────────────────────────────────────────────────

/** Builds the invite-link URL (plan.md "Invite link & landing"): `<BETTER_AUTH_URL>/invite?id=<invId>&token=<raw>`. */
function buildInviteUrl(invitationId: string, rawToken: string): string {
  const url = new URL("/invite", env.BETTER_AUTH_URL);
  url.searchParams.set("id", invitationId);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

async function summarizeRoles(ids: string[]) {
  if (ids.length === 0) return [];
  return db.role.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

async function summarizeDepartments(ids: string[]) {
  if (ids.length === 0) return [];
  return db.department.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

async function summarizeInviter(userId: string | null) {
  if (!userId) return null;
  return db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
}

/** The single serializer for `InvitationDetail` — used by create/resend/revoke/list so the wire shape never drifts between endpoints. */
async function serializeInvitation(invitation: Invitation) {
  const [roles, departments, invitedBy] = await Promise.all([
    summarizeRoles(invitation.roleIds),
    summarizeDepartments(invitation.departmentIds),
    summarizeInviter(invitation.invitedByUserId),
  ]);

  const effectiveStatus = effectiveInvitationStatus(invitation);

  return {
    id: invitation.id,
    email: invitation.email,
    status: effectiveStatus,
    roles,
    departments,
    invitedBy,
    invitedAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.status === "accepted" ? invitation.updatedAt.toISOString() : null,
    emailDelivery: (invitation.lastEmailStatus as "sent" | "failed" | null) ?? null,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const invitationsRouter = new OpenAPIHono<{
  Variables: { user: User | null };
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

invitationsRouter.use(
  "/admin/invitations",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);
invitationsRouter.use(
  "/admin/invitations/*",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);

// ─── POST /admin/invitations ──────────────────────────────────────────────────

const createInvitationRoute = createRoute({
  method: "post",
  path: "/admin/invitations",
  tags: ["Admin"],
  summary: "Invite a new user by email",
  request: {
    body: {
      content: { "application/json": { schema: CreateInvitationBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: InvitationDetailSchema } },
      description: "The created (pending) invitation",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    409: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description:
        "An active user already exists for this email (AC-1.3), or a live " +
        "pending invitation already exists for it (AC-1.4)",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "One or more roleIds/departmentIds do not exist",
    },
  },
});

invitationsRouter.openapi(createInvitationRoute, async (c) => {
  const body = c.req.valid("json");
  const actor = c.get("user")!;
  const email = normalizeEmail(body.email);
  const roleIds = Array.from(new Set(body.roleIds));
  const departmentIds = Array.from(new Set(body.departmentIds));

  // ── 422 — role/department ids must exist ────────────────────────────────
  if (roleIds.length > 0) {
    const found = await db.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((r) => r.id));
    const missing = roleIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return c.json(
        unprocessable(c.req.path, `Unknown role id(s): ${missing.join(", ")}`),
        422,
      );
    }
  }
  if (departmentIds.length > 0) {
    const found = await db.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((d) => d.id));
    const missing = departmentIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return c.json(
        unprocessable(c.req.path, `Unknown department id(s): ${missing.join(", ")}`),
        422,
      );
    }
  }

  // ── 409 — an active user already owns this email (AC-1.3) ───────────────
  const activeUser = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true },
  });
  if (activeUser) {
    return c.json(
      conflict(c.req.path, `An active user already exists with email "${email}"`),
      409,
    );
  }

  // ── 409 — a live pending invitation already exists (AC-1.4) ──────────────
  const existingPending = await findLivePendingInvitationByEmail(db, email);
  if (existingPending) {
    return c.json(
      conflict(
        c.req.path,
        `A pending invitation already exists for "${email}" (id: ${existingPending.id})`,
      ),
      409,
    );
  }

  const token = await generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const created = await withAudit({
    affectedUserIds: [],
    mutate: async (tx) => {
      // Reconcile-on-write (ADR-0013, AC-1.5/AC-1.14) — INSIDE the same
      // transaction as the insert, so the partial-unique index never sees
      // a stale row it should have excluded.
      await reconcileExpiredPending(tx, email);
      return createInvitationRow(tx, {
        email,
        roleIds,
        departmentIds,
        invitedByUserId: actor.id,
        tokenHash: token.hash,
        expiresAt,
      });
    },
    entry: (invitation) => ({
      actorUserId: actor.id,
      action: "invitation.create",
      targetType: "invitation",
      targetId: invitation.id,
      summary: `Invited ${invitation.email}`,
      data: { roleIds, departmentIds },
    }),
  });

  // ── Email send — AFTER commit, never blocks the invitation itself ───────
  const delivery = await sendInvitationEmail({
    to: created.email,
    template: "invitation",
    inviteUrl: buildInviteUrl(created.id, token.raw),
    inviterName: actor.name,
    expiresAt: created.expiresAt.toISOString(),
  });

  const withDelivery = await updateEmailDelivery(created.id, delivery);

  return c.json(await serializeInvitation(withDelivery), 201);
});

// ─── GET /admin/invitations ────────────────────────────────────────────────────

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/admin/invitations",
  tags: ["Admin"],
  summary: "List invitations (paginated, filterable by effective status, searchable by email)",
  request: { query: ListInvitationsQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: InvitationListResponseSchema } },
      description: "A page of invitations",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
  },
});

invitationsRouter.openapi(listInvitationsRoute, async (c) => {
  const { page, pageSize, status, q } = c.req.valid("query");

  const { items, total } = await listInvitations({
    page,
    pageSize,
    ...(status !== undefined ? { status } : {}),
    ...(q !== undefined ? { q } : {}),
  });
  const serialized = await Promise.all(items.map(serializeInvitation));

  return c.json({ items: serialized, page, pageSize, total }, 200);
});

// ─── POST /admin/invitations/:id/resend ────────────────────────────────────────

const resendInvitationRoute = createRoute({
  method: "post",
  path: "/admin/invitations/{id}/resend",
  tags: ["Admin"],
  summary: "Resend an invitation — rotates the token, resets the 72h window",
  request: { params: InvitationIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: InvitationDetailSchema } },
      description: "The invitation, re-sent with a fresh token/expiry",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No invitation with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "The invitation's effective status is already accepted or revoked (AC-3.4)",
    },
  },
});

invitationsRouter.openapi(resendInvitationRoute, async (c) => {
  const { id } = c.req.valid("param");
  const actor = c.get("user")!;

  const existing = await findInvitationById(id);
  if (!existing) {
    return c.json(notFound(c.req.path, `No invitation with id "${id}"`), 404);
  }

  const effective = effectiveInvitationStatus(existing);
  if (isTerminalStatus(effective)) {
    return c.json(
      unprocessable(
        c.req.path,
        `Cannot resend an invitation that is already ${effective}`,
      ),
      422,
    );
  }

  const token = await generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const updated = await withAudit({
    affectedUserIds: [],
    mutate: (tx) =>
      updateForResend(tx, id, {
        tokenHash: token.hash,
        expiresAt,
        invitedByUserId: actor.id,
      }),
    entry: {
      actorUserId: actor.id,
      action: "invitation.resend",
      targetType: "invitation",
      targetId: id,
      summary: `Resent invitation to ${existing.email}`,
    },
  });

  const delivery = await sendInvitationEmail({
    to: updated.email,
    template: "invitation_resend",
    inviteUrl: buildInviteUrl(updated.id, token.raw),
    inviterName: actor.name,
    expiresAt: updated.expiresAt.toISOString(),
  });

  const withDelivery = await updateEmailDelivery(id, delivery);

  return c.json(await serializeInvitation(withDelivery), 200);
});

// ─── POST /admin/invitations/:id/revoke ────────────────────────────────────────

const revokeInvitationRoute = createRoute({
  method: "post",
  path: "/admin/invitations/{id}/revoke",
  tags: ["Admin"],
  summary: "Revoke an invitation — terminal, invalidates the link immediately",
  request: { params: InvitationIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: InvitationDetailSchema } },
      description: "The now-revoked invitation",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No invitation with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "The invitation's effective status is already accepted or revoked (AC-1.10/1.11)",
    },
  },
});

invitationsRouter.openapi(revokeInvitationRoute, async (c) => {
  const { id } = c.req.valid("param");
  const actor = c.get("user")!;

  const existing = await findInvitationById(id);
  if (!existing) {
    return c.json(notFound(c.req.path, `No invitation with id "${id}"`), 404);
  }

  const effective = effectiveInvitationStatus(existing);
  if (isTerminalStatus(effective)) {
    return c.json(
      unprocessable(
        c.req.path,
        `Cannot revoke an invitation that is already ${effective}`,
      ),
      422,
    );
  }

  const updated = await withAudit({
    affectedUserIds: [],
    mutate: (tx) => updateForRevoke(tx, id),
    entry: {
      actorUserId: actor.id,
      action: "invitation.revoke",
      targetType: "invitation",
      targetId: id,
      summary: `Revoked invitation to ${existing.email}`,
    },
  });

  return c.json(await serializeInvitation(updated), 200);
});
