/**
 * Asset reads (T12, specs/015). Data loading only: scope filtering happens in
 * the `where`, and the capability-dependent projection is the route's job.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { Entity } from "../authz/conditions";
import { parseIsoDate } from "../depreciation/rules.schemas";
import { ASSET_INCLUDE, type AssetRow, type PendingAssignmentRow } from "./view";
import { decodeCursor, type ListQuery } from "./read.schemas";
import type { LedgerRuleRow, StoredFigure } from "./ledgerView";

export interface AssetPage {
  readonly rows: AssetRow[];
  readonly hasMore: boolean;
}

/**
 * Ids of the assets in `entities` whose description or serial number contains
 * `q`, case-insensitively. Raw SQL because Prisma's `contains` does not escape
 * `%` and `_`, which would turn a typed "100%" into a wildcard (AC-3.8). The
 * pattern is a bound parameter; `\` is the escape character.
 */
async function idsMatching(entities: readonly Entity[], q: string): Promise<string[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "asset"
    WHERE "entity"::text = ANY(${[...entities]}::text[])
      AND ("description" ILIKE ${pattern} ESCAPE '\\'
           OR "serialNumber" ILIKE ${pattern} ESCAPE '\\')`;
  return rows.map((r) => r.id);
}

/**
 * One page, newest purchase first then id. `readable` is the caller's entity
 * scope; an `entity` filter can only narrow it, never widen it.
 */
export async function findAssetPage(
  readable: readonly Entity[],
  query: ListQuery,
): Promise<AssetPage> {
  const entities = query.entity
    ? readable.filter((e) => e === query.entity)
    : [...readable];
  if (entities.length === 0) return { rows: [], hasMore: false };

  const and: Prisma.AssetWhereInput[] = [{ entity: { in: entities } }];
  if (query.status) and.push({ status: query.status });
  if (query.category) and.push({ category: query.category });
  if (query.holderUserId) and.push({ holderUserId: query.holderUserId });
  if (query.toVerify !== undefined) and.push({ toVerify: query.toVerify });
  if (query.invoiceRef) and.push({ invoiceRef: query.invoiceRef });
  if (query.q) {
    and.push({ id: { in: await idsMatching(entities, query.q) } });
  }
  if (query.cursor) {
    const at = decodeCursor(query.cursor)!;
    const date = parseIsoDate(at.purchaseDate) ?? new Date(0);
    and.push({
      OR: [{ purchaseDate: { lt: date } }, { purchaseDate: date, id: { gt: at.id } }],
    });
  }

  const found = await db.asset.findMany({
    where: { AND: and },
    include: ASSET_INCLUDE,
    orderBy: [{ purchaseDate: "desc" }, { id: "asc" }],
    take: query.limit + 1,
  });
  return { rows: found.slice(0, query.limit), hasMore: found.length > query.limit };
}

/**
 * The supplier names already used on assets in `entities`, for the supplier
 * field's suggestions. Spellings that differ only by case or surrounding
 * spaces are one supplier, shown in its most used spelling, so the suggestion
 * list pulls new entries towards the form the register already prefers.
 */
export async function findSuppliers(entities: readonly Entity[]): Promise<string[]> {
  if (entities.length === 0) return [];
  const rows = await db.asset.groupBy({
    by: ["supplier"],
    where: { entity: { in: [...entities] }, supplier: { not: null } },
    _count: { _all: true },
  });
  // Sum per trimmed spelling first ("Digitec" and "Digitec " are stored apart),
  // then keep one spelling per case-folded name: the most used, and on a tie
  // the first in code-point order so the answer never depends on row order.
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = row.supplier?.trim() ?? "";
    if (name !== "") counts.set(name, (counts.get(name) ?? 0) + row._count._all);
  }
  const best = new Map<string, { name: string; count: number }>();
  for (const [name, count] of counts) {
    const key = name.toLowerCase();
    const seen = best.get(key);
    if (!seen || count > seen.count || (count === seen.count && name < seen.name)) {
      best.set(key, { name, count });
    }
  }
  return [...best.values()]
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1));
}

export function findAsset(id: string): Promise<AssetRow | null> {
  return db.asset.findUnique({ where: { id }, include: ASSET_INCLUDE });
}

/** The (at most one, by the partial unique index) pending assignment of each asset. */
export async function findPendingAssignments(
  assetIds: readonly string[],
): Promise<Map<string, PendingAssignmentRow>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.assignment.findMany({
    where: { assetId: { in: [...assetIds] }, status: "pending" },
    select: { id: true, assetId: true, assigneeUserId: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.assetId, r]));
}

/** Every rule of the given entities, grouped by entity. */
export async function findRules(
  entities: readonly Entity[],
): Promise<Map<string, (LedgerRuleRow & { createdAt: Date; entity: string })[]>> {
  const out = new Map<string, (LedgerRuleRow & { createdAt: Date; entity: string })[]>();
  if (entities.length === 0) return out;
  const rows = await db.depreciationRule.findMany({ where: { entity: { in: [...entities] } } });
  for (const row of rows) {
    const list = out.get(row.entity) ?? [];
    list.push(row);
    out.set(row.entity, list);
  }
  return out;
}

/** `max(fiscal_year.year)` per entity; absent key = nothing closed. */
export async function findLastClosedYears(
  entities: readonly Entity[],
): Promise<Map<string, number>> {
  if (entities.length === 0) return new Map();
  const rows = await db.fiscalYear.groupBy({
    by: ["entity"],
    where: { entity: { in: [...entities] } },
    _max: { year: true },
  });
  const out = new Map<string, number>();
  for (const row of rows) if (row._max.year !== null) out.set(row.entity, row._max.year);
  return out;
}

/** Stored per-year figures of the given assets, grouped by asset. */
export async function findStoredFigures(
  assetIds: readonly string[],
): Promise<Map<string, StoredFigure[]>> {
  const out = new Map<string, StoredFigure[]>();
  if (assetIds.length === 0) return out;
  const rows = await db.assetYearFigure.findMany({ where: { assetId: { in: [...assetIds] } } });
  for (const row of rows) {
    const list = out.get(row.assetId) ?? [];
    list.push({
      year: row.year,
      depreciationCents: row.depreciationCents,
      closingCents: row.closingCents,
      source: row.source,
    });
    out.set(row.assetId, list);
  }
  return out;
}
