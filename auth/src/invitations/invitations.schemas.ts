/**
 * Zod wire schemas for the invitation admin API (T5/T6, specs/006-user-
 * invitations — plan.md "API contracts" / "Invitation admin API").
 *
 * Shared between `invitations.routes.ts` (request validation + OpenAPI
 * response schemas) and any future consumer that needs the same shape.
 */

import { z } from "zod";

// ─── Request bodies ──────────────────────────────────────────────────────────

export const CreateInvitationBodySchema = z.object({
  email: z.string().trim().email(),
  roleIds: z.array(z.string().min(1)).optional().default([]),
  departmentIds: z.array(z.string().min(1)).optional().default([]),
});

export const InvitationIdParamSchema = z.object({
  id: z.string().min(1),
});

export const EFFECTIVE_STATUS_VALUES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;

export const ListInvitationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(EFFECTIVE_STATUS_VALUES).optional(),
  q: z.string().trim().min(1).optional(),
});

// ─── Response shapes ──────────────────────────────────────────────────────────

export const RoleSummarySchema = z.object({ id: z.string(), name: z.string() });
export const DepartmentSummarySchema = z.object({ id: z.string(), name: z.string() });
export const InviterSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

/**
 * `InvitationDetail` — plan.md's `POST /admin/invitations` 201 / resend 200 /
 * revoke 200 / `GET /admin/invitations/*` shape. `status` is always the
 * EFFECTIVE status (AC-4.2: a past-window `pending` row renders `expired`
 * here). `emailDelivery` mirrors the stored `lastEmailStatus` column —
 * `null` only for an invitation whose create/resend email attempt hasn't
 * resolved yet (never observable through this synchronous API, but kept
 * nullable for schema honesty).
 */
export const InvitationDetailSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(EFFECTIVE_STATUS_VALUES),
  roles: z.array(RoleSummarySchema),
  departments: z.array(DepartmentSummarySchema),
  invitedBy: InviterSummarySchema.nullable(),
  invitedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  emailDelivery: z.enum(["sent", "failed"]).nullable(),
});

export const InvitationListResponseSchema = z.object({
  items: z.array(InvitationDetailSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

export type CreateInvitationBody = z.infer<typeof CreateInvitationBodySchema>;
export type ListInvitationsQuery = z.infer<typeof ListInvitationsQuerySchema>;
export type InvitationDetail = z.infer<typeof InvitationDetailSchema>;
