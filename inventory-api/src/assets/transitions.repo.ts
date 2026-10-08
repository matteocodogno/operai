/**
 * Status transitions (T14, specs/015; AC-1.8, AC-3.1..3.5, AC-11.1).
 *
 * Table-driven: each route names the statuses it may start from and where it
 * lands. One transaction per call: asset row lock, fresh read, checks, then a
 * compare-and-set on `status` (the lock already serialises writers; the CAS is
 * the second line), then the history entry. Two concurrent calls on one asset
 * cannot both apply: the second sees the first's result and is refused.
 */

import { db } from "../lib/db";
import { conflict, notFound } from "../lib/problem";
import { recordEvent, type AssetEventAction, type Change } from "../history/record";
import { lockAsset } from "./lockAsset";

export type Transition = "receive" | "return" | "repair" | "repair-done" | "lost" | "found";
type Status = "ordered" | "in_stock" | "assigned" | "in_repair" | "lost" | "disposed";

interface Rule {
  readonly from: readonly Status[];
  readonly action: AssetEventAction;
  /** Target status, given whether the asset has a holder. */
  readonly to: (hasHolder: boolean) => Status;
  readonly clearsHolder: boolean;
  /** Refused while an assignment is pending (the offer would be left dangling). */
  readonly blockedByPending: boolean;
}

export const TRANSITIONS: Record<Transition, Rule> = {
  receive: { from: ["ordered"], action: "received", to: () => "in_stock", clearsHolder: false, blockedByPending: false },
  return: { from: ["assigned"], action: "returned", to: () => "in_stock", clearsHolder: true, blockedByPending: false },
  repair: {
    from: ["in_stock", "assigned"],
    action: "repair_started",
    to: () => "in_repair",
    clearsHolder: false,
    blockedByPending: true,
  },
  "repair-done": {
    from: ["in_repair"],
    action: "repair_finished",
    to: (hasHolder) => (hasHolder ? "assigned" : "in_stock"),
    clearsHolder: false,
    blockedByPending: false,
  },
  lost: {
    from: ["in_stock", "assigned", "in_repair"],
    action: "marked_lost",
    to: () => "lost",
    clearsHolder: true,
    blockedByPending: true,
  },
  found: { from: ["lost"], action: "marked_found", to: () => "in_stock", clearsHolder: false, blockedByPending: false },
};

export interface TransitionInput {
  readonly id: string;
  readonly kind: Transition;
  readonly actor: { readonly userId: string; readonly email: string };
}

/** Applies the transition; throws a ProblemError for every refusal. */
export async function applyTransition({ id, kind, actor }: TransitionInput): Promise<void> {
  const rule = TRANSITIONS[kind];
  await db.$transaction(async (tx) => {
    await lockAsset(tx, id);
    const cur = await tx.asset.findUnique({ where: { id } });
    if (!cur) throw notFound("Asset not found");
    if (cur.status === "disposed") {
      throw conflict("asset_disposed", "A disposed asset accepts no further changes", { assetId: id });
    }
    if (!rule.from.includes(cur.status)) {
      throw conflict("invalid_transition", `Cannot ${kind} an asset that is ${cur.status}`, {
        from: cur.status,
      });
    }
    if (rule.blockedByPending) {
      const pending = await tx.assignment.findFirst({
        where: { assetId: id, status: "pending" },
        select: { id: true },
      });
      if (pending) {
        throw conflict("assignment_pending", "Resolve the pending assignment first", {
          assignmentId: pending.id,
        });
      }
    }

    const to = rule.to(cur.holderUserId !== null);
    const cas = await tx.asset.updateMany({
      where: { id, status: cur.status },
      data: { status: to, ...(rule.clearsHolder ? { holderUserId: null } : {}) },
    });
    if (cas.count !== 1) {
      throw conflict("invalid_transition", "The asset changed while this was being applied", {
        from: cur.status,
      });
    }

    const changes: Change[] = [{ field: "status", from: cur.status, to }];
    if (rule.clearsHolder && cur.holderUserId !== null) {
      changes.unshift({ field: "holder", from: cur.holderUserId, to: null });
    }
    await recordEvent(tx, { assetId: id, entity: cur.entity, action: rule.action, actor, changes });
  });
}
