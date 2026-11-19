/**
 * Exchange-rate endpoints (T10, specs/20261118-refund-accounting-export, plan
 * § API contracts "Exchange rates"; AC-5.2 to AC-5.7).
 *
 *   GET /exchange-rates?from&to              settings:read
 *   POST /exchange-rates/fetch               settings:manage
 *   PUT /exchange-rates/{month}/{currency}   settings:manage
 *
 * Rates live behind the settings capabilities, not behind `request:review`
 * (G5): an accounting user who is not an admin sees the missing-rate blocker of
 * an export and is told to ask an administrator.
 *
 * - A source failure is NOT an HTTP error on `POST /fetch`: it answers 200 with
 *   the attempt's outcome `failed` (AC-5.6). The rates stay as they were.
 * - There is no `sourceDiscrepancy` field anywhere (G8); discrepancies live in
 *   the attempt log only.
 * - A correction wins over any fetched value and leaves the fetched value in
 *   the history (AC-5.3). A correction that equals the rate in effect writes no
 *   row. The rate is `0 < rate < 1000` with at most six decimals (IS-6): the
 *   column is a 32-bit integer of micros, and 1000 is also the parser's bound.
 * - The capability is checked in a middleware BEFORE the body is validated.
 *
 * `createFxRouter` takes the service and the clock, so tests inject a fake
 * source. (`index.ts` no longer mounts it: T23, specs/20261119-accounting.)
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import {
  appendCorrection,
  dateToMonth,
  effectiveEntry,
  latestFetchAttempt,
  listEntries,
  monthsWithEntries,
  type RateCurrency,
  type RateEntry,
} from "./fx.repo";
import type { FxService } from "./fx.service";
import {
  FetchRatesBodySchema,
  FetchRatesResponseSchema,
  FxProblemSchema,
  ListRatesQuerySchema,
  ListRatesResponseSchema,
  MonthRowSchema,
  PutRateBodySchema,
  RatePathParamSchema,
  type MonthRow,
  type RateView,
} from "./fx.schemas";
import { displayWindow, isMonthKey, lastCompletedMonth } from "./months";
import { FX_CURRENCIES } from "./parse";

const BODY_SIZE_LIMIT = 4 * 1024;

const problem = <S extends number>(status: S, title: string, path: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
  ...(code !== undefined ? { code } : {}),
});

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
  return {
    status: current.origin,
    rateMicros: current.rateMicros,
    rate: formatRate(current.rateMicros),
    ...(current.origin === "fetched"
      ? { fetchedAt: (current.fetchedAt ?? current.createdAt).toISOString(), ...(current.sourceUrl ? { sourceUrl: current.sourceUrl } : {}) }
      : { correctedAt: current.createdAt.toISOString(), correctedByEmail: current.createdByEmail }),
    history: entries.map((e) => ({
      origin: e.origin,
      rate: formatRate(e.rateMicros),
      at: e.createdAt.toISOString(),
      byEmail: e.createdByEmail,
    })),
  };
}

function monthRows(months: readonly string[], entries: readonly RateEntry[]): MonthRow[] {
  return months.map((month) => {
    const pick = (currency: RateCurrency) => rateView(entries.filter((e) => e.month === month && e.currency === currency));
    return { month, rates: { EUR: pick("EUR"), USD: pick("USD"), GBP: pick("GBP") } };
  });
}

async function lastFetch() {
  const attempt = await latestFetchAttempt(db);
  return attempt
    ? { at: attempt.createdAt.toISOString(), outcome: attempt.outcome, errorCode: attempt.errorCode, month: attempt.month }
    : null;
}

/** The months a non-CHF WellD CH line of an approved or paid request needs a rate for, plus every month that already has an entry. */
async function neededMonths(): Promise<string[]> {
  const lines = await db.refundLine.findMany({
    where: {
      entity: "welld_ch",
      currency: { not: "CHF" },
      rejectionReason: null,
      request: { status: { in: ["approved", "paid"] } },
    },
    distinct: ["date"],
    select: { date: true },
  });
  return [...new Set([...lines.map((l) => dateToMonth(l.date)), ...(await monthsWithEntries(db))])];
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createFxRouter(service: FxService, now: () => Date = () => new Date()) {
  const router = new OpenAPIHono<{ Variables: AuthzVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          problem(
            422,
            "Unprocessable Entity",
            c.req.path,
            result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
            c.req.method === "PUT" ? "invalid_rate" : "invalid_request",
          ),
          422,
        );
      }
      return undefined;
    },
  });

  router.use(
    "/exchange-rates/*",
    bodyLimit({
      maxSize: BODY_SIZE_LIMIT,
      onError: (c) => c.json(problem(413, "Payload Too Large", c.req.path, "Request body is too large."), 413),
    }),
    jwtMiddleware,
    authzMiddleware,
    createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
      const need = c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "manage";
      if (!hasCapability(c.get("authz").permissions, "settings", need)) {
        return c.json(
          problem(
            403,
            "Forbidden",
            c.req.path,
            need === "read"
              ? "You do not have permission to view the exchange rates"
              : "You do not have permission to manage the exchange rates",
          ),
          403,
        );
      }
      await next();
      return undefined;
    }),
  );

  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    content: { "application/json": { schema } },
    description,
  });
  const problemResponse = (description: string) => json(FxProblemSchema, description);

  // ── GET /exchange-rates ────────────────────────────────────────────────────

  const listRoute = createRoute({
    method: "get",
    path: "/exchange-rates",
    tags: ["Exchange rates"],
    summary: "The monthly average rates, newest month first, with where each came from",
    description:
      "Default window: every completed month from 2026-01 (Europe/Zurich), plus any earlier completed month a non-CHF " +
      "WellD CH line needs. `from` and `to` narrow it. Each rate is `fetched`, `corrected` or `missing` (AC-5.2, AC-5.5), " +
      "with its whole history. `fetchDue` is true when a fetch could record something (AC-5.1).",
    security: [{ Bearer: [] }],
    request: { query: ListRatesQuerySchema },
    responses: {
      200: json(ListRatesResponseSchema, "The rates"),
      403: problemResponse("Caller lacks `settings:read` (AC-5.7)"),
    },
  });

  router.openapi(listRoute, async (c) => {
    const { from, to } = c.req.valid("query");
    let months = displayWindow(now(), await neededMonths());
    if (from) months = months.filter((m) => m >= from);
    if (to) months = months.filter((m) => m <= to);
    const entries = await listEntries(db, months);
    return c.json(
      { months: monthRows(months, entries), lastFetch: await lastFetch(), fetchDue: await service.fetchDue() },
      200,
    );
  });

  // ── POST /exchange-rates/fetch ─────────────────────────────────────────────

  const fetchRoute = createRoute({
    method: "post",
    path: "/exchange-rates/fetch",
    tags: ["Exchange rates"],
    summary: "Fetch the monthly rates from the federal source now",
    description:
      "Body optional: `{ months?: [\"2026-10\"], trigger?: \"admin\" | \"settings_view\" }`. Without `months`, every fetchable " +
      "month missing a rate. A source failure is a 200 whose attempt says `failed`, with the rates untouched (AC-5.6). A month " +
      "asked again within 15 minutes is `throttled` and writes nothing. At most six months per call; the rest are `deferredMonths`.",
    security: [{ Bearer: [] }],
    responses: {
      200: json(FetchRatesResponseSchema, "One attempt per month asked"),
      403: problemResponse("Caller lacks `settings:manage` (AC-5.7)"),
      422: problemResponse("Malformed body"),
    },
  });

  router.openapi(fetchRoute, async (c) => {
    // The body is optional, so it is read by hand: an empty body is `{}`, which a JSON validator would refuse.
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(problem(422, "Unprocessable Entity", c.req.path, "The body is not valid JSON", "invalid_request"), 422);
      }
    }
    const parsed = FetchRatesBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        problem(422, "Unprocessable Entity", c.req.path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_request"),
        422,
      );
    }
    const months = parsed.data.months ?? (await service.monthsNeedingFetch());
    const { results, deferred } = await service.fetchMonths(months, parsed.data.trigger ?? "admin", { userId: c.get("userId") });
    return c.json(
      {
        attempts: results.map((r) => ({ month: r.month, outcome: r.outcome, errorCode: r.errorCode, recorded: r.recorded })),
        deferredMonths: [...deferred],
        lastFetch: await lastFetch(),
      },
      200,
    );
  });

  // ── PUT /exchange-rates/{month}/{currency} ─────────────────────────────────

  const putRoute = createRoute({
    method: "put",
    path: "/exchange-rates/{month}/{currency}",
    tags: ["Exchange rates"],
    summary: "Correct a month's rate (an admin's entry; the fetched value stays in the history)",
    description:
      "`rate` is CHF per 1 unit, `0 < rate < 1000`, at most six decimals. Only a completed month. A rate equal to the one in " +
      "effect writes nothing. The correction applies to every export from now on (AC-5.3).",
    security: [{ Bearer: [] }],
    request: {
      params: RatePathParamSchema,
      body: { required: true, content: { "application/json": { schema: PutRateBodySchema } } },
    },
    responses: {
      200: json(MonthRowSchema, "The month's row"),
      403: problemResponse("Caller lacks `settings:manage` (AC-5.7)"),
      404: problemResponse("Not a currency with a rate"),
      422: problemResponse("`invalid_rate` | `currency_not_convertible` | `month_not_completed` | `invalid_month`"),
    },
  });

  router.openapi(putRoute, async (c) => {
    const { month, currency } = c.req.valid("param");
    const { rate } = c.req.valid("json");
    const upper = currency.toUpperCase();
    if (upper === "CHF") {
      return c.json(problem(422, "Unprocessable Entity", c.req.path, "CHF is the reporting currency and has no rate", "currency_not_convertible"), 422);
    }
    if (!(FX_CURRENCIES as readonly string[]).includes(upper)) {
      return c.json(problem(404, "Not Found", c.req.path, `${currency} has no exchange rate`), 404);
    }
    if (!isMonthKey(month)) {
      return c.json(problem(422, "Unprocessable Entity", c.req.path, "month must be YYYY-MM", "invalid_month"), 422);
    }
    if (month > lastCompletedMonth(now())) {
      return c.json(problem(422, "Unprocessable Entity", c.req.path, `${month} is not completed yet`, "month_not_completed"), 422);
    }
    const micros = parseRateMicros(rate);
    if (micros === null) {
      return c.json(problem(422, "Unprocessable Entity", c.req.path, "rate must be greater than 0 and less than 1000", "invalid_rate"), 422);
    }
    await appendCorrection({
      currency: upper as RateCurrency,
      month,
      rateMicros: micros,
      actor: { userId: c.get("userId"), email: c.get("email") },
    });
    return c.json(monthRows([month], await listEntries(db, [month]))[0]!, 200);
  });

  return router;
}

// T23 (specs/20261119-accounting): the mounted `fxRouter` singleton is gone, nothing in refund-api serves exchange rates any more.
// `createFxRouter` moves to accounting-api in T12.
