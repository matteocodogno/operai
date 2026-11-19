/**
 * Exchange-rate user routes (T12, specs/20261119-accounting, plan § API contracts, G5; moved from refund-api's
 * `src/fx/fx.routes.ts`, where they served WellD CH under `settings:*`; AC-2.3 to AC-2.5, AC-2.7 to AC-2.9, AC-2.11,
 * AC-3.4, AC-3.5):
 *
 *   GET /v1/entities/{entity}/exchange-rates?from&to              read
 *   POST /v1/entities/{entity}/exchange-rates/fetch               manage   { months? }
 *   PUT /v1/entities/{entity}/exchange-rates/{month}/{currency}   manage   { rate }
 *
 * Authorization is `requireEntityAccess` (T6) in a middleware BEFORE the body is read, as for the catalog: no grant ->
 * 403 `accounting_forbidden`, an entity outside the caller's read coverage -> 404 `not_found`, a write without manage ->
 * 403 `accounting_manage_required`, and a refused request writes and logs nothing (AC-3.4, AC-2.9).
 *
 * - The list is the window of `displayWindow` (2026-01 to the last completed month, plus an earlier month that has an
 *   entry or an attempt, AC-2.3), newest first, with one rate per currency of the entity: `{ status: "missing" }`, or
 *   `{ status: "fetched" | "corrected", rateMicros, rate }`, nothing else (D18, G13). An entity with no source (WellD
 *   Italia, D19) answers `source: null`, `currencies: []`, no months and `fetchDue: false`; a fetch for it is 422
 *   `no_rate_source` with nothing attempted (AC-2.11). `lastFetch` is the newest attempt that asked the source, read by
 *   a reader as by a manager (AC-2.8).
 * - A source failure is NOT an HTTP error on `POST /fetch`: it answers 200 with the attempt's outcome `failed` and the
 *   rates untouched. The response keeps the 20261118 shape (G5): `attempts[{ month, outcome, errorCode, recorded }]`,
 *   `deferredMonths`, `lastFetch`. The trigger of the attempt is `manager` and nothing the caller sends can change that:
 *   the body is STRICT, so a `trigger` (or any other member) is a 422 `invalid_request` and no attempt is written.
 * - A correction wins over any fetched value and leaves the fetched value in the history. The rate is `0 < rate < 1000`
 *   with at most six decimals (the column is an integer of micros below 1e9); the month must be completed; the currency
 *   must be one the entity converts, so the entity's own currency (and, for an entity with no source, every currency)
 *   is 422 `currency_not_convertible`. A correction equal to the rate in effect writes no row and still answers 200 with
 *   the month row, so the answer has ONE shape (accounting-ui reads a 204 as "no row" and a body as the row; both
 *   work, the body is the one that needs no second read).
 *
 * `createRatesRouter` takes the service and the clock, so tests inject a fake source; `index.ts` builds the one service
 * of the process and gives it to this router and to the system rates route (single flight is per service instance).
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../authz/authz.middleware";
import { requireEntityAccess } from "../authz/coverage";
import { OWN_CURRENCY, RATE_SOURCE, type Entity } from "../entities";
import { db } from "../lib/db";
import { ProblemError, validationHook } from "../lib/problem";
import { displayWindow, isMonthKey, lastCompletedMonth } from "./months";
import {
  appendCorrection,
  effectiveEntry,
  latestFetchAttempt,
  listEntries,
  monthsWithAttempts,
  monthsWithEntries,
  type RateCurrency,
  type RateEntry,
} from "./rates.repo";
import {
  FetchRatesBodySchema,
  FetchRatesResponseSchema,
  isRateMonth,
  ListRatesQuerySchema,
  ListRatesResponseSchema,
  MonthRowSchema,
  PutRateBodySchema,
  PutRateParamsSchema,
  EntityRatesParamsSchema,
  RatesProblemSchema,
  type LastFetchView,
  type MonthRow,
  type RateView,
} from "./rates.schemas";
import { currenciesOf, NoRateSourceError, type RatesService } from "./rates.service";

type RatesVariables = AuthzVariables & { entity: Entity };

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** 924600 -> `"0.9246"`; 1063500 -> `"1.0635"`; up to six decimals, trailing zeros trimmed to at least four. */
export function formatRate(rateMicros: number): string {
  const whole = Math.floor(rateMicros / 1_000_000);
  let fraction = String(rateMicros % 1_000_000).padStart(6, "0");
  while (fraction.length > 4 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

/** `"0.9246"` -> 924600, exact. `null` when the text is not in `RATE_RE`'s shape or is not 0 < rate < 1000. */
export function parseRateMicros(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  return micros > 0 && micros < 1_000_000_000 ? micros : null;
}

function rateView(entries: readonly RateEntry[]): RateView {
  const current = effectiveEntry(entries);
  if (current === null) return { status: "missing" };
  return { status: current.origin, rateMicros: current.rateMicros, rate: formatRate(current.rateMicros) };
}

function monthRows(entity: Entity, months: readonly string[], entries: readonly RateEntry[]): MonthRow[] {
  const currencies = currenciesOf(entity);
  return months.map((month) => ({
    month,
    rates: Object.fromEntries(
      currencies.map((currency) => [
        currency,
        rateView(entries.filter((e) => e.month === month && e.currency === currency)),
      ]),
    ),
  }));
}

async function lastFetchOf(entity: Entity): Promise<LastFetchView> {
  const attempt = await latestFetchAttempt(db, entity);
  return attempt
    ? { at: attempt.createdAt.toISOString(), outcome: attempt.outcome, errorCode: attempt.errorCode, month: attempt.month }
    : null;
}

const noRateSource = (): ProblemError =>
  new ProblemError({
    status: 422,
    code: "no_rate_source",
    detail: "This entity has no official exchange-rate source, so no rates can be fetched",
  });

const invalid = (code: string, detail: string): ProblemError => new ProblemError({ status: 422, code, detail });

// ─── Router ──────────────────────────────────────────────────────────────────

export function createRatesRouter(service: RatesService, now: () => Date = () => new Date()) {
  const router = new OpenAPIHono<{ Variables: RatesVariables }>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      // A correction whose body is not `{ rate: "<text>" }` is an invalid rate, like any other refused value.
      if (c.req.method === "PUT" && result.target === "json") {
        return invalid("invalid_rate", "rate must be greater than 0 and less than 1000, with at most six decimals").toResponse(c.req.path);
      }
      return validationHook(result, c);
    },
  });

  // Only these paths: a router mounted at "/" must not put a login in front of an unknown URL's 404.
  const gate = createMiddleware<{ Variables: RatesVariables }>(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      c.set("entity", requireEntityAccess(c, c.req.param("entity") ?? "", "read"));
    } else if (method === "POST" || method === "PUT") {
      c.set("entity", requireEntityAccess(c, c.req.param("entity") ?? "", "manage"));
    }
    await next();
  });
  router.use("/v1/entities/:entity/exchange-rates", jwtMiddleware, authzMiddleware, gate);
  router.use("/v1/entities/:entity/exchange-rates/*", jwtMiddleware, authzMiddleware, gate);

  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    content: { "application/json": { schema } },
    description,
  });
  const problemResponse = (description: string) => json(RatesProblemSchema, description);

  const COMMON_REFUSALS = {
    401: problemResponse("No valid token"),
    403: problemResponse("`accounting_forbidden` (no read for any entity) or `accounting_manage_required` (a write without manage)"),
    404: problemResponse("`not_found`: the entity does not exist or is outside the caller's coverage"),
    503: problemResponse("The authorization service is unavailable (fail closed)"),
  } as const;

  // ── GET /v1/entities/{entity}/exchange-rates ───────────────────────────────

  const listRoute = createRoute({
    method: "get",
    path: "/v1/entities/{entity}/exchange-rates",
    tags: ["Exchange rates"],
    summary: "The monthly average rates of an entity, newest month first, with where each came from",
    description:
      "Default window: every completed month from 2026-01 (Europe/Zurich), plus any earlier month that has an entry or " +
      "an attempt (AC-2.3). `from` and `to` narrow it. Each rate is `fetched`, `corrected` or `missing` (AC-2.7). " +
      "`lastFetch` is the newest attempt that asked the source (AC-2.8). `fetchDue` is true when a fetch could record " +
      "something. An entity with no source answers `source: null` and `currencies: []` (AC-2.11).",
    security: [{ Bearer: [] }],
    request: { params: EntityRatesParamsSchema, query: ListRatesQuerySchema },
    responses: { 200: json(ListRatesResponseSchema, "The rates"), ...COMMON_REFUSALS },
  });

  router.openapi(listRoute, async (c) => {
    const entity = c.get("entity");
    const { from, to } = c.req.valid("query");
    const source = RATE_SOURCE[entity];
    const currencies = [...currenciesOf(entity)];
    const base = { entity, ownCurrency: OWN_CURRENCY[entity], currencies, source: source === null ? null : { name: source.name } };
    if (source === null) return c.json({ ...base, months: [], lastFetch: null, fetchDue: false }, 200);

    const needed = [...(await monthsWithEntries(db, entity)), ...(await monthsWithAttempts(db, entity))].filter(isRateMonth);
    let months = displayWindow(now(), needed);
    if (from) months = months.filter((m) => m >= from);
    if (to) months = months.filter((m) => m <= to);
    const entries = await listEntries(db, entity, months);
    return c.json(
      {
        ...base,
        months: monthRows(entity, months, entries),
        lastFetch: await lastFetchOf(entity),
        fetchDue: await service.fetchDue(entity),
      },
      200,
    );
  });

  // ── POST /v1/entities/{entity}/exchange-rates/fetch ────────────────────────

  const fetchRoute = createRoute({
    method: "post",
    path: "/v1/entities/{entity}/exchange-rates/fetch",
    tags: ["Exchange rates"],
    summary: "Fetch the monthly rates of an entity from its official source now",
    description:
      "Body optional: `{ months?: [\"2026-10\"] }`, and nothing else (a `trigger` is refused: the server derives who asks). " +
      "Without `months`, every fetchable month missing a rate. A source failure is a 200 whose attempt says `failed`, with " +
      "the rates untouched (AC-2.8). A month asked again within 15 minutes is `throttled` and writes nothing. At most six " +
      "months per call, newest first; the rest are `deferredMonths` (AC-2.9). An entity with no source is 422 `no_rate_source`.",
    security: [{ Bearer: [] }],
    request: { params: EntityRatesParamsSchema },
    responses: {
      200: json(FetchRatesResponseSchema, "One attempt per month asked"),
      422: problemResponse("`no_rate_source` (nothing attempted) or `invalid_request` (a malformed body)"),
      ...COMMON_REFUSALS,
    },
  });

  router.openapi(fetchRoute, async (c) => {
    const entity = c.get("entity");
    // The body is optional, so it is read by hand: an empty body is `{}`, which a JSON validator would refuse.
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw invalid("invalid_request", "The body is not valid JSON");
      }
    }
    const parsed = FetchRatesBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw invalid("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    if (RATE_SOURCE[entity] === null) throw noRateSource();

    try {
      const months = parsed.data.months ?? (await service.monthsNeedingFetch(entity));
      const { results, deferred } = await service.fetchMonths(entity, months, "manager", { userId: c.get("userId") });
      return c.json(
        {
          attempts: results.map((r) => ({ month: r.month, outcome: r.outcome, errorCode: r.errorCode, recorded: r.recorded })),
          deferredMonths: [...deferred],
          lastFetch: await lastFetchOf(entity),
        },
        200,
      );
    } catch (error) {
      if (error instanceof NoRateSourceError) throw noRateSource();
      throw error;
    }
  });

  // ── PUT /v1/entities/{entity}/exchange-rates/{month}/{currency} ────────────

  const putRoute = createRoute({
    method: "put",
    path: "/v1/entities/{entity}/exchange-rates/{month}/{currency}",
    tags: ["Exchange rates"],
    summary: "Correct a month's rate (a manager's entry; the fetched value stays in the history)",
    description:
      "`rate` is the own currency for 1 unit, `0 < rate < 1000`, at most six decimals (AC-2.5). Only a completed month, " +
      "and only a currency the entity converts. A rate equal to the one in effect writes nothing and answers the month " +
      "row all the same. The correction applies from now on (AC-2.4).",
    security: [{ Bearer: [] }],
    request: {
      params: PutRateParamsSchema,
      body: { required: true, content: { "application/json": { schema: PutRateBodySchema } } },
    },
    responses: {
      200: json(MonthRowSchema, "The month's row, with the rate now in effect"),
      422: problemResponse("`invalid_rate` | `month_not_completed` | `currency_not_convertible` | `invalid_month`: nothing recorded"),
      ...COMMON_REFUSALS,
    },
  });

  router.openapi(putRoute, async (c) => {
    const entity = c.get("entity");
    const { month, currency } = c.req.valid("param");
    const { rate } = c.req.valid("json");

    if (!isMonthKey(month) || !isRateMonth(month)) throw invalid("invalid_month", "month must be YYYY-MM, from 2000-01");
    const upper = currency.toUpperCase();
    const convertible = currenciesOf(entity) as readonly string[];
    if (!convertible.includes(upper)) {
      throw invalid("currency_not_convertible", "This currency has no exchange rate for this entity");
    }
    if (month > lastCompletedMonth(now())) throw invalid("month_not_completed", `${month} is not completed yet`);
    const micros = parseRateMicros(rate);
    if (micros === null) throw invalid("invalid_rate", "rate must be greater than 0 and less than 1000, with at most six decimals");

    await appendCorrection(entity, {
      currency: upper as RateCurrency,
      month,
      rateMicros: micros,
      actor: { userId: c.get("userId"), email: c.get("email") },
    });
    const [row] = monthRows(entity, [month], await listEntries(db, entity, [month]));
    return c.json(row!, 200);
  });

  return router;
}
