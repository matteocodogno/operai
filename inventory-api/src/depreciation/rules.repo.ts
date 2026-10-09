/**
 * Rules persistence (T10, specs/015). The table is append-only at the database
 * (T2's trigger): there is a list and an insert, and nothing else.
 */

import { db } from "../lib/db";
import { assertYearOpen, lockEntity, yearOf } from "../fiscal-years/guard";
import type { DepreciationRule } from "../lib/generated/prisma/client";
import { resolveRule } from "./resolveRule";

export type Entity = "welld_ch" | "welld_it";

/** Newest `effectiveFrom` first; ties newest-created first. */
export function listRulesFor(entity: Entity): Promise<DepreciationRule[]> {
  return db.depreciationRule.findMany({
    where: { entity },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

/** The rule in force today: resolved exactly like an asset purchased today. */
export function inForce(
  rules: readonly DepreciationRule[],
  entity: Entity,
  now: Date = new Date(),
): DepreciationRule | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return resolveRule(rules, entity, today);
}

export interface NewRule {
  readonly entity: Entity;
  readonly effectiveFrom: Date;
  readonly usefulLifeYears: number;
  readonly firstYearShare: "full" | "half";
  readonly lowValueThresholdCents: number | null;
  readonly residualCents: number;
  readonly actor: { readonly userId: string; readonly email: string };
}

/**
 * Appends a rule. Entity lock first, then the closed-year read (T9's order), so
 * a rule cannot slip into a year that a concurrent close is sealing.
 */
export function createRule(input: NewRule): Promise<DepreciationRule> {
  return db.$transaction(async (tx) => {
    await lockEntity(tx, input.entity);
    await assertYearOpen(tx, input.entity, yearOf(input.effectiveFrom));
    return tx.depreciationRule.create({
      data: {
        entity: input.entity,
        effectiveFrom: input.effectiveFrom,
        usefulLifeYears: input.usefulLifeYears,
        firstYearShare: input.firstYearShare,
        lowValueThresholdCents: input.lowValueThresholdCents,
        residualCents: input.residualCents,
        createdByUserId: input.actor.userId,
        createdByEmail: input.actor.email,
        // Set after the lock is held: the column default is the transaction's
        // start time, which a writer that queued on the lock would carry from
        // BEFORE the writer it queued behind.
        createdAt: new Date(),
      },
    });
  });
}
