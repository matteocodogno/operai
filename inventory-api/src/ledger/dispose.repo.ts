/**
 * Disposing of an asset (T18, specs/015; AC-7.1..AC-7.6, AC-11.1, ADR-0046).
 *
 * A disposal is a DATED write: it moves book value into a fiscal year's
 * disposals line. So, in ONE transaction: the entity advisory lock FIRST (a
 * close in flight must commit before this reads the closed boundary), then the
 * asset row lock, a fresh read, the guards, a compare-and-set on `status`, and
 * the history entry. Any throw rolls the lot back.
 *
 * Nothing is written to the ledger: the written-off value is DERIVED on read
 * from `disposedOn` (`yearFigure` puts the remaining book value on the
 * disposals line of that year and zero from then on) and snapshotted by the
 * close, like every other figure.
 */

import { db } from "../lib/db";
import { conflict, notFound, unprocessable } from "../lib/problem";
import { assertYearOpen, lockEntity, yearOf, type Tx } from "../fiscal-years/guard";
import { recordEvent, type Change } from "../history/record";
import { lockAsset } from "../assets/lockAsset";
import { formatDate, parseIsoDate } from "../depreciation/rules.schemas";
import { REASONS_WITH_SALE_PRICE, type DisposeBody } from "./dispose.schemas";

export interface DisposeInput {
  readonly id: string;
  readonly body: DisposeBody;
  readonly actor: { readonly userId: string; readonly email: string };
}

/** Validation that needs no row: refuse before taking any lock. */
export function assertSalePriceAllowed(body: DisposeBody): void {
  if (body.salePriceCents !== undefined && !REASONS_WITH_SALE_PRICE.includes(body.reason)) {
    throw unprocessable(
      "A sale price can only be recorded when the asset is sold or ceded to an employee",
      { field: "salePriceCents" },
      "sale_price_not_allowed",
    );
  }
}

export async function disposeAsset({ id, body, actor }: DisposeInput): Promise<void> {
  assertSalePriceAllowed(body);
  const disposedOn = parseIsoDate(body.disposedOn)!; // validated by the schema

  await db.$transaction(
    async (tx: Tx) => {
      const pre = await tx.asset.findUnique({ where: { id }, select: { entity: true } });
      if (!pre) throw notFound("Asset not found");
      await lockEntity(tx, pre.entity);
      await lockAsset(tx, id);

      const cur = await tx.asset.findUnique({ where: { id } });
      if (!cur) throw notFound("Asset not found");
      if (cur.status === "disposed") {
        throw conflict("asset_disposed", "This asset has already been disposed of", { assetId: id });
      }
      const pending = await tx.assignment.findFirst({
        where: { assetId: id, status: "pending" },
        select: { id: true },
      });
      if (pending) {
        throw conflict("assignment_pending", "Resolve the pending assignment before disposing of this asset", {
          assignmentId: pending.id,
        });
      }
      if (disposedOn.getTime() < cur.purchaseDate.getTime()) {
        throw unprocessable(
          `The disposal date cannot be before the purchase date (${formatDate(cur.purchaseDate)})`,
          { field: "disposedOn" },
          "disposed_before_purchase",
        );
      }
      await assertYearOpen(tx, cur.entity, yearOf(disposedOn));

      const cas = await tx.asset.updateMany({
        where: { id, status: cur.status },
        data: {
          status: "disposed",
          holderUserId: null,
          disposedOn,
          disposalReason: body.reason,
          salePriceCents: body.salePriceCents ?? null,
        },
      });
      if (cas.count !== 1) {
        throw conflict("asset_disposed", "The asset changed while this was being applied", { assetId: id });
      }

      const changes: Change[] = [{ field: "status", from: cur.status, to: "disposed" }];
      if (cur.holderUserId !== null) changes.push({ field: "holder", from: cur.holderUserId, to: null });
      changes.push(
        { field: "disposedOn", from: null, to: body.disposedOn },
        { field: "reason", from: null, to: body.reason },
      );
      if (body.salePriceCents !== undefined) {
        changes.push({ field: "salePriceCents", from: null, to: body.salePriceCents });
      }
      await recordEvent(tx, { assetId: id, entity: cur.entity, action: "disposed", actor, changes });
    },
    { timeout: 20_000 },
  );
}
