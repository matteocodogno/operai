/** Schemas and the after-commit event shape for assignments (T15, specs/015). */

import { z } from "@hono/zod-openapi";

export const AssignBodySchema = z.object({
  assigneeUserId: z.string().trim().min(1).max(64),
});

export const AssetIdParamSchema = z.object({ id: z.string().min(1).max(64) });
export const AssignmentIdParamSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * What happened to an assignment, handed to `assignmentHooks.afterCommit` once
 * the transaction that made it true has committed. `created` goes to the
 * assignee (AC-2.8); `confirmed` and `declined` go to `createdByUserId`, the
 * manager who offered it (AC-2.9).
 */
export interface AssignmentEvent {
  readonly kind: "created" | "confirmed" | "declined";
  readonly assignmentId: string;
  readonly assetId: string;
  readonly assetDescription: string;
  readonly assigneeUserId: string;
  readonly createdByUserId: string;
}
