/**
 * GET /system/v1/entities/{entity}/rates?pairs=EUR:2026-03,USD:2026-11 (T13, specs/20261119-accounting, plan § API contracts
 * "system routes", D4, G10; AC-2.10, AC-3.8): the rate in effect of each asked (currency, month), for a suite service
 * (Refund) that needs it to convert a line, and its fetch on the consumer's behalf when the month is published and has none.
 *
 * `pairs` is 1 to 36 DISTINCT `CCC:YYYY-MM`, upper-case currency, month 2000-01 or later; a request that is not that is 400
 * `invalid_pairs` and nothing is read or fetched. A well-formed pair whose currency the entity does not convert (the own
 * currency, or any currency of an entity with no source) is 422 `currency_not_convertible`, for the whole request. An entity
 * that does not exist is 404 `not_found`; the entity comes first, then the pairs.
 *
 * The answer is `rates.service`'s `consumerRates`: each pair once, in the asked order, `in_effect` (with `rateMicros`, the
 * `origin`, and `attempted`) or `missing` (with the `reason` and `attempted`). A missing rate whose month is published is
 * fetched FIRST, under the consumer budget of 6 s, at most six months, throttled and single-flight (AC-2.10), with the
 * service principal's `sub` as the attempt's actor and the trigger `consumer`, which the SERVER sets here and no query or
 * body can: the trigger is derived from how the caller authenticated (ADR 20261119-on-demand-outbound-work-...). The caller's
 * own user needs no Accounting capability: the credential is the service's.
 *
 * The answer is validated with `accountingWire` before it is sent. The one thing the route writes is what the fetch records;
 * it takes no body, and no other method has a route (404). Every answer carries `Cache-Control: no-store`.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SystemAuthVariables } from "../auth/systemAuth.middleware";
import { entityNotFound } from "../authz/coverage";
import { isEntity } from "../entities";
import { ProblemError } from "../lib/problem";
import { isMonthKey } from "../rates/months";
import { isRateMonth } from "../rates/rates.schemas";
import { currenciesOf, type RatePair, type RatesService } from "../rates/rates.service";
import { ratesWire, WIRE_RATE_PAIRS_MAX } from "./accountingWire";
import { noStore, systemReader } from "./readers";

const PAIR = /^([A-Z]{3}):(\d{4}-\d{2})$/;
/** `EUR:2026-03` is 11 characters; 36 of them and 35 commas are the longest request that can be valid. */
const MAX_PAIRS_LENGTH = WIRE_RATE_PAIRS_MAX * 11 + (WIRE_RATE_PAIRS_MAX - 1);

export type ParsedPairs = { readonly ok: true; readonly pairs: readonly { currency: string; month: string }[] } | { readonly ok: false };

/** The `pairs` query values (as the framework read them) as pairs; `ok: false` for anything that is not 1..36 distinct well-formed pairs. */
export function parsePairs(values: readonly string[] | undefined): ParsedPairs {
  if (values === undefined || values.length !== 1) return { ok: false };
  const raw = values[0]!;
  if (raw.length === 0 || raw.length > MAX_PAIRS_LENGTH) return { ok: false };
  const parts = raw.split(",");
  if (parts.length > WIRE_RATE_PAIRS_MAX) return { ok: false };
  const pairs: { currency: string; month: string }[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const match = PAIR.exec(part);
    if (match === null) return { ok: false };
    const [, currency, month] = match as unknown as [string, string, string];
    if (!isMonthKey(month) || !isRateMonth(month) || seen.has(part)) return { ok: false };
    seen.add(part);
    pairs.push({ currency, month });
  }
  return { ok: true, pairs };
}

const invalidPairs = (): ProblemError =>
  new ProblemError({
    status: 400,
    code: "invalid_pairs",
    detail: `pairs must be 1 to ${WIRE_RATE_PAIRS_MAX} distinct CCC:YYYY-MM, from 2000-01`,
  });

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

const route = createRoute({
  method: "get",
  path: "/system/v1/entities/{entity}/rates",
  tags: ["System"],
  summary: "The rate in effect of each asked currency and month, fetched first when it is missing and published",
  description:
    "Service credential only: scope `accounting.reference.read`, `sub` `system:refund-api`. `pairs` is 1 to 36 distinct " +
    "`CCC:YYYY-MM` (for example `EUR:2026-03,USD:2026-11`), months from 2000-01. Each pair is answered once, in the asked " +
    "order. A missing rate of a published month is fetched first (at most six months, 6 s, throttled, trigger `consumer`). " +
    "`attempted` says this call asked the source for the pair's month. Never cached.",
  security: [{ ServiceBearer: [] }],
  middleware: [noStore, systemReader] as const,
  request: {
    params: z.object({ entity: z.string() }),
    // Read by hand (`parsePairs`): a missing, repeated or malformed `pairs` is a 400 in this route's own words, not a framework 422.
    query: z.object({ pairs: z.string().optional().describe("1 to 36 distinct `CCC:YYYY-MM`, comma-separated") }),
  },
  responses: {
    200: { content: { "application/json": { schema: ratesWire } }, description: "Each pair once, in the asked order" },
    400: { content: { "application/json": { schema: ProblemSchema } }, description: "`invalid_pairs`: missing, repeated or malformed `pairs`" },
    401: { content: { "application/json": { schema: ProblemSchema } }, description: "No valid service credential (one body for every cause)" },
    404: { content: { "application/json": { schema: ProblemSchema } }, description: "`not_found`: the entity does not exist" },
    422: { content: { "application/json": { schema: ProblemSchema } }, description: "`currency_not_convertible`: a currency the entity does not convert" },
  },
});

/** `service` is the process's one rates service, shared with the user routes (single flight is per instance). */
export function createSystemRatesRouter(service: RatesService) {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
    // A `pairs` the framework itself refuses (repeated: a list is not a string) is the same 400 as one `parsePairs` refuses.
    defaultHook: (result, c) =>
      result.success ? undefined : invalidPairs().toResponse(c.req.path),
  });

  router.openapi(route, async (c) => {
    const { entity } = c.req.valid("param");
    if (!isEntity(entity)) throw entityNotFound();

    const parsed = parsePairs(c.req.queries("pairs"));
    if (!parsed.ok) throw invalidPairs();
    const convertible = currenciesOf(entity) as readonly string[];
    if (parsed.pairs.some((pair) => !convertible.includes(pair.currency))) {
      throw new ProblemError({
        status: 422,
        code: "currency_not_convertible",
        detail: "A currency asked has no exchange rate for this entity",
      });
    }

    const rates = await service.consumerRates(entity, parsed.pairs as readonly RatePair[], { userId: c.get("serviceSub") });
    return c.json(ratesWire.parse({ entity, rates }), 200);
  });

  return router;
}
