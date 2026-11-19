/**
 * The exchange-rate service: the rate in effect, and fetching on demand (T11, specs/20261119-accounting; moved from
 * refund-api's `src/fx/fx.service.ts`, where it served WellD CH alone; AC-2.1, AC-2.2, AC-2.4, AC-2.6, AC-2.8,
 * AC-2.10, AC-2.11; ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-... amended
 * 2026-11-19; ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-...; plan D4, D27, G5, G10).
 *
 * THERE IS NO SCHEDULER. A month is fetched when somebody needs it, and the service knows only two kinds of somebody:
 *
 *   - `manager`: a user holding `accounting:manage` for the entity, pressing "Fetch now" or opening the rates view
 *     with rates due (D26). The request is a user's and has no outer deadline: it runs under a total budget of
 *     `FX_FETCH_BUDGET_MS` = 10 s.
 *   - `consumer`: a verified service principal (refund-api) asking for the rate of a pair that is not recorded
 *     (AC-2.10). Its own operation has a 10 s deadline (`ACCOUNTING_DEADLINE_MS`), so this work runs under
 *     `CONSUMER_FETCH_BUDGET_MS` = 6 s, strictly inside it, and the answer comes within about 6.5 s.
 *
 * The trigger is a PARAMETER the route sets from how the caller authenticated; no body ever supplies it (ADR
 * 20261119-on-demand-outbound-work-..., point 3). Every function takes the ENTITY: a welld_ch fetch reads, records
 * and logs welld_ch only, and an entity without a source (welld_it, D19) cannot be fetched at all.
 *
 * Rules enforced here
 * - Only a COMPLETED month, from day 5 of the following month (Europe/Zurich, `months.ts`), is ever asked of the
 *   source (R2, D27).
 * - Throttle: no new request for an (entity, month) within 15 minutes of the last one that reached the source
 *   (success or failure), read from the attempt log, so it holds across restarts. A throttled month writes nothing.
 * - Single flight per (entity, month) inside the process: callers that arrive while a month is being fetched share
 *   that fetch. A caller that JOINS another's fetch waits no longer than its OWN budget: a consumer never waits for
 *   a manager's slower fetch (the nesting rule of the ADR).
 * - At most 6 months per call (the rest are reported as deferred), fetched IN PARALLEL, each call under its own 5 s
 *   timeout, the whole call under one budget (one `AbortSignal`). When the budget runs out the unfinished calls end
 *   as `failed`/`timeout` and what was already received is kept, so a slow source turns into a clean "missing rate"
 *   for the caller and never into a 5xx or a long wait.
 * - A fetched (entity, currency, month) is recorded once, never overwritten (`ON CONFLICT DO NOTHING` on the partial
 *   unique index). When the source later answers a different value, that is logged as a discrepancy in the attempt
 *   log and NOWHERE else: no API field, no screen (G8). A manager's correction stays in effect (AC-2.6).
 * - A failure of any kind (timeout, HTTP error, malformed or wrong-month answer) records an attempt and changes no
 *   rate (AC-2.8).
 * - The attempt log writes `not_fetchable` only for `manager`; a `consumer` call writes no row for a month that is
 *   not published yet or that is throttled (G5): consumers ask often, and nothing happened.
 *
 * `ACCOUNTING_FX_SOURCE=off` makes every attempt a `disabled` row with no outbound call. The fetcher and the clock
 * are injectable, so no test touches the network.
 */

import { db } from "../lib/db";
import { RATE_SOURCE, type Entity } from "../entities";
import { fetchBazgMonth, FX_CALL_TIMEOUT_MS, type FxFetcher } from "./bazgSource";
import { fetchableMonths, isFetchableMonth } from "./months";
import { FX_CURRENCIES, parseBazgMonth, type FxCurrency } from "./parse";
import {
  effectiveEntry,
  insertAttempt,
  insertFetchedRate,
  latestSourceAttempt,
  listEntries,
  listEntriesFor,
  type AttemptInput,
  type FetchTrigger,
  type RateCurrency,
  type RateEntry,
} from "./rates.repo";

/** The total budget of a MANAGER's fetch (5 s per call, at most 6 months, in parallel). */
export const FX_FETCH_BUDGET_MS = 10_000;
/**
 * The total budget of a CONSUMER's fetch, strictly inside the consumer's 10 s deadline (`ACCOUNTING_DEADLINE_MS` of
 * refund-api): the answer comes within about 6.5 s, and a test reads both constants (T15).
 */
export const CONSUMER_FETCH_BUDGET_MS = 6_000;
export const FX_THROTTLE_MS = 15 * 60 * 1000;
export const FX_MAX_MONTHS_PER_TRIGGER = 6;

export type MonthOutcome = "ok" | "failed" | "not_fetchable" | "disabled" | "throttled";

export interface MonthResult {
  readonly month: string;
  readonly outcome: MonthOutcome;
  readonly errorCode: string | null;
  /** The rates newly recorded by this attempt, in micros (empty when none, `null` when nothing was asked of the source). */
  readonly recorded: Readonly<Record<string, number>> | null;
}

export interface FetchMonthsResult {
  readonly results: readonly MonthResult[];
  /** Months over the per-call limit, not attempted. */
  readonly deferred: readonly string[];
}

/** An (currency, month) pair a consumer asks the rate of. */
export interface RatePair {
  readonly currency: RateCurrency;
  readonly month: string;
}

/** The answer for one asked pair, in the shape of the system wire (`accountingWire`, T7). */
export type ConsumerRate =
  | {
      readonly currency: RateCurrency;
      readonly month: string;
      readonly status: "in_effect";
      readonly rateMicros: number;
      readonly origin: "fetched" | "corrected";
      readonly attempted: boolean;
    }
  | {
      readonly currency: RateCurrency;
      readonly month: string;
      readonly status: "missing";
      readonly attempted: boolean;
      readonly reason: "not_published" | "fetch_failed" | "no_source";
    };

export interface RatesServiceDeps {
  readonly mode: "bazg" | "off";
  readonly fetcher?: FxFetcher;
  readonly now?: () => Date;
  /** Overrides of the total budget of a trigger, for tests. Defaults: `FX_FETCH_BUDGET_MS`, `CONSUMER_FETCH_BUDGET_MS`. */
  readonly budgetMs?: Partial<Record<FetchTrigger, number>>;
  readonly callTimeoutMs?: number;
}

/** Thrown when a fetch is asked for an entity with no rate source (welld_it): the route answers 422 `no_rate_source`. */
export class NoRateSourceError extends Error {
  constructor(readonly entity: Entity) {
    super(`${entity} has no rate source`);
    this.name = "NoRateSourceError";
  }
}

export const rateKey = (currency: string, month: string): string => `${currency}:${month}`;

/** The currencies the entity converts, per its source (D19). Empty for an entity with no source. */
export function currenciesOf(entity: Entity): readonly RateCurrency[] {
  const source = RATE_SOURCE[entity];
  if (source === null) return [];
  return source.currencies.filter((currency): currency is FxCurrency => (FX_CURRENCIES as readonly string[]).includes(currency));
}

export function createRatesService(deps: RatesServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<MonthResult>>();
  const budgetFor = (trigger: FetchTrigger): number =>
    deps.budgetMs?.[trigger] ?? (trigger === "consumer" ? CONSUMER_FETCH_BUDGET_MS : FX_FETCH_BUDGET_MS);

  /** The rate in effect for each (currency, month) of one entity, `null` for none. Keyed by `rateKey`. */
  async function ratesInEffect(entity: Entity, pairs: readonly RatePair[]): Promise<Map<string, RateEntry | null>> {
    const months = [...new Set(pairs.map((p) => p.month))];
    const entries = await listEntries(db, entity, months);
    const grouped = new Map<string, RateEntry[]>();
    for (const entry of entries) {
      const key = rateKey(entry.currency, entry.month);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    const out = new Map<string, RateEntry | null>();
    for (const pair of pairs) {
      const key = rateKey(pair.currency, pair.month);
      out.set(key, effectiveEntry(grouped.get(key) ?? []));
    }
    return out;
  }

  /** The rate in effect for one currency and month (`YYYY-MM`): the latest correction, else the fetched rate, else `null`. */
  async function rateInEffect(entity: Entity, currency: RateCurrency, month: string): Promise<RateEntry | null> {
    return effectiveEntry(await listEntriesFor(db, entity, currency, month));
  }

  async function attemptMonth(
    entity: Entity,
    month: string,
    trigger: FetchTrigger,
    actorUserId: string,
    signal: AbortSignal,
  ): Promise<MonthResult> {
    const at = now();
    const log = (partial: Pick<AttemptInput, "outcome" | "errorCode" | "recorded" | "discrepancies">) =>
      insertAttempt(db, entity, { month, trigger, actorUserId, at, ...partial });

    if (deps.mode === "off") {
      await log({ outcome: "disabled", errorCode: null, recorded: null, discrepancies: null });
      return { month, outcome: "disabled", errorCode: null, recorded: null };
    }
    if (!isFetchableMonth(month, at)) {
      // Only a manager's "Fetch now" is a thing worth a row; a consumer asking early is nothing that happened (G5).
      if (trigger === "manager") await log({ outcome: "not_fetchable", errorCode: null, recorded: null, discrepancies: null });
      return { month, outcome: "not_fetchable", errorCode: null, recorded: null };
    }
    const previous = await latestSourceAttempt(db, entity, month);
    if (previous !== null && at.getTime() - previous.createdAt.getTime() < FX_THROTTLE_MS) {
      return { month, outcome: "throttled", errorCode: null, recorded: null };
    }

    const fetched = await fetchBazgMonth(month, {
      signal,
      callTimeoutMs: deps.callTimeoutMs ?? FX_CALL_TIMEOUT_MS,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    if (!fetched.ok) {
      await log({ outcome: "failed", errorCode: fetched.code, recorded: null, discrepancies: null });
      return { month, outcome: "failed", errorCode: fetched.code, recorded: null };
    }
    const parsed = parseBazgMonth(fetched.body, month);
    if (!parsed.ok) {
      await log({ outcome: "failed", errorCode: parsed.code, recorded: null, discrepancies: null });
      return { month, outcome: "failed", errorCode: parsed.code, recorded: null };
    }

    const recorded: Record<string, number> = {};
    const discrepancies: Record<string, { fetched: number; inEffect: number; sourceNow: number }> = {};
    await db.$transaction(async (tx) => {
      const entries = await listEntries(tx, entity, [month]);
      for (const currency of currenciesOf(entity)) {
        const sourceNow = parsed.rates[currency as FxCurrency];
        const own = entries.filter((e) => e.currency === currency);
        const fetchedRow = own.find((e) => e.origin === "fetched");
        if (fetchedRow === undefined) {
          const inserted = await insertFetchedRate(tx, entity, {
            currency,
            month,
            rateMicros: sourceNow,
            sourceUrl: fetched.url,
            sourceMonth: parsed.month,
            fetchedAt: at,
          });
          if (inserted) recorded[currency] = sourceNow;
        } else if (fetchedRow.rateMicros !== sourceNow) {
          discrepancies[currency] = {
            fetched: fetchedRow.rateMicros,
            inEffect: effectiveEntry(own)?.rateMicros ?? fetchedRow.rateMicros,
            sourceNow,
          };
        }
      }
      await insertAttempt(tx, entity, {
        month,
        trigger,
        actorUserId,
        at,
        outcome: "ok",
        errorCode: null,
        recorded: Object.keys(recorded).length > 0 ? recorded : null,
        discrepancies: Object.keys(discrepancies).length > 0 ? discrepancies : null,
      });
    });
    return { month, outcome: "ok", errorCode: null, recorded };
  }

  /**
   * One month of one call: starts the fetch, or joins the one already running for the (entity, month). The STARTER
   * waits for its own fetch (it ends by its own budget, inside the call). A JOINER waits at most its own budget: when
   * that fires first it is told `failed`/`timeout` and writes nothing (the fetch it joined logs its own outcome).
   */
  function oneMonth(
    entity: Entity,
    month: string,
    trigger: FetchTrigger,
    actorUserId: string,
    budget: AbortSignal,
  ): Promise<MonthResult> {
    const key = `${entity}:${month}`;
    const running = inFlight.get(key);
    if (running === undefined) {
      const started = attemptMonth(entity, month, trigger, actorUserId, budget).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    }
    return new Promise<MonthResult>((resolve, reject) => {
      const timedOut: MonthResult = { month, outcome: "failed", errorCode: "timeout", recorded: null };
      if (budget.aborted) return resolve(timedOut);
      const onAbort = () => resolve(timedOut);
      budget.addEventListener("abort", onAbort, { once: true });
      running.then(
        (result) => {
          budget.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          budget.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Fetches the given months (`YYYY-MM`) of one entity, newest first, at most {@link FX_MAX_MONTHS_PER_TRIGGER}, in
   * parallel under the budget of `trigger`. `actor` is who asked; the recorded RATES always carry the system actor.
   * Throws {@link NoRateSourceError} for an entity with no source: nothing is attempted and nothing is logged.
   */
  async function fetchMonths(
    entity: Entity,
    months: readonly string[],
    trigger: FetchTrigger,
    actor: { readonly userId: string },
  ): Promise<FetchMonthsResult> {
    if (RATE_SOURCE[entity] === null) throw new NoRateSourceError(entity);
    const ordered = [...new Set(months)].sort().reverse();
    const taken = ordered.slice(0, FX_MAX_MONTHS_PER_TRIGGER);
    const deferred = ordered.slice(FX_MAX_MONTHS_PER_TRIGGER);
    const budget = AbortSignal.timeout(budgetFor(trigger));
    const results = await Promise.all(taken.map((month) => oneMonth(entity, month, trigger, actor.userId, budget)));
    return { results, deferred };
  }

  /** The fetchable months (`months.ts`) that lack a rate in effect for at least one of the entity's currencies, newest first. */
  async function monthsNeedingFetch(entity: Entity): Promise<string[]> {
    const currencies = currenciesOf(entity);
    if (currencies.length === 0) return [];
    const candidates = fetchableMonths(now());
    if (candidates.length === 0) return [];
    const entries = await listEntries(db, entity, candidates);
    const have = new Map<string, Set<string>>();
    for (const entry of entries) have.set(entry.month, (have.get(entry.month) ?? new Set()).add(entry.currency));
    return candidates.filter((month) => currencies.some((c) => !have.get(month)?.has(c)));
  }

  /** `true` when a fetch could do something: the source is on, the entity has one, and a fetchable month lacks a rate (`fetchDue`). */
  async function fetchDue(entity: Entity): Promise<boolean> {
    return deps.mode !== "off" && (await monthsNeedingFetch(entity)).length > 0;
  }

  /**
   * What a consumer is told about the pairs it asks for (AC-2.10, plan § system routes): each pair once, in the asked
   * order, `in_effect` or `missing` with a reason.
   *
   * A pair with no rate in effect whose month is published is fetched first, under the CONSUMER budget, at most six
   * months, throttled and single-flight like any other fetch, and `actor` (the service principal) is the attempt's
   * actor. `attempted` says that THIS call asked the source for the pair's month, or waited for the fetch of it that
   * was running (the `fetchAttempted` of refund-api's export summary, G10): it is false for a pair that was already
   * in effect, for a month not yet published, for a throttled or deferred month, and when the source is off.
   *
   * `missing` reasons: `no_source` (the entity has none, or the currency is not one it converts), `not_published`
   * (the month is too recent, no outbound call), `fetch_failed` (published but not obtained: the source failed or was
   * too slow, the month was throttled or beyond the six, or fetching is switched off).
   */
  async function consumerRates(
    entity: Entity,
    pairs: readonly RatePair[],
    actor: { readonly userId: string },
  ): Promise<ConsumerRate[]> {
    const convertible = new Set<string>(currenciesOf(entity));
    const usable = pairs.filter((pair) => convertible.has(pair.currency));
    const before = await ratesInEffect(entity, usable);
    const missing = usable.filter((pair) => before.get(rateKey(pair.currency, pair.month)) === null);

    const asked = new Map<string, MonthResult>();
    const at = now();
    const toFetch = [...new Set(missing.map((p) => p.month))].filter((month) => isFetchableMonth(month, at));
    if (toFetch.length > 0) {
      const { results } = await fetchMonths(entity, toFetch, "consumer", actor);
      for (const result of results) asked.set(result.month, result);
    }
    const after = asked.size > 0 ? await ratesInEffect(entity, missing) : before;

    return pairs.map((pair): ConsumerRate => {
      const { currency, month } = pair;
      if (!convertible.has(currency)) return { currency, month, status: "missing", attempted: false, reason: "no_source" };
      const key = rateKey(currency, month);
      const result = asked.get(month);
      const attempted = before.get(key) === null && result !== undefined && (result.outcome === "ok" || result.outcome === "failed");
      const entry = before.get(key) ?? after.get(key) ?? null;
      if (entry !== null) {
        return { currency, month, status: "in_effect", rateMicros: entry.rateMicros, origin: entry.origin, attempted };
      }
      if (!isFetchableMonth(month, at)) return { currency, month, status: "missing", attempted: false, reason: "not_published" };
      return { currency, month, status: "missing", attempted, reason: "fetch_failed" };
    });
  }

  return {
    enabled: deps.mode !== "off",
    rateInEffect,
    ratesInEffect,
    fetchMonths,
    monthsNeedingFetch,
    fetchDue,
    consumerRates,
  };
}

export type RatesService = ReturnType<typeof createRatesService>;
