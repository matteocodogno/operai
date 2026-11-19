/**
 * Data access for the monthly exchange rates of each entity (T11, specs/20261119-accounting; moved from refund-api's
 * `src/fx/fx.repo.ts`, where the rates were WellD CH's alone; AC-2.1, AC-2.2, AC-2.4, AC-2.6, AC-2.8, AC-2.11; ADR
 * 20261118-monthly-exchange-rates-..., amended 2026-11-19).
 *
 * `exchange_rate_entry` is append-only (database trigger). A rate is EITHER `fetched` (at most once per entity,
 * currency and month, partial unique index `exchange_rate_fetched_once`) OR `corrected` by a manager (any number of
 * times, each carrying the value it replaced). The rate IN EFFECT is the latest corrected row, else the fetched row;
 * nothing is ever updated, so every earlier value stays in the history.
 *
 * `exchange_rate_fetch_attempt` is the append-only log of the attempts that mean something: where "the last fetch
 * failed, and when" (AC-2.8), the throttle and the source discrepancies are read from. Its `trigger` is `manager` or
 * `consumer`, set by the SERVER from how the caller authenticated, never by the caller (ADR 20261119-on-demand-outbound-
 * work-...).
 *
 * EVERY function takes the entity, and every read and write is scoped to it: a fetch, a correction or a missing rate
 * of one entity changes nothing of another (AC-2.11). Months travel as `YYYY-MM` strings in this module's API and are
 * stored as the first day of the month (`@db.Date`, CHECK day = 1).
 */

import type { Prisma } from "../lib/generated/prisma/client";
import type { Currency } from "../lib/generated/prisma/enums";
import { db } from "../lib/db";
import type { Entity } from "../entities";

type Client = Prisma.TransactionClient;

/** The actor recorded on a fetched rate (never a person). */
export const RATES_FETCH_ACTOR = { userId: "system:rates-fetch", email: "system-rates-fetch@welld.ch" } as const;

export interface Actor {
  readonly userId: string;
  readonly email: string;
}

/** The currencies a rate can exist for: any but CHF (and, for welld_it, EUR: the database CHECK refuses the own currency). */
export type RateCurrency = Exclude<Currency, "CHF">;

export interface RateEntry {
  readonly id: string;
  readonly entity: Entity;
  readonly currency: RateCurrency;
  /** `YYYY-MM` */
  readonly month: string;
  readonly rateMicros: number;
  readonly origin: "fetched" | "corrected";
  /** A correction: the rate in effect before it (`null` when it was the first). A fetched rate replaces nothing. */
  readonly replacesRateMicros: number | null;
  readonly sourceUrl: string | null;
  readonly fetchedAt: Date | null;
  readonly createdByUserId: string;
  readonly createdByEmail: string;
  readonly createdAt: Date;
}

export const monthToDate = (month: string): Date => new Date(`${month}-01T00:00:00.000Z`);
export const dateToMonth = (date: Date): string => date.toISOString().slice(0, 7);

const toEntry = (row: Prisma.ExchangeRateEntryGetPayload<object>): RateEntry => ({
  id: row.id,
  entity: row.entity,
  currency: row.currency as RateCurrency,
  month: dateToMonth(row.month),
  rateMicros: row.rateMicros,
  origin: row.origin,
  replacesRateMicros: row.replacesRateMicros,
  sourceUrl: row.sourceUrl,
  fetchedAt: row.fetchedAt,
  createdByUserId: row.createdByUserId,
  createdByEmail: row.createdByEmail,
  createdAt: row.createdAt,
});

/** Every entry of the entity in the given months, oldest first (by `createdAt`, then id). */
export async function listEntries(client: Client, entity: Entity, months: readonly string[]): Promise<RateEntry[]> {
  if (months.length === 0) return [];
  const rows = await client.exchangeRateEntry.findMany({
    where: { entity, month: { in: months.map(monthToDate) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toEntry);
}

/** Every entry of one (entity, currency, month), oldest first. */
export async function listEntriesFor(
  client: Client,
  entity: Entity,
  currency: RateCurrency,
  month: string,
): Promise<RateEntry[]> {
  const rows = await client.exchangeRateEntry.findMany({
    where: { entity, currency, month: monthToDate(month) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toEntry);
}

/** The months in which the entity has at least one entry, as `YYYY-MM` (the window shows them, AC-2.3). */
export async function monthsWithEntries(client: Client, entity: Entity): Promise<string[]> {
  const rows = await client.exchangeRateEntry.findMany({ where: { entity }, distinct: ["month"], select: { month: true } });
  return rows.map((r) => dateToMonth(r.month));
}

/** The months in which the entity has at least one attempt, as `YYYY-MM` (a month asked for is listed, AC-2.3, AC-2.10). */
export async function monthsWithAttempts(client: Client, entity: Entity): Promise<string[]> {
  const rows = await client.exchangeRateFetchAttempt.findMany({
    where: { entity },
    distinct: ["month"],
    select: { month: true },
  });
  return rows.map((r) => dateToMonth(r.month));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface FetchedRateInput {
  readonly currency: RateCurrency;
  readonly rateMicros: number;
  readonly month: string;
  readonly sourceUrl: string;
  readonly sourceMonth: string;
  readonly fetchedAt: Date;
}

/**
 * Records a fetched rate. `ON CONFLICT DO NOTHING` on the partial unique index: a second fetch of the same (entity,
 * currency, month), from this or another process, inserts nothing and returns `false`, never overwrites and never
 * throws (AC-2.2).
 */
export async function insertFetchedRate(client: Client, entity: Entity, input: FetchedRateInput): Promise<boolean> {
  const { count } = await client.exchangeRateEntry.createMany({
    data: [
      {
        entity,
        currency: input.currency,
        month: monthToDate(input.month),
        rateMicros: input.rateMicros,
        origin: "fetched",
        sourceUrl: input.sourceUrl,
        sourceMonth: input.sourceMonth,
        fetchedAt: input.fetchedAt,
        createdByUserId: RATES_FETCH_ACTOR.userId,
        createdByEmail: RATES_FETCH_ACTOR.email,
        createdAt: input.fetchedAt,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

export type CorrectionOutcome =
  | { readonly kind: "recorded"; readonly entry: RateEntry }
  | { readonly kind: "unchanged"; readonly entry: RateEntry };

/** The rate in effect of one (entity, currency, month): the latest corrected entry, else the fetched one, else `null`. */
export function effectiveEntry(entries: readonly RateEntry[]): RateEntry | null {
  let fetched: RateEntry | null = null;
  let corrected: RateEntry | null = null;
  for (const entry of entries) {
    if (entry.origin === "corrected") corrected = entry; // entries are oldest first: the last one wins
    else fetched = entry;
  }
  return corrected ?? fetched;
}

/**
 * Appends a manager's correction (AC-2.4): a `corrected` row with the actor, the entity and `replacesRateMicros`, the
 * value in effect before it (`null` when none was). A value equal to the one in effect is a no-op: nothing is written
 * (`unchanged`). The (entity, currency, month) is locked with a transaction-scoped advisory lock so two corrections
 * cannot both read the same "in effect" value, and the new row's time is strictly after the last one's, so the latest
 * row is the latest decision whatever the clocks say.
 */
export async function appendCorrection(
  entity: Entity,
  input: { readonly currency: RateCurrency; readonly month: string; readonly rateMicros: number; readonly actor: Actor },
): Promise<CorrectionOutcome> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rates:${entity}:${input.currency}:${input.month}`}))`;
    const entries = await listEntriesFor(tx, entity, input.currency, input.month);
    const current = effectiveEntry(entries);
    if (current !== null && current.rateMicros === input.rateMicros) return { kind: "unchanged", entry: current } as const;
    const last = entries[entries.length - 1];
    const now = Date.now();
    const createdAt = new Date(last !== undefined && last.createdAt.getTime() >= now ? last.createdAt.getTime() + 1 : now);
    const row = await tx.exchangeRateEntry.create({
      data: {
        entity,
        currency: input.currency,
        month: monthToDate(input.month),
        rateMicros: input.rateMicros,
        origin: "corrected",
        replacesRateMicros: current?.rateMicros ?? null,
        createdByUserId: input.actor.userId,
        createdByEmail: input.actor.email,
        createdAt,
      },
    });
    return { kind: "recorded", entry: toEntry(row) } as const;
  });
}

// ─── Attempt log ─────────────────────────────────────────────────────────────

/** Who asked, derived by the server: a user holding `accounting:manage` for the entity, or the service principal of a consumer. */
export type FetchTrigger = "manager" | "consumer";
/** What is logged. `throttled` is never a row: nothing was asked of the source. */
export type AttemptOutcome = "ok" | "failed" | "not_fetchable" | "disabled";

export interface AttemptInput {
  readonly month: string;
  readonly trigger: FetchTrigger;
  readonly outcome: AttemptOutcome;
  readonly errorCode: string | null;
  readonly recorded: Record<string, number> | null;
  readonly discrepancies: Record<string, { fetched: number; inEffect: number; sourceNow: number }> | null;
  readonly actorUserId: string;
  readonly at: Date;
}

export interface AttemptRow {
  readonly entity: Entity;
  readonly month: string;
  readonly trigger: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly recorded: unknown;
  readonly discrepancies: unknown;
  readonly actorUserId: string;
  readonly createdAt: Date;
}

const toAttempt = (row: Prisma.ExchangeRateFetchAttemptGetPayload<object>): AttemptRow => ({
  entity: row.entity,
  month: dateToMonth(row.month),
  trigger: row.trigger,
  outcome: row.outcome,
  errorCode: row.errorCode,
  recorded: row.recorded,
  discrepancies: row.discrepancies,
  actorUserId: row.actorUserId,
  createdAt: row.createdAt,
});

export async function insertAttempt(client: Client, entity: Entity, input: AttemptInput): Promise<void> {
  await client.exchangeRateFetchAttempt.create({
    data: {
      entity,
      month: monthToDate(input.month),
      trigger: input.trigger,
      outcome: input.outcome,
      errorCode: input.errorCode,
      ...(input.recorded !== null ? { recorded: input.recorded } : {}),
      ...(input.discrepancies !== null ? { discrepancies: input.discrepancies } : {}),
      actorUserId: input.actorUserId,
      createdAt: input.at,
    },
  });
}

/** The newest attempt of any month of the entity, whatever its outcome, or `null`. */
export async function latestAttempt(client: Client, entity: Entity): Promise<AttemptRow | null> {
  const row = await client.exchangeRateFetchAttempt.findFirst({
    where: { entity },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toAttempt(row) : null;
}

/** The newest attempt of the entity that actually asked the source, `ok` or `failed`: the "last fetch" of AC-2.8. */
export async function latestFetchAttempt(client: Client, entity: Entity): Promise<AttemptRow | null> {
  const row = await client.exchangeRateFetchAttempt.findFirst({
    where: { entity, outcome: { in: ["ok", "failed"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toAttempt(row) : null;
}

/** The newest attempt of one (entity, month) that actually asked the source (`ok` or `failed`): the one the throttle looks at. */
export async function latestSourceAttempt(client: Client, entity: Entity, month: string): Promise<AttemptRow | null> {
  const row = await client.exchangeRateFetchAttempt.findFirst({
    where: { entity, month: monthToDate(month), outcome: { in: ["ok", "failed"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toAttempt(row) : null;
}
