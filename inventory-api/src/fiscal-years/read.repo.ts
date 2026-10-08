/**
 * Data loading for the fiscal-year views and the close (T19/T20, specs/015).
 * One entity at a time: every asset, its rules, every stored figure and the
 * fiscal_year rows. Hundreds of assets, a handful of years (plan R-8), so a
 * handful of flat queries and the arithmetic in memory.
 */

import type { Tx } from "./guard";
import type { Asset, DepreciationRule, FiscalYear } from "../lib/generated/prisma/client";
import { resolveRule } from "../depreciation/resolveRule";
import type { DepreciationRule as RuleInputs } from "../depreciation/schedule";
import type { Entity } from "../authz/conditions";
import type { RollAsset, StoredFigureRow } from "./rollForward";

export interface EntityContext {
  readonly entity: Entity;
  readonly assets: readonly Asset[];
  readonly rules: readonly DepreciationRule[];
  readonly stored: readonly StoredFigureRow[];
  readonly fiscalYears: readonly FiscalYear[];
  readonly lastClosedYear: number | null;
}

export async function loadEntityContext(client: Tx, entity: Entity): Promise<EntityContext> {
  const [assets, rules, figures, fiscalYears] = await Promise.all([
    client.asset.findMany({ where: { entity } }),
    client.depreciationRule.findMany({ where: { entity } }),
    client.assetYearFigure.findMany({ where: { entity } }),
    client.fiscalYear.findMany({ where: { entity }, orderBy: { year: "asc" } }),
  ]);
  const stored: StoredFigureRow[] = figures.map((f) => ({
    assetId: f.assetId,
    year: f.year,
    openingCents: f.openingCents,
    purchaseCents: f.purchaseCents,
    depreciationCents: f.depreciationCents,
    disposalCents: f.disposalCents,
    closingCents: f.closingCents,
    source: f.source,
  }));
  const last = fiscalYears[fiscalYears.length - 1];
  return { entity, assets, rules, stored, fiscalYears, lastClosedYear: last ? last.year : null };
}

export const toRollAsset = (a: Asset): RollAsset => ({
  id: a.id,
  purchaseDate: a.purchaseDate,
  purchasePriceCents: a.purchasePriceCents,
  disposedOn: a.disposedOn,
  legacyImported: a.legacyImported,
});

/** The rule in force for the asset, resolved on read (ADR-0046); throws when none applies. */
export function ruleResolver(ctx: EntityContext): (asset: RollAsset) => RuleInputs {
  return (asset) => {
    const rule = resolveRule(ctx.rules, ctx.entity, asset.purchaseDate);
    if (!rule) {
      throw new Error(`no depreciation rule in force for asset ${asset.id} (${ctx.entity})`);
    }
    return rule;
  };
}
