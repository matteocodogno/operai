/**
 * Data access for the monthly exchange rates (T9, specs/20261118-refund-
 * accounting-export; AC-5.1 to AC-5.6; ADR 20261118-monthly-exchange-rates-...).
 *
 * `exchange_rate_entry` is append-only (database trigger). A rate is EITHER
 * `fetched` (at most once per currency and month, partial unique index
 * `exchange_rate_fetched_once`) OR `corrected` by an admin (any number of
 * times). The rate IN EFFECT is the latest corrected row, else the fetched
 * row; nothing is ever updated, so every earlier value stays in the history.
 *
 * `exchange_rate_fetch_attempt` is the append-only log of every attempt, which
 * is where "the last fetch failed, and when" (AC-5.6), the throttle and the
 * source discrepancies (AC-5.4) are read from.
 *
 * Months travel as `YYYY-MM` strings in this module's API and are stored as the
 * first day of the month (`@db.Date`, CHECK day = 1).
 */

import type { Prisma } from "../lib/generated/prisma/client";
import type { Currency } from "../lib/generated/prisma/enums";
import { db } from "../lib/db";

type Client = Prisma.TransactionClient;

/** The actor recorded on a fetched rate (never a person). */
export const FX_FETCH_ACTOR = { userId: "system:fx-fetch", email: "system-fx-fetch@welld.ch" } as const;

export interface Actor {
  readonly userId: string;
  readonly email: string;
}

/** The currencies a rate exists for. */
export type RateCurrency = Exclude<Currency, "CHF">;

export interface RateEntry {
  readonly id: string;
  readonly currency: RateCurrency;
  /** `YYYY-MM` */
  readonly month: string;
  readonly rateMicros: number;
  readonly origin: "fetched" | "corrected";
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
  currency: row.currency as RateCurrency,
  month: dateToMonth(row.month),
  rateMicros: row.rateMicros,
  origin: row.origin,
  sourceUrl: row.sourceUrl,
  fetchedAt: row.fetchedAt,
  createdByUserId: row.createdByUserId,
  createdByEmail: row.createdByEmail,
  createdAt: row.createdAt,
});

/** Every entry of the given months, oldest first (by `createdAt`, then id). */
export async function listEntries(client: Client, months: readonly string[]): Promise<RateEntry[]> {
  if (months.length === 0) return [];
  const rows = await client.exchangeRateEntry.findMany({
    where: { month: { in: months.map(monthToDate) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toEntry);
}

/** Every entry of one (currency, month), oldest first. */
export async function listEntriesFor(client: Client, currency: RateCurrency, month: string): Promise<RateEntry[]> {
  const rows = await client.exchangeRateEntry.findMany({
    where: { currency, month: monthToDate(month) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toEntry);
}

/** The months that have at least one entry, as `YYYY-MM`. */
export async function monthsWithEntries(client: Client): Promise<string[]> {
  const rows = await client.exchangeRateEntry.findMany({ distinct: ["month"], select: { month: true } });
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
 * Records a fetched rate. `ON CONFLICT DO NOTHING` on the partial unique index:
 * a second fetch of the same (currency, month), from this or another process,
 * inserts nothing and returns `false`, never overwrites and never throws.
 */
export async function insertFetchedRate(client: Client, input: FetchedRateInput): Promise<boolean> {
  const { count } = await client.exchangeRateEntry.createMany({
    data: [
      {
        currency: input.currency,
        month: monthToDate(input.month),
        rateMicros: input.rateMicros,
        origin: "fetched",
        sourceUrl: input.sourceUrl,
        sourceMonth: input.sourceMonth,
        fetchedAt: input.fetchedAt,
        createdByUserId: FX_FETCH_ACTOR.userId,
        createdByEmail: FX_FETCH_ACTOR.email,
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

/** The rate in effect of one (currency, month): the latest corrected entry, else the fetched one, else `null`. */
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
 * Appends an admin correction (AC-5.3). A value equal to the one in effect is a
 * no-op: nothing is written (`unchanged`). The (currency, month) is locked with
 * a transaction-scoped advisory lock so two corrections cannot both read the
 * same "in effect" value, and the new row's time is strictly after the last
 * one's, so the latest row is the latest decision whatever the clocks say.
 */
export async function appendCorrection(input: {
  readonly currency: RateCurrency;
  readonly month: string;
  readonly rateMicros: number;
  readonly actor: Actor;
}): Promise<CorrectionOutcome> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fx-rate:${input.currency}:${input.month}`}))`;
    const entries = await listEntriesFor(tx, input.currency, input.month);
    const current = effectiveEntry(entries);
    if (current !== null && current.rateMicros === input.rateMicros) return { kind: "unchanged", entry: current } as const;
    const last = entries[entries.length - 1];
    const now = Date.now();
    const createdAt = new Date(last !== undefined && last.createdAt.getTime() >= now ? last.createdAt.getTime() + 1 : now);
    const row = await tx.exchangeRateEntry.create({
      data: {
        currency: input.currency,
        month: monthToDate(input.month),
        rateMicros: input.rateMicros,
        origin: "corrected",
        createdByUserId: input.actor.userId,
        createdByEmail: input.actor.email,
        createdAt,
      },
    });
    return { kind: "recorded", entry: toEntry(row) } as const;
  });
}

// ─── Attempt log ─────────────────────────────────────────────────────────────

export type FetchTrigger = "admin" | "settings_view" | "export";
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
  month: dateToMonth(row.month),
  trigger: row.trigger,
  outcome: row.outcome,
  errorCode: row.errorCode,
  recorded: row.recorded,
  discrepancies: row.discrepancies,
  actorUserId: row.actorUserId,
  createdAt: row.createdAt,
});

export async function insertAttempt(client: Client, input: AttemptInput): Promise<void> {
  await client.exchangeRateFetchAttempt.create({
    data: {
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

/** The newest attempt of any month (AC-5.6 "last fetch ... and when"), or `null`. */
export async function latestAttempt(client: Client): Promise<AttemptRow | null> {
  const row = await client.exchangeRateFetchAttempt.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return row ? toAttempt(row) : null;
}

/** The newest attempt of one month that actually asked the source (`ok` or `failed`): the one the throttle looks at. */
export async function latestSourceAttempt(client: Client, month: string): Promise<AttemptRow | null> {
  const row = await client.exchangeRateFetchAttempt.findFirst({
    where: { month: monthToDate(month), outcome: { in: ["ok", "failed"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toAttempt(row) : null;
}
