/**
 * Data access for the accounting catalog: ledger accounts and VAT codes
 * (T6, specs/20261118-refund-accounting-export; AC-1.1 to AC-1.11; ADR
 * 20260716-immutable-financial-audit-trail-refund, plan § Data model).
 *
 * Shape of the data
 * - An entry (`ledger_account`, `vat_code`) is INSERT-ONLY: number, name, code,
 *   label and rate never change (database trigger, AC-1.5), and it is never
 *   deleted.
 * - Whether it can be chosen is the append-only `accounting_catalog_status`
 *   history. No row means active since creation; the CURRENT state is the
 *   LATEST row. Deactivation and reactivation each append one row with the
 *   actor and the time (AC-1.8), so there is one write path and one audit
 *   trail, not a mutable flag plus a log.
 *
 * Concurrency
 * - A status change locks the entry row (`FOR NO KEY UPDATE`, which does not
 *   block concurrent inserts of lines that reference it) and decides on the
 *   locked state, so two reactivations cannot both succeed (AC-1.11).
 * - "Latest" is ordered by `createdAt` then `id`. A status row's `createdAt` is
 *   set here, after the lock is held, and never earlier than the previous
 *   row's, so lock order IS history order whatever the clocks of two
 *   transactions say.
 * - A concurrent duplicate insert hits the unique index and is reported as the
 *   same `duplicate` outcome as the pre-check (AC-1.2, AC-1.4).
 *
 * Outcomes that are part of the contract (duplicate, already active, not found)
 * are returned as values; a database failure throws and ends as a 500.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import type {
  CatalogHistoryEntry,
  LedgerAccountItem,
  VatCodeItem,
} from "./catalog.schemas";

/** Both catalogs are WellD CH's: the API accepts no other entity in this spec. */
export const CATALOG_ENTITY = "welld_ch" as const;

export type CatalogKind = "ledger_account" | "vat_code";

export interface Actor {
  readonly userId: string;
  readonly email: string;
}

type Client = Prisma.TransactionClient;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * `"8.1"` -> 810, `"8"` -> 800, `"0"` -> 0, `"100"` -> 10000. Exact string
 * arithmetic, no float: the input has already been checked against
 * `VAT_RATE_PERCENT_RE`, and the range 0..100 is enforced here as well, so a
 * caller that skips the schema cannot store a rate the CHECK would refuse.
 */
export function percentToBasisPoints(percent: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent);
  if (!match) throw new RangeError(`not a percentage with at most two decimals: ${JSON.stringify(percent)}`);
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints > 10_000) throw new RangeError(`percentage above 100: ${percent}`);
  return basisPoints;
}

/** 810 -> `"8.1"`, 770 -> `"7.7"`, 805 -> `"8.05"`, 0 -> `"0"`, 10000 -> `"100"`. */
export function basisPointsToPercent(basisPoints: number): string {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`basis points must be a non-negative integer, got ${String(basisPoints)}`);
  }
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

interface StatusRow {
  readonly active: boolean;
  readonly createdAt: Date;
  readonly createdByEmail: string;
}

/** Current state from an entry's status rows, oldest first: no row means active since creation. */
export function isActiveFromStatus(rows: readonly Pick<StatusRow, "active">[]): boolean {
  return rows.length === 0 ? true : rows[rows.length - 1]!.active;
}

function buildHistory(
  created: { createdAt: Date; createdByEmail: string },
  rows: readonly StatusRow[],
): CatalogHistoryEntry[] {
  return [
    { active: true, at: created.createdAt.toISOString(), byEmail: created.createdByEmail },
    ...rows.map((row) => ({ active: row.active, at: row.createdAt.toISOString(), byEmail: row.createdByEmail })),
  ];
}

const statusOrder = [{ createdAt: "asc" }, { id: "asc" }] as const satisfies Prisma.AccountingCatalogStatusOrderByWithRelationInput[];

const statusSelect = { active: true, createdAt: true, createdByEmail: true } as const;

type LedgerAccountRow = Prisma.LedgerAccountGetPayload<{
  include: { statusChanges: { select: typeof statusSelect } };
}>;
type VatCodeRow = Prisma.VatCodeGetPayload<{
  include: { statusChanges: { select: typeof statusSelect } };
}>;

export function mapLedgerAccount(row: LedgerAccountRow): LedgerAccountItem {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    active: isActiveFromStatus(row.statusChanges),
    createdAt: row.createdAt.toISOString(),
    createdByEmail: row.createdByEmail,
    history: buildHistory(row, row.statusChanges),
  };
}

export function mapVatCode(row: VatCodeRow): VatCodeItem {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    rateBasisPoints: row.rateBasisPoints,
    ratePercent: basisPointsToPercent(row.rateBasisPoints),
    active: isActiveFromStatus(row.statusChanges),
    createdAt: row.createdAt.toISOString(),
    createdByEmail: row.createdByEmail,
    history: buildHistory(row, row.statusChanges),
  };
}

const withStatus = { statusChanges: { select: statusSelect, orderBy: statusOrder } } as const;

/** Account numbers compare as numbers first (`2620.1` after `2620`, `599` before `5905`), then as text. */
function compareNumbers(a: string, b: string): number {
  return Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listLedgerAccounts(client: Client = db): Promise<LedgerAccountItem[]> {
  const rows = await client.ledgerAccount.findMany({ where: { entity: CATALOG_ENTITY }, include: withStatus });
  return rows.map(mapLedgerAccount).sort((a, b) => compareNumbers(a.number, b.number));
}

export async function listVatCodes(client: Client = db): Promise<VatCodeItem[]> {
  const rows = await client.vatCode.findMany({ where: { entity: CATALOG_ENTITY }, include: withStatus });
  return rows.map(mapVatCode).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * The current `active` flag of the given entries, by id. An id that does not
 * exist is absent from the map. The one read behind "is this entry usable now"
 * for the defaults, the classification view, the approval freeze and the
 * release script, so they all derive it the same way.
 */
export async function loadActiveFlags(
  client: Client,
  kind: CatalogKind,
  ids: readonly string[],
): Promise<Map<string, boolean>> {
  const unique = [...new Set(ids)];
  const flags = new Map<string, boolean>();
  if (unique.length === 0) return flags;
  const rows =
    kind === "ledger_account"
      ? await client.ledgerAccount.findMany({ where: { id: { in: unique } }, include: withStatus })
      : await client.vatCode.findMany({ where: { id: { in: unique } }, include: withStatus });
  for (const row of rows) flags.set(row.id, isActiveFromStatus(row.statusChanges));
  return flags;
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type CreateOutcome<T> =
  | { readonly kind: "created"; readonly item: T }
  | { readonly kind: "duplicate" };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export async function createLedgerAccount(
  input: { number: string; name: string },
  actor: Actor,
): Promise<CreateOutcome<LedgerAccountItem>> {
  const existing = await db.ledgerAccount.findUnique({
    where: { entity_number: { entity: CATALOG_ENTITY, number: input.number } },
    select: { id: true },
  });
  if (existing) return { kind: "duplicate" };
  try {
    const row = await db.ledgerAccount.create({
      data: {
        entity: CATALOG_ENTITY,
        number: input.number,
        name: input.name,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
      include: withStatus,
    });
    return { kind: "created", item: mapLedgerAccount(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "duplicate" };
    throw error;
  }
}

export async function createVatCode(
  input: { code: string; label: string; rateBasisPoints: number },
  actor: Actor,
): Promise<CreateOutcome<VatCodeItem>> {
  const existing = await db.vatCode.findUnique({
    where: { entity_code: { entity: CATALOG_ENTITY, code: input.code } },
    select: { id: true },
  });
  if (existing) return { kind: "duplicate" };
  try {
    const row = await db.vatCode.create({
      data: {
        entity: CATALOG_ENTITY,
        code: input.code,
        label: input.label,
        rateBasisPoints: input.rateBasisPoints,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
      include: withStatus,
    });
    return { kind: "created", item: mapVatCode(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "duplicate" };
    throw error;
  }
}

// ─── Deactivate / reactivate ─────────────────────────────────────────────────

export type StatusOutcome<T> =
  | { readonly kind: "changed"; readonly item: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unchanged"; readonly item: T; readonly active: boolean };

/**
 * `target` is the state asked for. When the entry is already in it the outcome
 * is `unchanged` and NOTHING is written (AC-1.11, and its mirror for
 * deactivation), which is why the check and the insert share one locked
 * transaction.
 */
export async function setLedgerAccountActive(
  id: string,
  target: boolean,
  actor: Actor,
): Promise<StatusOutcome<LedgerAccountItem>> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ledger_account" WHERE "id" = ${id} AND "entity" = ${CATALOG_ENTITY}::"Entity" FOR NO KEY UPDATE`;
    if (locked.length === 0) return { kind: "not_found" } as const;
    const current = await tx.accountingCatalogStatus.findMany({
      where: { ledgerAccountId: id },
      orderBy: [...statusOrder],
      select: statusSelect,
    });
    if (isActiveFromStatus(current) === target) {
      const row = await tx.ledgerAccount.findUniqueOrThrow({ where: { id }, include: withStatus });
      return { kind: "unchanged", item: mapLedgerAccount(row), active: target } as const;
    }
    await tx.accountingCatalogStatus.create({
      data: {
        ledgerAccountId: id,
        active: target,
        createdAt: strictlyAfter(current[current.length - 1]?.createdAt),
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
    });
    const row = await tx.ledgerAccount.findUniqueOrThrow({ where: { id }, include: withStatus });
    return { kind: "changed", item: mapLedgerAccount(row) } as const;
  });
}

export async function setVatCodeActive(
  id: string,
  target: boolean,
  actor: Actor,
): Promise<StatusOutcome<VatCodeItem>> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "vat_code" WHERE "id" = ${id} AND "entity" = ${CATALOG_ENTITY}::"Entity" FOR NO KEY UPDATE`;
    if (locked.length === 0) return { kind: "not_found" } as const;
    const current = await tx.accountingCatalogStatus.findMany({
      where: { vatCodeId: id },
      orderBy: [...statusOrder],
      select: statusSelect,
    });
    if (isActiveFromStatus(current) === target) {
      const row = await tx.vatCode.findUniqueOrThrow({ where: { id }, include: withStatus });
      return { kind: "unchanged", item: mapVatCode(row), active: target } as const;
    }
    await tx.accountingCatalogStatus.create({
      data: {
        vatCodeId: id,
        active: target,
        createdAt: strictlyAfter(current[current.length - 1]?.createdAt),
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
    });
    const row = await tx.vatCode.findUniqueOrThrow({ where: { id }, include: withStatus });
    return { kind: "changed", item: mapVatCode(row) } as const;
  });
}

/** Now, but never at or before `previous`: keeps an entry's status history strictly ordered by lock order. */
function strictlyAfter(previous: Date | undefined): Date {
  const now = Date.now();
  return new Date(previous !== undefined && previous.getTime() >= now ? previous.getTime() + 1 : now);
}
