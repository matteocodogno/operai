/**
 * `/me/*` data access (T16, specs/015; AC-2.3, AC-2.4, AC-2.7, AC-4.1,
 * ADR-0045). Every query is scoped to the verified `sub` the caller passes in;
 * there is no query by asset or assignment alone that is not re-checked
 * against it.
 */

import { db } from "../lib/db";
import { conflict, notFound } from "../lib/problem";
import { recordEvent } from "../history/record";
import { lockAsset } from "../assets/lockAsset";
import { toMyDevice, type MyDevice, type MyPending } from "./me.schemas";

type Actor = { readonly userId: string; readonly email: string };

const ASSET_SELECT = { id: true, description: true, category: true, serialNumber: true } as const;

export async function myDevices(sub: string): Promise<{ devices: MyDevice[]; pending: MyPending[] }> {
  const held = await db.asset.findMany({
    where: { holderUserId: sub, status: { not: "disposed" } },
    select: { ...ASSET_SELECT, updatedAt: true },
  });
  const confirmed = held.length
    ? await db.assignment.findMany({
        where: { assigneeUserId: sub, status: "confirmed", assetId: { in: held.map((a) => a.id) } },
        orderBy: { resolvedAt: "desc" },
        select: { assetId: true, resolvedAt: true, createdAt: true },
      })
    : [];
  const since = new Map<string, Date>();
  for (const row of confirmed) {
    if (!since.has(row.assetId)) since.set(row.assetId, row.resolvedAt ?? row.createdAt);
  }
  const devices = held
    .map((a) => toMyDevice(a, since.get(a.id) ?? a.updatedAt))
    .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt) || a.description.localeCompare(b.description));

  const offers = await db.assignment.findMany({
    where: { assigneeUserId: sub, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, assetId: true, createdAt: true },
  });
  const assets = offers.length
    ? await db.asset.findMany({
        where: { id: { in: offers.map((o) => o.assetId) }, status: { not: "disposed" } },
        select: ASSET_SELECT,
      })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const pending = offers.flatMap((o) => {
    const asset = byId.get(o.assetId);
    return asset ? [{ assignmentId: o.id, ...toMyDevice(asset, o.createdAt) }] : [];
  });
  return { devices, pending };
}

export interface Answered {
  readonly device: MyDevice;
  readonly assignmentId: string;
  readonly assetId: string;
  readonly assetDescription: string;
  readonly createdByUserId: string;
}

/**
 * The assignee's answer. Not-yours and unknown are the same 404; yours but no
 * longer pending is 409. The status change is a compare-and-set on
 * `pending`, under the asset row lock.
 */
export async function answerAssignment(input: {
  assignmentId: string;
  sub: string;
  actor: Actor;
  outcome: "confirmed" | "declined";
}): Promise<Answered> {
  const { assignmentId, sub, actor, outcome } = input;
  return db.$transaction(async (tx) => {
    const found = await tx.assignment.findUnique({ where: { id: assignmentId } });
    if (!found || found.assigneeUserId !== sub) throw notFound("Assignment not found");
    await lockAsset(tx, found.assetId);

    const now = new Date();
    const cas = await tx.assignment.updateMany({
      where: { id: assignmentId, assigneeUserId: sub, status: "pending" },
      data: { status: outcome, resolvedAt: now, resolvedByUserId: sub },
    });
    if (cas.count !== 1) {
      throw conflict("assignment_not_pending", "This assignment is no longer waiting for an answer");
    }

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: found.assetId } });
    if (outcome === "confirmed") {
      const moved = await tx.asset.updateMany({
        where: { id: asset.id, status: "in_stock" },
        data: { status: "assigned", holderUserId: sub },
      });
      // Unreachable while pending blocks repair, lost and disposal; if it ever
      // is reached, undoing the confirmation is the only safe answer.
      if (moved.count !== 1) {
        throw conflict("invalid_transition", "The asset can no longer be handed over", { from: asset.status });
      }
      await recordEvent(tx, {
        assetId: asset.id,
        entity: asset.entity,
        action: "assignment_confirmed",
        actor,
        changes: [
          { field: "status", from: "in_stock", to: "assigned" },
          { field: "holder", from: null, to: sub },
        ],
      });
    } else {
      await recordEvent(tx, {
        assetId: asset.id,
        entity: asset.entity,
        action: "assignment_declined",
        actor,
        changes: [{ field: "assignee", from: sub, to: null }],
      });
    }
    return {
      device: toMyDevice(asset, now),
      assignmentId,
      assetId: asset.id,
      assetDescription: asset.description,
      createdByUserId: found.createdByUserId,
    };
  });
}
