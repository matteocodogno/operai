/**
 * `GET /rates/effective` — the employee-facing live-recompute read (T4,
 * specs/009-mileage-rate, AC-1.2/1.3, AC-2.1, AC-2.2).
 *
 * A SEPARATE router from `routes.ts` (registered as its own
 * `app.route("/", ...)` in src/index.ts, mirrors the requestsRouter(400)/
 * linesRouter(422) split already established in this codebase) because its
 * validation-failure contract is `400` on a bad entity/date (plan.md § API
 * contracts), not `routes.ts`'s `422` convention for the management writes.
 *
 * Gated by `refund:access` ONLY — deliberately NOT `rate:read` (Decision 2):
 * this exposes only non-sensitive policy data the employee already sees as
 * `km x rate` while drafting (no history, no actor identity, no createdBy —
 * see the response shape below), so any authenticated refund user can
 * resolve the rate without holding the admin `rate:*` capability.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ENTITY_CURRENCY, ProblemSchema } from "../requests/requests.schemas";
import { fetchEffectiveRate } from "./repo";
import { microsToDecimalString } from "./service";
import { EffectiveRateQuerySchema, EffectiveRateResponseSchema } from "./schemas";

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

export const rateEffectiveRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

rateEffectiveRouter.use("/rates/effective", jwtMiddleware);
rateEffectiveRouter.use("/rates/effective", authzMiddleware);

const effectiveRoute = createRoute({
  method: "get",
  path: "/rates/effective",
  tags: ["Rates"],
  summary: "Resolve the mileage rate in effect for one (entity, date)",
  description:
    "For the drafting client's live recompute (AC-1.2/1.3/2.1). Gated by " +
    "`refund:access` only — exposes just the effective per-km rate for the " +
    "chosen (entity, date), nothing more (no history, no actor identity). " +
    "`inEffect: false` (AC-2.2) when no rate entry qualifies for that pair. " +
    "400 on a bad/missing entity or date.",
  security: [{ Bearer: [] }],
  request: { query: EffectiveRateQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: EffectiveRateResponseSchema } },
      description: "The effective rate, or inEffect:false",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "entity/date missing or malformed",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `refund:access` capability",
    },
  },
});

rateEffectiveRouter.openapi(effectiveRoute, async (c) => {
  const authz = c.get("authz");
  const { entity, date } = c.req.valid("query");

  if (!hasCapability(authz.permissions, "refund", "access")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to access the refund tool"),
      403,
    );
  }

  const currency = ENTITY_CURRENCY[entity];

  const exit = await Effect.runPromiseExit(fetchEffectiveRate(entity, date));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure resolving the effective mileage rate");
  }

  const rate = exit.value;
  if (!rate) {
    return c.json({ entity, date, currency, inEffect: false }, 200);
  }

  return c.json(
    {
      entity,
      date,
      currency,
      inEffect: true,
      ratePerKmMicros: rate.ratePerKmMicros,
      ratePerKm: microsToDecimalString(rate.ratePerKmMicros),
      validFrom: rate.validFrom,
    },
    200,
  );
});
