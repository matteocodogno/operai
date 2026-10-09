/**
 * The database half of the legacy import (T23, specs/015-hardware-inventory;
 * US-12, ADR-0046). One transaction, under the entity advisory lock every dated
 * write takes, so an import and a register/close on `welld_ch` serialise; any
 * throw rolls the lot back. The tables it writes to (`asset_year_figure`,
 * `fiscal_year`, `asset_event`) are append-only at the database, so a wrong
 * import cannot be patched afterwards - which is why the caller refuses on the
 * smallest doubt and this module re-checks every precondition UNDER the lock.
 *
 * Idempotent by state, not by file: when the entity already holds imported data
 * the run writes nothing and only verifies it (`already_imported`).
 */

import { db } from "../../src/lib/db";
import { lockEntity, type Tx } from "../../src/fiscal-years/guard";
import { recordEvent, type Change } from "../../src/history/record";
import {
  CLOSED_YEARS,
  ENTITY,
  IMPORT_ACTOR,
  LAST_IMPORTED_YEAR,
  type Plan,
  type PlannedAsset,
} from "./plan";

const BATCH = 500;

/** The import was refused for a reason in the database, with nothing written. */
export class ImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefused";
  }
}

export interface EntityState {
  readonly importedAssets: number;
  readonly otherAssets: number;
  readonly importedFiscalYears: number;
  readonly otherFiscalYears: number;
  /** Σ closing value at 31.12.LAST_IMPORTED_YEAR of the imported figures. */
  readonly importedClosingCents: number;
}

export async function readEntityState(client: Tx | typeof db): Promise<EntityState> {
  const [importedAssets, otherAssets, importedFiscalYears, otherFiscalYears, sum] = await Promise.all([
    client.asset.count({ where: { entity: ENTITY, legacyImported: true } }),
    client.asset.count({ where: { entity: ENTITY, legacyImported: false } }),
    client.fiscalYear.count({ where: { entity: ENTITY, source: "imported" } }),
    client.fiscalYear.count({ where: { entity: ENTITY, source: "closed" } }),
    client.assetYearFigure.aggregate({
      where: { entity: ENTITY, year: LAST_IMPORTED_YEAR, source: "imported" },
      _sum: { closingCents: true },
    }),
  ]);
  return {
    importedAssets,
    otherAssets,
    importedFiscalYears,
    otherFiscalYears,
    importedClosingCents: sum._sum.closingCents ?? 0,
  };
}

/** Whether the entity already holds the output of an import (and nothing else is in the way). */
export function classify(state: EntityState): "empty" | "imported" | "blocked" {
  if (state.otherAssets > 0 || state.otherFiscalYears > 0) return "blocked";
  const some = state.importedAssets > 0 || state.importedFiscalYears > 0;
  if (!some) return "empty";
  // Anything in between means a previous run did not finish in one transaction, which cannot happen.
  if (state.importedAssets === 0 || state.importedFiscalYears !== CLOSED_YEARS.length) return "blocked";
  return "imported";
}

export type ApplyResult =
  | { readonly kind: "applied"; readonly assets: number; readonly closingCents: number }
  | { readonly kind: "already_imported"; readonly assets: number; readonly closingCents: number };

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function importedChanges(a: PlannedAsset): Change[] {
  const changes: Change[] = [
    { field: "sheetRow", from: null, to: a.sheetRow },
    { field: "status", from: null, to: a.status === "disposed" ? "in_stock" : a.status },
    { field: "purchaseDate", from: null, to: a.purchaseDate },
    { field: "purchasePriceCents", from: null, to: a.priceCents },
  ];
  if (a.holderUserId !== null) changes.push({ field: "holder", from: null, to: a.holderUserId });
  return changes;
}

async function insertInBatches<T>(rows: readonly T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/**
 * Writes the plan. The caller has already refused errors and a wrong expected
 * balance; this re-checks what only the database knows, under the lock, and
 * verifies its own output before committing.
 */
export async function applyPlan(plan: Plan, expectedClosingCents: number): Promise<ApplyResult> {
  return db.$transaction(
    async (tx) => {
      await lockEntity(tx, ENTITY);

      const state = await readEntityState(tx);
      const kind = classify(state);
      if (kind === "blocked") {
        throw new ImportRefused(
          `${ENTITY} already holds assets or closed fiscal years that did not come from this import ` +
            `(assets: ${state.otherAssets} other, ${state.importedAssets} imported; fiscal years: ${state.otherFiscalYears} other, ${state.importedFiscalYears} imported). ` +
            `The import only runs on an entity with no assets and no closed years.`,
        );
      }
      if (kind === "imported") {
        if (state.importedClosingCents !== expectedClosingCents) {
          throw new ImportRefused(
            `${ENTITY} was already imported, but the imported closing value at 31.12.${LAST_IMPORTED_YEAR} (${state.importedClosingCents} cents) is not the expected ${expectedClosingCents}`,
          );
        }
        return { kind: "already_imported" as const, assets: state.importedAssets, closingCents: state.importedClosingCents };
      }

      const now = new Date();
      const ids = plan.assets.map(() => crypto.randomUUID());

      await insertInBatches(plan.assets.map((a, i) => ({ a, id: ids[i]! })), (batch) =>
        tx.asset.createMany({
          data: batch.map(({ a, id }) => ({
            id,
            entity: ENTITY,
            currency: "CHF" as const,
            category: a.category,
            description: a.description,
            serialNumber: a.serialNumber,
            purchaseDate: toDate(a.purchaseDate),
            purchasePriceCents: a.priceCents,
            status: a.status,
            holderUserId: a.holderUserId,
            locationNote: a.locationNote,
            toVerify: a.toVerify,
            legacyImported: true,
            disposedOn: a.disposal ? toDate(a.disposal.date) : null,
            disposalReason: a.disposal ? ("ceded_to_employee" as const) : null,
            salePriceCents: a.disposal ? a.disposal.salePriceCents : null,
            createdByUserId: IMPORT_ACTOR,
          })),
        }),
      );

      // AC-12.7: an assigned asset carries an assignment that is already confirmed.
      const assigned = plan.assets
        .map((a, i) => ({ a, id: ids[i]! }))
        .filter(({ a }) => a.status === "assigned" && a.holderUserId !== null);
      await insertInBatches(assigned, (batch) =>
        tx.assignment.createMany({
          data: batch.map(({ a, id }) => ({
            assetId: id,
            assigneeUserId: a.holderUserId!,
            status: "confirmed" as const,
            createdByUserId: IMPORT_ACTOR,
            resolvedAt: now,
            resolvedByUserId: IMPORT_ACTOR,
          })),
        }),
      );

      const figures = plan.assets.flatMap((a, i) =>
        a.figures.map((f) => ({
          assetId: ids[i]!,
          entity: ENTITY,
          year: f.year,
          openingCents: f.openingCents,
          purchaseCents: f.purchaseCents,
          depreciationCents: f.depreciationCents,
          disposalCents: f.disposalCents,
          closingCents: f.closingCents,
          source: "imported" as const,
        })),
      );
      await insertInBatches(figures, (batch) => tx.assetYearFigure.createMany({ data: batch }));

      await tx.fiscalYear.createMany({
        data: plan.fiscalYears.map((fy) => ({
          entity: ENTITY,
          year: fy.year,
          openingCents: fy.openingCents,
          disposalsCents: fy.disposalsCents,
          purchasesCents: fy.purchasesCents,
          depreciationCents: fy.depreciationCents,
          closingCents: fy.closingCents,
          source: "imported" as const,
          closedByUserId: IMPORT_ACTOR,
        })),
      });

      const actor = { userId: IMPORT_ACTOR, email: IMPORT_ACTOR };
      for (const [i, a] of plan.assets.entries()) {
        await recordEvent(tx, { assetId: ids[i]!, entity: ENTITY, action: "imported", actor, changes: importedChanges(a) });
        if (a.disposal) {
          await recordEvent(tx, {
            assetId: ids[i]!,
            entity: ENTITY,
            action: "disposed",
            actor,
            changes: [
              { field: "status", from: "in_stock", to: "disposed" },
              { field: "disposedOn", from: null, to: a.disposal.date },
              { field: "reason", from: null, to: "ceded_to_employee" },
              { field: "salePriceCents", from: null, to: a.disposal.salePriceCents },
            ],
          });
        }
      }

      // Verify what was written, from the database, before letting it commit.
      const after = await readEntityState(tx);
      if (
        after.importedAssets !== plan.assets.length ||
        after.importedFiscalYears !== plan.fiscalYears.length ||
        after.importedClosingCents !== expectedClosingCents
      ) {
        throw new ImportRefused(
          `post-write check failed: ${after.importedAssets} assets, ${after.importedFiscalYears} fiscal years, closing ${after.importedClosingCents} ` +
            `(expected ${plan.assets.length}, ${plan.fiscalYears.length}, ${expectedClosingCents}). Nothing was written.`,
        );
      }
      return { kind: "applied" as const, assets: after.importedAssets, closingCents: after.importedClosingCents };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}
