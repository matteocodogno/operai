/**
 * Assignments, manager side (T15, specs/015; AC-2.1, AC-2.2, AC-2.5, AC-2.10,
 * AC-11.1). One transaction each: asset row lock, fresh read, checks, write,
 * history. At most one `pending` per asset is enforced by the database
 * (`assignment_one_pending`); its violation is mapped here rather than trusting
 * the read that precedes it.
 */

import { db } from "../lib/db";
import { conflict, notFound } from "../lib/problem";
import { recordEvent } from "../history/record";
import { lockAsset } from "../assets/lockAsset";

type Actor = { readonly userId: string; readonly email: string };

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export interface CreatedAssignment {
  readonly assignmentId: string;
  readonly assetId: string;
  readonly assetDescription: string;
}

export async function createAssignment(input: {
  assetId: string;
  assigneeUserId: string;
  actor: Actor;
}): Promise<CreatedAssignment> {
  const { assetId, assigneeUserId, actor } = input;
  try {
    return await db.$transaction(async (tx) => {
      await lockAsset(tx, assetId);
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw notFound("Asset not found");
      if (asset.status === "disposed") {
        throw conflict("asset_disposed", "A disposed asset accepts no further changes", { assetId });
      }
      if (asset.status !== "in_stock") {
        throw conflict("invalid_transition", `Only an in_stock asset can be assigned, this one is ${asset.status}`, {
          from: asset.status,
        });
      }
      const pending = await tx.assignment.findFirst({
        where: { assetId, status: "pending" },
        select: { id: true },
      });
      if (pending) {
        throw conflict("assignment_pending", "This asset already has a pending assignment", {
          assignmentId: pending.id,
        });
      }

      const row = await tx.assignment.create({
        data: { assetId, assigneeUserId, createdByUserId: actor.userId },
      });
      await recordEvent(tx, {
        assetId,
        entity: asset.entity,
        action: "assignment_created",
        actor,
        changes: [{ field: "assignee", from: null, to: assigneeUserId }],
      });
      return { assignmentId: row.id, assetId, assetDescription: asset.description };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const pending = await db.assignment.findFirst({
        where: { assetId, status: "pending" },
        select: { id: true },
      });
      throw conflict(
        "assignment_pending",
        "This asset already has a pending assignment",
        pending ? { assignmentId: pending.id } : {},
      );
    }
    throw err;
  }
}

/** The assignment and the entity of its asset, for the route's scope check. */
export function findAssignmentWithAsset(id: string) {
  return db.assignment.findUnique({
    where: { id },
    select: { id: true, assetId: true },
  });
}

export async function cancelAssignment(input: { assignmentId: string; actor: Actor }): Promise<string> {
  const { assignmentId, actor } = input;
  return db.$transaction(async (tx) => {
    const found = await tx.assignment.findUnique({ where: { id: assignmentId }, select: { assetId: true } });
    if (!found) throw notFound("Assignment not found");
    await lockAsset(tx, found.assetId);

    const cas = await tx.assignment.updateMany({
      where: { id: assignmentId, status: "pending" },
      data: { status: "cancelled", resolvedAt: new Date(), resolvedByUserId: actor.userId },
    });
    if (cas.count !== 1) {
      throw conflict("assignment_not_pending", "This assignment is no longer pending");
    }
    const row = await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: row.assetId }, select: { entity: true } });
    await recordEvent(tx, {
      assetId: row.assetId,
      entity: asset.entity,
      action: "assignment_cancelled",
      actor,
      changes: [{ field: "assignee", from: row.assigneeUserId, to: null }],
    });
    return row.assetId;
  });
}
