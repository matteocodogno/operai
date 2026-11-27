/**
 * GET /push/config, PUT|GET /push/devices, DELETE /push/devices/{id}
 * (T5, specs/20261111-push-notifications, plan.md §API contracts, ADR 20261111-web-push-encrypted-payloads-not-fcm).
 *
 * User-JWT routes (jwtMiddleware, aud=AUTH_AUDIENCE), scoped exclusively to the verified
 * `sub`: the owner is never read from a path, query or body. A service JWT therefore
 * cannot reach them (wrong audience), and nothing here touches /system/*.
 *
 * SECURITY / PRIVACY:
 *  - `endpoint`, `p256dh` and `auth` are subscription secrets: never in a response, a
 *    log line or an error detail. Failures throw a generic Error WITHOUT the cause,
 *    because a driver error can quote the failing statement's arguments.
 *  - SSRF: notify-api POSTs to the registered endpoint, so PUT checks the host against
 *    the single `PUSH_ENDPOINT_HOSTS` allowlist (push/pushEndpoint.ts), the same one the
 *    sender re-checks.
 *  - Someone else's device id is a 404 identical to an unknown id (ADR 20260703-jwt-resource-server-remote-jwks).
 *
 * Only PUT is gated by PUSH_ENABLED (503 push_disabled, before body validation): GET and
 * DELETE keep working while push is off so a user can always see and remove what is stored.
 */

import { unexpectedDbFailure } from "@/lib/dbFailure";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { env } from "@/lib/env";
import { problem } from "@/notifications/notifications.schemas";
import {
  DeviceIdParamSchema,
  PushConfigResponseSchema,
  PushDeviceListSchema,
  PushDeviceSchema,
  PushProblemSchema,
  RegisterDeviceSchema,
} from "./devices.schemas";
import { MAX_DEVICES_PER_USER, deleteByIdForUser, listByUser, upsertByEndpoint, type PushDeviceRow } from "./devices.repo";
import { deviceLabel } from "./deviceLabel";
import { isAllowedPushEndpoint } from "./pushEndpoint";

const BODY_SIZE_LIMIT = 8 * 1024; // 8 KiB (plan.md §API contracts)

/** Problem JSON plus the `code` extension member. */
const coded = (status: number, title: string, code: string, detail: string, instance: string) => ({
  ...problem(status, title, detail, instance),
  code,
});

const toDto = (d: PushDeviceRow) => ({ id: d.id, label: d.label, createdAt: d.createdAt.toISOString() });

export const pushDevicesRouter = new OpenAPIHono<{ Variables: JwtVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      // Field names only: never the offending value (it may be a subscription secret).
      const fields = [...new Set(result.error.issues.map((i) => i.path.map(String).join(".") || "body"))].join(", ");
      return c.json(coded(400, "Bad Request", "invalid_body", `Invalid request body: ${fields}`, c.req.path), 400);
    }
    return undefined;
  },
});

// A body that is not JSON at all is rejected by Hono's validator with an HTTPException
// before zod runs; give it the same shape. Anything else is left to the app's handler.
pushDevicesRouter.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json(coded(400, "Bad Request", "invalid_body", "Malformed request body", c.req.path), 400);
  }
  throw err;
});

// Every middleware below is scoped to ONE exact path — NEVER `.use("*", …)`. index.ts
// merges every router into one flat route table, so a "*" here would gate the whole app
// (GET /notifications/stream must stay Bearer-less, ADR 20260713-sse-stream-auth-short-lived-ticket; /system/* takes a service
// JWT only). See list.routes.ts and stream.routes.ts for the precedent.
pushDevicesRouter.use("/push/config", jwtMiddleware);
pushDevicesRouter.use(
  "/push/devices",
  bodyLimit({
    maxSize: BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        problem(413, "Payload Too Large", `Request body exceeds the maximum allowed size of ${BODY_SIZE_LIMIT / 1024} KB.`, c.req.path),
        413,
      ),
  }),
);
pushDevicesRouter.use("/push/devices", jwtMiddleware);
pushDevicesRouter.use("/push/devices/:id", jwtMiddleware);

// PUT only: 503 while push is off, after authentication and before body validation.
pushDevicesRouter.use(
  "/push/devices",
  createMiddleware<{ Variables: JwtVariables }>(async (c, next) => {
    if (c.req.method === "PUT" && !env.PUSH_ENABLED) {
      return c.json(coded(503, "Service Unavailable", "push_disabled", "Push notifications are not enabled", c.req.path), 503);
    }
    return next();
  }),
);

const problemResponse = (description: string) => ({
  content: { "application/json": { schema: PushProblemSchema } },
  description,
});

// ─── GET /push/config ────────────────────────────────────────────────────────

const configRoute = createRoute({
  method: "get",
  path: "/push/config",
  tags: ["Push"],
  summary: "Whether web push is on, and the VAPID public key to subscribe with",
  description:
    "{ enabled: false } while PUSH_ENABLED is off (the client then hides its push section). " +
    "The VAPID public key is public by design; the private key never leaves the service.",
  responses: {
    200: { content: { "application/json": { schema: PushConfigResponseSchema } }, description: "Push configuration (AC-1.2, AC-6.1)" },
    401: problemResponse("Missing or invalid Bearer JWT"),
  },
});

pushDevicesRouter.openapi(configRoute, (c) => {
  if (env.PUSH_ENABLED && env.VAPID_PUBLIC_KEY) {
    return c.json({ enabled: true as const, vapidPublicKey: env.VAPID_PUBLIC_KEY }, 200);
  }
  return c.json({ enabled: false as const }, 200);
});

// ─── PUT /push/devices ───────────────────────────────────────────────────────

const registerRoute = createRoute({
  method: "put",
  path: "/push/devices",
  tags: ["Push"],
  summary: "Register this browser's push subscription (idempotent by endpoint)",
  description:
    "Owner is the JWT sub. 201 for a new subscription; 200 when the endpoint was already registered " +
    "(keys replaced; if another account held it, the row moves to the caller, AC-5.3). " +
    "The response never contains the endpoint or keys.",
  request: { body: { required: true, content: { "application/json": { schema: RegisterDeviceSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: PushDeviceSchema } }, description: "Already registered; updated" },
    201: { content: { "application/json": { schema: PushDeviceSchema } }, description: "Registered (AC-1.2)" },
    400: problemResponse("invalid_body: missing field, endpoint over 2000 characters, or keys not base64url of the RFC lengths"),
    401: problemResponse("Missing or invalid Bearer JWT"),
    409: problemResponse("device_limit: the caller already has 20 devices and this endpoint is new"),
    413: problemResponse("Body over 8 KiB"),
    422: problemResponse("endpoint_not_allowed: not https, or not a supported push service host"),
    503: problemResponse("push_disabled: PUSH_ENABLED is off (AC-6.1)"),
  },
});

pushDevicesRouter.openapi(registerRoute, async (c) => {
  const userId = c.get("userId");
  const { endpoint, keys } = c.req.valid("json");

  if (!isAllowedPushEndpoint(endpoint)) {
    return c.json(
      coded(422, "Unprocessable Entity", "endpoint_not_allowed", "The push endpoint is not a supported push service", c.req.path),
      422,
    );
  }

  const exit = await Effect.runPromiseExit(
    upsertByEndpoint({
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      label: deviceLabel(c.req.header("user-agent")),
    }),
  );
  if (exit._tag === "Failure") throw unexpectedDbFailure("Unexpected database failure registering a push device", exit.cause);

  // The cap is decided inside the repository's transaction (atomic, S-M2); "limit" wrote nothing.
  const result = exit.value;
  if (result.outcome === "limit") {
    return c.json(
      coded(409, "Conflict", "device_limit", `At most ${MAX_DEVICES_PER_USER} devices per account`, c.req.path),
      409,
    );
  }
  return c.json(toDto(result.device), result.outcome === "created" ? 201 : 200);
});

// ─── GET /push/devices ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/push/devices",
  tags: ["Push"],
  summary: "List the caller's push devices",
  description: "The caller's devices only, newest first. Endpoint and keys are never returned (AC-3.1, AC-3.3).",
  responses: {
    200: { content: { "application/json": { schema: PushDeviceListSchema } }, description: "Devices" },
    401: problemResponse("Missing or invalid Bearer JWT"),
  },
});

pushDevicesRouter.openapi(listRoute, async (c) => {
  const exit = await Effect.runPromiseExit(listByUser(c.get("userId")));
  if (exit._tag === "Failure") throw unexpectedDbFailure("Unexpected database failure listing push devices", exit.cause);
  return c.json({ items: exit.value.map(toDto) }, 200);
});

// ─── DELETE /push/devices/{id} ───────────────────────────────────────────────

const deleteRoute = createRoute({
  method: "delete",
  path: "/push/devices/{id}",
  tags: ["Push"],
  summary: "Remove one of the caller's push devices",
  description: "404 when the id does not exist OR belongs to another user, with an identical body (ADR 20260703-jwt-resource-server-remote-jwks).",
  request: { params: DeviceIdParamSchema },
  responses: {
    204: { description: "Deleted (AC-1.5, AC-3.2)" },
    401: problemResponse("Missing or invalid Bearer JWT"),
    404: problemResponse("Unknown id, or not the caller's"),
  },
});

pushDevicesRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const exit = await Effect.runPromiseExit(deleteByIdForUser(id, c.get("userId")));
  if (exit._tag === "Failure") {
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    if (error?._tag === "NotFoundError") {
      return c.json(problem(404, "Not Found", "Push device not found", c.req.path), 404);
    }
    throw unexpectedDbFailure("Unexpected database failure deleting a push device", exit.cause);
  }
  return c.body(null, 204);
});
