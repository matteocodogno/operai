/**
 * Mileage-rate management endpoints (T4, specs/009-mileage-rate,
 * plan.md § API contracts, Decision 2).
 *
 *   GET  /rates   → 200 per-entity history (also the audit view, AC-4.1/5.3)
 *   POST /rates   → 201 append one entry (AC-4.2) — NO PUT/PATCH/DELETE
 *                   route exists for a rate entry anywhere (AC-4.7,
 *                   enforced additionally at the DB by T2's migration).
 *
 * Both gated by the NEW, unconditioned `rate` catalog resource (Decision 2):
 * `rate:read` for GET, `rate:manage` for POST (which implies read). Neither
 * is entity-scoped or ownership-scoped — a missing capability is a
 * wholesale 403, mirroring batches.routes.ts's `GET /batches` posture (no
 * record-level denial semantics apply here; there is no "owner" of a rate).
 * Same `authzMiddleware`/`hasCapability` machinery every other refund-api
 * route uses (ADR-0014) — fails closed (503) on an `auth` outage.
 *
 * `createdByUserId`/`createdByEmail` are ALWAYS taken from the caller's
 * verified JWT (`c.get("userId")`/`c.get("email")`), NEVER the request body
 * (Security A01/A08 — see plan.md § Security). `currency` is likewise
 * ALWAYS derived server-side from `entity` (`ENTITY_CURRENCY`), never
 * accepted from the client.
 *
 * `GET /rates/effective` (the employee-facing live-recompute read, gated by
 * `refund:access` only, NOT `rate:read`) lives in the SIBLING
 * `effective.routes.ts` — a separate router because its validation-failure
 * contract is `400` (plan.md), not this router's `422` convention; mirrors
 * the existing requestsRouter(400)/linesRouter(422) split-by-router
 * precedent in this same codebase.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ENTITY_CURRENCY, ProblemSchema } from "../requests/requests.schemas";
import { createRateEntry, listAllRateEntries } from "./repo";
import { decimalToMicros, mapRateHistoryResponse, microsToDecimalString } from "./service";
import { AddRateBodySchema, RateEntryResponseSchema, RateHistoryResponseSchema } from "./schemas";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

const payloadTooLargeProblem = (path: string, limitBytes: number) => ({
  type: "https://httpstatuses.com/413",
  title: "Payload Too Large",
  status: 413 as const,
  detail: `Request body exceeds the maximum allowed size of ${(limitBytes / 1024).toFixed(0)} KB.`,
  instance: path,
});

// A rate body is tiny (entity + a short decimal string + a date) — 4 KiB is generous.
const RATES_BODY_SIZE_LIMIT = 4 * 1024;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

// ─── Router ──────────────────────────────────────────────────────────────────

export const ratesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/422",
          title: "Unprocessable Entity",
          status: 422,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        422,
      );
    }
    return undefined;
  },
});

ratesRouter.use(
  "/rates",
  bodyLimit({
    maxSize: RATES_BODY_SIZE_LIMIT,
    onError: (c) => c.json(payloadTooLargeProblem(c.req.path, RATES_BODY_SIZE_LIMIT), 413),
  }),
);
ratesRouter.use("/rates", jwtMiddleware);
ratesRouter.use("/rates", authzMiddleware);

// ─── GET /rates (history + audit view — AC-4.1/4.3/5.3) ────────────────────

const listRatesRoute = createRoute({
  method: "get",
  path: "/rates",
  tags: ["Rates"],
  summary: "Per-entity mileage-rate history (also the rate-change audit view)",
  description:
    "Full chronological history for both entities, the entry in effect as of " +
    "today flagged per entity (AC-4.1/4.3). Doubles as the audit view " +
    "(AC-5.3) — every field AC-5.1 requires (actor, timestamp, entity, " +
    "value, validFrom) already lives on each entry. Gated by `rate:read`.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: RateHistoryResponseSchema } },
      description: "Per-entity rate history",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `rate:read` capability",
    },
  },
});

ratesRouter.openapi(listRatesRoute, async (c) => {
  const authz = c.get("authz");

  if (!hasCapability(authz.permissions, "rate", "read")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to view mileage rates"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(listAllRateEntries());
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing mileage rates");
  }

  return c.json(mapRateHistoryResponse(exit.value, todayIso()), 200);
});

// ─── POST /rates (append — AC-4.2, AC-4.5, AC-4.8) ─────────────────────────

const addRateRoute = createRoute({
  method: "post",
  path: "/rates",
  tags: ["Rates"],
  summary: "Append a new mileage-rate entry for one entity",
  description:
    "Append-only — there is NO PUT/PATCH/DELETE route for a rate entry, " +
    "ever (AC-4.7). `validFrom` may be past, present, or future (AC-4.8). " +
    "`currency` is ALWAYS derived server-side from `entity`; " +
    "`createdByUserId`/`createdByEmail` are ALWAYS taken from the caller's " +
    "verified JWT, never the request body. 422 on a non-positive value or " +
    "an invalid/missing `validFrom` (AC-4.5) — nothing is persisted. Gated " +
    "by `rate:manage`.",
  security: [{ Bearer: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: AddRateBodySchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RateEntryResponseSchema } },
      description: "The created rate entry",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `rate:manage` capability",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request body too large",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Non-positive value or invalid/missing validFrom — nothing persisted",
    },
  },
});

ratesRouter.openapi(addRateRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const body = c.req.valid("json");

  if (!hasCapability(authz.permissions, "rate", "manage")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to manage mileage rates"),
      403,
    );
  }

  const currency = ENTITY_CURRENCY[body.entity];
  const ratePerKmMicros = decimalToMicros(body.ratePerKm);

  const exit = await Effect.runPromiseExit(
    createRateEntry({
      entity: body.entity,
      currency,
      ratePerKmMicros,
      validFrom: body.validFrom,
      createdByUserId: sub,
      createdByEmail: email,
    }),
  );
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure creating mileage rate entry");
  }

  const created = exit.value;
  // A freshly-created entry is "in effect today" iff its own validFrom is
  // <= today AND nothing newer already supersedes it for today — recompute
  // against the FULL history rather than assuming true, so a backdated add
  // (AC-4.8) never over-claims current effect.
  const historyExit = await Effect.runPromiseExit(listAllRateEntries());
  const inEffectToday =
    historyExit._tag === "Success"
      ? mapRateHistoryResponse(historyExit.value, todayIso()).entities.some(
          (e) => e.currentEntryId === created.id,
        )
      : false;

  return c.json(
    {
      id: created.id,
      ratePerKmMicros: created.ratePerKmMicros,
      ratePerKm: microsToDecimalString(created.ratePerKmMicros),
      validFrom: created.validFrom,
      createdAt: created.createdAt.toISOString(),
      createdByEmail: created.createdByEmail,
      inEffectToday,
    },
    201,
  );
});
