/**
 * Data access for the ledger accounts and VAT codes of each legal entity (T8 and T9, specs/20261119-accounting; moved
 * from refund-api's `src/accounting/catalog.repo.ts`, where it served WellD CH alone; AC-1.1 to AC-1.13; ADR
 * 20260716-immutable-financial-audit-trail-refund, plan § Data model).
 *
 * Shape of the data
 * - An entry (`ledger_account`, `vat_code`) is INSERT-ONLY: number, name, code, label, rate and entity never change
 *   (database trigger, AC-1.12), and it is never deleted. Its identity is `(entity, number)` or `(entity, code)`; the
 *   internal `id` never leaves this module.
 * - Whether it can be chosen is the append-only `catalog_status_change` history. No row means active since creation;
 *   the CURRENT state is the LATEST row. Deactivation and reactivation each append one row with the actor, the time
 *   and the entity (AC-1.13), so there is one write path and one audit trail, not a mutable flag plus a log.
 *
 * Concurrency
 * - A status change locks the entry row (`FOR UPDATE`) and decides on the locked state, so two deactivations cannot
 *   both write (AC-1.11): exactly one row is appended, the other caller gets `unchanged`.
 * - "Latest" is ordered by `createdAt` then `id`. A status row's `createdAt` is set here, after the lock is held, and
 *   is never at or before the previous row's, so lock order IS history order whatever the clocks of two transactions
 *   say.
 * - A concurrent duplicate insert hits the unique index and is reported as the same `duplicate` outcome as the
 *   pre-check (AC-1.3), with the same `reactivate` answer.
 *
 * Outcomes that are part of the contract (duplicate, already in the state, not found) are returned as values; a
 * database failure throws and ends as a 500.
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import type { Entity } from "../entities";
import type { LedgerAccountItem, VatCodeItem } from "./catalog.schemas";

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

/** One digit run without leading zeros (a lone `0` stays), so that two runs compare by length, then by text. */
const stripZeros = (segment: string): string => segment.replace(/^0+(?=\d)/, "");

/**
 * Orders account numbers by their dot-separated segments, each compared as a whole number of any length (a
 * segment can hold 20 digits, more than a double keeps): `599` before `2620` before `2620.1` before `2620.9` before
 * `2620.10`, `1.2.3` before `1.10`. A number that is a prefix of another comes first. Two numbers that read the
 * same (`05`, `5`) are ordered by their text, so the order is total and stable.
 */
export function compareAccountNumbers(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = stripZeros(left[i]!);
    const y = stripZeros(right[i]!);
    if (x.length !== y.length) return x.length - y.length;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length - right.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The newest status row of an entry decides: no row means active since creation. */
const latestStatus = {
  statusChanges: {
    select: { active: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
  },
} as const satisfies Prisma.LedgerAccountInclude;

type LedgerAccountRow = Prisma.LedgerAccountGetPayload<{ include: typeof latestStatus }>;
type VatCodeRow = Prisma.VatCodeGetPayload<{ include: typeof latestStatus }>;

const isActive = (row: { statusChanges: readonly { active: boolean }[] }): boolean => row.statusChanges[0]?.active ?? true;

/** The wire projection of an entry (D18): number, name, active. No id, no who-added, no history. */
export function toLedgerAccountItem(row: LedgerAccountRow): LedgerAccountItem {
  return { number: row.number, name: row.name, active: isActive(row) };
}

/** The wire projection of a VAT code (D18): code, label, rate (as displayed and in basis points), active. */
export function toVatCodeItem(row: VatCodeRow): VatCodeItem {
  return {
    code: row.code,
    label: row.label,
    ratePercent: basisPointsToPercent(row.rateBasisPoints),
    rateBasisPoints: row.rateBasisPoints,
    active: isActive(row),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every account of the entity, active and deactivated, ordered by number segments. An entity with none lists none. */
export async function listLedgerAccounts(entity: Entity, client: Client = db): Promise<LedgerAccountItem[]> {
  const rows = await client.ledgerAccount.findMany({ where: { entity }, include: latestStatus });
  return rows.map(toLedgerAccountItem).sort((a, b) => compareAccountNumbers(a.number, b.number));
}

/** Every VAT code of the entity, active and deactivated, in code order (plain character order, capitals and digits only). */
export async function listVatCodes(entity: Entity, client: Client = db): Promise<VatCodeItem[]> {
  const rows = await client.vatCode.findMany({ where: { entity }, include: latestStatus });
  return rows.map(toVatCodeItem).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type CreateOutcome<T> =
  | { readonly kind: "created"; readonly item: T }
  /** `reactivate`: the number exists and is deactivated, so the way forward is to reactivate it (G9). */
  | { readonly kind: "duplicate"; readonly reactivate: boolean };

/** A unique violation, however the driver reports it: Prisma's `P2002`, or the raw SQLSTATE 23505 behind it. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } };
  return e.code === "P2002" || e.meta?.driverAdapterError?.cause?.originalCode === "23505";
}

async function findLedgerAccount(entity: Entity, number: string): Promise<LedgerAccountRow | null> {
  return db.ledgerAccount.findUnique({ where: { entity_number: { entity, number } }, include: latestStatus });
}

export async function createLedgerAccount(
  entity: Entity,
  input: { readonly number: string; readonly name: string },
  actor: Actor,
): Promise<CreateOutcome<LedgerAccountItem>> {
  const existing = await findLedgerAccount(entity, input.number);
  if (existing) return { kind: "duplicate", reactivate: !isActive(existing) };
  try {
    const row = await db.ledgerAccount.create({
      data: { entity, number: input.number, name: input.name, createdByUserId: actor.userId, createdByEmail: actor.email },
      include: latestStatus,
    });
    return { kind: "created", item: toLedgerAccountItem(row) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the race: the winner's row is there now, so the loser is told what the pre-check would have told it.
    const winner = await findLedgerAccount(entity, input.number);
    return { kind: "duplicate", reactivate: winner !== null && !isActive(winner) };
  }
}

async function findVatCode(entity: Entity, code: string): Promise<VatCodeRow | null> {
  return db.vatCode.findUnique({ where: { entity_code: { entity, code } }, include: latestStatus });
}

/** `code` is already upper-cased and checked (`limits.ts`); the unique index on (entity, code) makes the match case-insensitive. */
export async function createVatCode(
  entity: Entity,
  input: { readonly code: string; readonly label: string; readonly rateBasisPoints: number },
  actor: Actor,
): Promise<CreateOutcome<VatCodeItem>> {
  const existing = await findVatCode(entity, input.code);
  if (existing) return { kind: "duplicate", reactivate: !isActive(existing) };
  try {
    const row = await db.vatCode.create({
      data: {
        entity,
        code: input.code,
        label: input.label,
        rateBasisPoints: input.rateBasisPoints,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
      include: latestStatus,
    });
    return { kind: "created", item: toVatCodeItem(row) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findVatCode(entity, input.code);
    return { kind: "duplicate", reactivate: winner !== null && !isActive(winner) };
  }
}

// ─── Deactivate / reactivate ─────────────────────────────────────────────────

export type StatusOutcome<T> =
  | { readonly kind: "changed"; readonly item: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unchanged"; readonly item: T; readonly active: boolean };

/** Now, but never at or before `previous`: keeps an entry's status history strictly ordered by lock order. */
function strictlyAfter(previous: Date | undefined): Date {
  const now = Date.now();
  return new Date(previous !== undefined && previous.getTime() >= now ? previous.getTime() + 1 : now);
}

/**
 * `target` is the state asked for. When the entry is already in it the outcome is `unchanged` and NOTHING is written
 * (AC-1.11), which is why the check and the insert share one locked transaction. The status row carries the entry's
 * entity (AC-1.13), which the database checks against the entry's own.
 */
export async function setLedgerAccountActive(
  entity: Entity,
  number: string,
  target: boolean,
  actor: Actor,
): Promise<StatusOutcome<LedgerAccountItem>> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ledger_account"
      WHERE "entity" = ${entity}::"Entity" AND "number" = ${number} FOR UPDATE`;
    const id = locked[0]?.id;
    if (id === undefined) return { kind: "not_found" } as const;
    const before = await tx.ledgerAccount.findUniqueOrThrow({ where: { id }, include: latestStatus });
    if (isActive(before) === target) return { kind: "unchanged", item: toLedgerAccountItem(before), active: target } as const;
    await tx.catalogStatusChange.create({
      data: {
        entity,
        ledgerAccountId: id,
        active: target,
        createdAt: strictlyAfter(before.statusChanges[0]?.createdAt),
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
    });
    const after = await tx.ledgerAccount.findUniqueOrThrow({ where: { id }, include: latestStatus });
    return { kind: "changed", item: toLedgerAccountItem(after) } as const;
  });
}

/** The same as `setLedgerAccountActive`, for a VAT code: one locked transaction, one row, or nothing (AC-1.11). */
export async function setVatCodeActive(
  entity: Entity,
  code: string,
  target: boolean,
  actor: Actor,
): Promise<StatusOutcome<VatCodeItem>> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "vat_code"
      WHERE "entity" = ${entity}::"Entity" AND "code" = ${code} FOR UPDATE`;
    const id = locked[0]?.id;
    if (id === undefined) return { kind: "not_found" } as const;
    const before = await tx.vatCode.findUniqueOrThrow({ where: { id }, include: latestStatus });
    if (isActive(before) === target) return { kind: "unchanged", item: toVatCodeItem(before), active: target } as const;
    await tx.catalogStatusChange.create({
      data: {
        entity,
        vatCodeId: id,
        active: target,
        createdAt: strictlyAfter(before.statusChanges[0]?.createdAt),
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      },
    });
    const after = await tx.vatCode.findUniqueOrThrow({ where: { id }, include: latestStatus });
    return { kind: "changed", item: toVatCodeItem(after) } as const;
  });
}
