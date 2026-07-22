/**
 * Refund-settings management endpoints (T3, specs/011-refund-settings,
 * plan.md § API contracts).
 *
 *   GET /settings/{key} → 200 current value + configured flag + chronological
 *                          history (also the audit view, AC-1.1/5.3)
 *   PUT /settings/{key} → 200 the post-write state (AC-1.2/1.4) — NO POST/
 *                          DELETE route exists for a setting anywhere;
 *                          append-only via PUT alone (enforced additionally
 *                          at the DB by T2's migration, AC-5.2).
 *
 * Both gated by the NEW, unconditioned `settings` catalog resource (D2,
 * ADR-0028): `settings:read` for GET, `settings:manage` for PUT. Neither is
 * entity-scoped — a missing capability is a wholesale 403/404-free denial,
 * mirroring `rates/routes.ts`'s posture (there is no "owner" of a suite-wide
 * setting). An UNKNOWN key (not in the descriptor registry, `settings/
 * registry.ts`) is a 404 on BOTH routes — checked AFTER the capability gate,
 * so a non-holder learns nothing about which keys exist (US-3, ADR-0028:
 * "a non-holder must not even learn the mailbox exists").
 *
 * Same `authzMiddleware`/`hasCapability` machinery every other refund-api
 * route uses (ADR-0014) — fails closed (503) on an `auth` outage.
 *
 * `createdByUserId`/`createdByEmail` on a PUT-appended row are ALWAYS taken
 * from the caller's verified JWT (`c.get("userId")`/`c.get("email")`), NEVER
 * the request body (Security A01/A08 — see plan.md § Security).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ProblemSchema } from "../requests/requests.schemas";
import { appendSettingEntry, listSettingHistory } from "./repo";
import { getSettingDescriptor } from "./registry";
import { currentValue, isNoOpValue, mapSettingResponse, normalizeSettingValue } from "./service";
import { PutSettingBodySchema, SettingKeyParamSchema, SettingResponseSchema } from "./schemas";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

const notFoundProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const unprocessableProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/422",
  title: "Unprocessable Entity",
  status: 422 as const,
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

// A settings body is tiny (one optional short string) — 4 KiB is generous.
const SETTINGS_BODY_SIZE_LIMIT = 4 * 1024;

// ─── Router ──────────────────────────────────────────────────────────────────

export const settingsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
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

settingsRouter.use(
  "/settings/:key",
  bodyLimit({
    maxSize: SETTINGS_BODY_SIZE_LIMIT,
    onError: (c) => c.json(payloadTooLargeProblem(c.req.path, SETTINGS_BODY_SIZE_LIMIT), 413),
  }),
);
settingsRouter.use("/settings/:key", jwtMiddleware);
settingsRouter.use("/settings/:key", authzMiddleware);

// ─── GET /settings/:key (AC-1.1, AC-5.3) ────────────────────────────────────

const getSettingRoute = createRoute({
  method: "get",
  path: "/settings/{key}",
  tags: ["Settings"],
  summary: "Get a refund setting's current value + change history",
  description:
    "Current value is derived as the latest row for this key (D1/D3, " +
    "ADR-0013/0024 lineage) — `configured:false` and `value:null` when the " +
    "key has never been set or was last explicitly cleared (AC-1.1/1.4). " +
    "`history` is chronological, oldest -> newest (AC-5.3). Gated by " +
    "`settings:read`. An unregistered `key` (settings/registry.ts) is a 404.",
  security: [{ Bearer: [] }],
  request: { params: SettingKeyParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: SettingResponseSchema } },
      description: "The setting's current value + history",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `settings:read` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Unknown setting key",
    },
  },
});

settingsRouter.openapi(getSettingRoute, async (c) => {
  const authz = c.get("authz");
  const { key } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "settings", "read")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to view refund settings"),
      403,
    );
  }

  if (!getSettingDescriptor(key)) {
    return c.json(notFoundProblem(c.req.path, `Unknown refund setting "${key}"`), 404);
  }

  const exit = await Effect.runPromiseExit(listSettingHistory(key));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund setting history");
  }

  return c.json(mapSettingResponse(key, exit.value), 200);
});

// ─── PUT /settings/:key (AC-1.2, AC-1.4, AC-5.1, AC-5.4) ───────────────────

const putSettingRoute = createRoute({
  method: "put",
  path: "/settings/{key}",
  tags: ["Settings"],
  summary: "Append a new value for a refund setting (append-only)",
  description:
    "Append-only — there is NO separate create/delete route for a setting, " +
    "ever (AC-5.2, enforced additionally at the DB by T2's migration). " +
    "`\"\"` is normalized to `null` (clear, AC-1.4) — a distinct, always-" +
    "valid transition. A non-null value is validated against the key's " +
    "registered descriptor (`settings/registry.ts`); 422 on a malformed " +
    "value (AC-1.3) — nothing is persisted, no audit row. A no-op save " +
    "(the normalized value equals the current value) is suppressed — 200, " +
    "no new row, no audit (AC-5.4). `createdByUserId`/`createdByEmail` are " +
    "ALWAYS taken from the caller's verified JWT, never the request body. " +
    "Gated by `settings:manage`. An unregistered `key` is a 404.",
  security: [{ Bearer: [] }],
  request: {
    params: SettingKeyParamSchema,
    body: { required: true, content: { "application/json": { schema: PutSettingBodySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SettingResponseSchema } },
      description: "The post-write state (or the unchanged current state on a no-op/AC-5.4)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `settings:manage` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Unknown setting key",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request body too large",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "value is not well-formed for this key — nothing persisted, no audit",
    },
  },
});

settingsRouter.openapi(putSettingRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { key } = c.req.valid("param");
  const body = c.req.valid("json");

  if (!hasCapability(authz.permissions, "settings", "manage")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to manage refund settings"),
      403,
    );
  }

  const descriptor = getSettingDescriptor(key);
  if (!descriptor) {
    return c.json(notFoundProblem(c.req.path, `Unknown refund setting "${key}"`), 404);
  }

  const normalized = normalizeSettingValue(body.value);

  if (normalized !== null) {
    const validationError = descriptor.validate(normalized);
    if (validationError) {
      return c.json(unprocessableProblem(c.req.path, validationError), 422);
    }
  }

  const historyExit = await Effect.runPromiseExit(listSettingHistory(key));
  if (historyExit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund setting history");
  }
  const history = historyExit.value;

  // AC-5.4 — a no-op save (including null === null) is suppressed: no new
  // row, no audit, still 200 with the unchanged current state.
  if (isNoOpValue(normalized, currentValue(history))) {
    return c.json(mapSettingResponse(key, history), 200);
  }

  const appendExit = await Effect.runPromiseExit(
    appendSettingEntry({
      key,
      value: normalized,
      createdByUserId: sub,
      createdByEmail: email,
    }),
  );
  if (appendExit._tag === "Failure") {
    throw new Error("Unexpected database failure appending refund setting entry");
  }

  return c.json(mapSettingResponse(key, [...history, appendExit.value]), 200);
});
