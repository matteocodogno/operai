/**
 * The exchange-rate service: the rate in effect, and fetching on demand (T9,
 * specs/20261118-refund-accounting-export; AC-5.1, AC-5.4, AC-5.6; ADR
 * 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-
 * recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-
 * outbound-fetch-is-hardened; plan "FX source rules", R10, G6).
 *
 * THERE IS NO SCHEDULER. A month is fetched when somebody needs it: an admin
 * pressing "Fetch now", the Settings view finding rates due, or an export that
 * finds a rate missing. Each of those calls `fetchMonths`.
 *
 * Rules enforced here
 * - Only a COMPLETED month, from day 5 of the following month (Europe/Zurich,
 *   `months.ts`), is ever asked of the source (R2).
 * - Throttle: no new request for a month within 15 minutes of the last one that
 *   reached the source (success or failure), read from the attempt log, so it
 *   holds across restarts. A throttled month writes nothing.
 * - Single-flight per month inside the process: callers that arrive while a
 *   month is being fetched share that fetch.
 * - At most 6 months per trigger (the rest are reported as deferred).
 * - The months of one trigger are fetched IN PARALLEL, each call under its own
 *   5 s timeout, the whole trigger under one 10 s budget (one `AbortSignal`).
 *   When the budget runs out the unfinished calls end as `failed`/`timeout`
 *   and what was already received is kept, so a slow source turns into a clean
 *   "missing rate" for the caller and never into a 5xx or a long wait.
 * - A fetched (currency, month) is recorded once, never overwritten
 *   (`ON CONFLICT DO NOTHING` on the partial unique index). When the source
 *   later answers a different value, that is logged as a discrepancy in the
 *   attempt log and NOWHERE else: no API field, no screen (G8).
 * - A failure of any kind (timeout, HTTP error, malformed or wrong-month
 *   answer) records an attempt and changes no rate (AC-5.6).
 *
 * `REFUND_FX_SOURCE=off` makes every attempt a `disabled` row with no outbound
 * call. The fetcher and the clock are injectable, so no test touches the network.
 */

import { db } from "../lib/db";
import { env } from "../lib/env";
import { fetchBazgMonth, FX_CALL_TIMEOUT_MS, type FxFetcher } from "./bazgSource";
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
} from "./fx.repo";
import { fetchableMonths, isFetchableMonth } from "./months";
import { FX_CURRENCIES, parseBazgMonth } from "./parse";

export const FX_FETCH_BUDGET_MS = 10_000;
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
  /** Months over the per-trigger limit, not attempted. */
  readonly deferred: readonly string[];
}

export interface FxServiceDeps {
  readonly mode: "bazg" | "off";
  readonly fetcher?: FxFetcher;
  readonly now?: () => Date;
  readonly budgetMs?: number;
  readonly callTimeoutMs?: number;
}

export const rateKey = (currency: string, month: string): string => `${currency}:${month}`;

export function createFxService(deps: FxServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<MonthResult>>();

  /** The rate in effect for each (currency, month), `null` for none. Keyed by `rateKey`. */
  async function ratesInEffect(
    pairs: readonly { currency: RateCurrency; month: string }[],
  ): Promise<Map<string, RateEntry | null>> {
    const months = [...new Set(pairs.map((p) => p.month))];
    const entries = await listEntries(db, months);
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
  async function rateInEffect(currency: RateCurrency, month: string): Promise<RateEntry | null> {
    return effectiveEntry(await listEntriesFor(db, currency, month));
  }

  async function attemptMonth(
    month: string,
    trigger: FetchTrigger,
    actorUserId: string,
    signal: AbortSignal,
  ): Promise<MonthResult> {
    const at = now();
    const log = (partial: Pick<AttemptInput, "outcome" | "errorCode" | "recorded" | "discrepancies">) =>
      insertAttempt(db, { month, trigger, actorUserId, at, ...partial });

    if (deps.mode === "off") {
      await log({ outcome: "disabled", errorCode: null, recorded: null, discrepancies: null });
      return { month, outcome: "disabled", errorCode: null, recorded: null };
    }
    if (!isFetchableMonth(month, at)) {
      await log({ outcome: "not_fetchable", errorCode: null, recorded: null, discrepancies: null });
      return { month, outcome: "not_fetchable", errorCode: null, recorded: null };
    }
    const previous = await latestSourceAttempt(db, month);
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
      const entries = await listEntries(tx, [month]);
      for (const currency of FX_CURRENCIES) {
        const sourceNow = parsed.rates[currency];
        const own = entries.filter((e) => e.currency === currency);
        const fetchedRow = own.find((e) => e.origin === "fetched");
        if (fetchedRow === undefined) {
          const inserted = await insertFetchedRate(tx, {
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
      await insertAttempt(tx, {
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
   * Fetches the given months (`YYYY-MM`), newest first, at most
   * {@link FX_MAX_MONTHS_PER_TRIGGER}, in parallel under one budget.
   * `actorUserId` is who asked; the recorded RATES always carry the system actor.
   */
  async function fetchMonths(
    months: readonly string[],
    trigger: FetchTrigger,
    actor: { readonly userId: string },
  ): Promise<FetchMonthsResult> {
    const ordered = [...new Set(months)].sort().reverse();
    const taken = ordered.slice(0, FX_MAX_MONTHS_PER_TRIGGER);
    const deferred = ordered.slice(FX_MAX_MONTHS_PER_TRIGGER);
    const budget = AbortSignal.timeout(deps.budgetMs ?? FX_FETCH_BUDGET_MS);
    const results = await Promise.all(
      taken.map((month) => {
        const running = inFlight.get(month);
        if (running) return running;
        const started = attemptMonth(month, trigger, actor.userId, budget).finally(() => {
          inFlight.delete(month);
        });
        inFlight.set(month, started);
        return started;
      }),
    );
    return { results, deferred };
  }

  /** The fetchable months (`months.ts`) that lack a rate in effect for at least one of EUR, USD and GBP, newest first. */
  async function monthsNeedingFetch(): Promise<string[]> {
    const candidates = fetchableMonths(now());
    if (candidates.length === 0) return [];
    const entries = await listEntries(db, candidates);
    const have = new Map<string, Set<string>>();
    for (const entry of entries) have.set(entry.month, (have.get(entry.month) ?? new Set()).add(entry.currency));
    return candidates.filter((month) => FX_CURRENCIES.some((c) => !have.get(month)?.has(c)));
  }

  /** `true` when a fetch could do something: the source is on and a fetchable month is missing a rate (`fetchDue`). */
  async function fetchDue(): Promise<boolean> {
    return deps.mode !== "off" && (await monthsNeedingFetch()).length > 0;
  }

  /**
   * For the export (T18): the (currency, month) pairs that have no rate in
   * effect, and are in a fetchable month, are fetched before the blockers are
   * computed. `attempted` is `true` when the source was really asked
   * (`fetchAttempted` of the summary).
   */
  async function ensureRates(
    needed: readonly { currency: RateCurrency; month: string }[],
    trigger: FetchTrigger,
    actor: { readonly userId: string },
  ): Promise<{ attempted: boolean; results: readonly MonthResult[] }> {
    const inEffect = await ratesInEffect(needed);
    const missingMonths = [
      ...new Set(needed.filter((p) => inEffect.get(rateKey(p.currency, p.month)) === null).map((p) => p.month)),
    ].filter((month) => isFetchableMonth(month, now()));
    if (missingMonths.length === 0) return { attempted: false, results: [] };
    const { results } = await fetchMonths(missingMonths, trigger, actor);
    return { attempted: results.some((r) => r.outcome === "ok" || r.outcome === "failed"), results };
  }

  return {
    enabled: deps.mode !== "off",
    rateInEffect,
    ratesInEffect,
    fetchMonths,
    monthsNeedingFetch,
    fetchDue,
    ensureRates,
  };
}

export type FxService = ReturnType<typeof createFxService>;

/** The service the routes use: real clock, real fetch, the source chosen by `REFUND_FX_SOURCE`. */
export const fxService: FxService = createFxService({ mode: env.REFUND_FX_SOURCE });
