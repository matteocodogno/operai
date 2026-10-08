/**
 * Reading an asset's history (T22, specs/015; AC-11.3, AC-11.4). The log is
 * append-only (Tier 1), so this is the only thing that ever reads it back.
 */

import { db } from "../lib/db";

/**
 * Every event of the asset, oldest first. `createdAt` is the transaction's
 * time, so two events written by one request share it; the id (a cuid, which
 * sorts by creation) keeps their order stable.
 */
export function findAssetEvents(assetId: string) {
  return db.assetEvent.findMany({
    where: { assetId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
