import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect, Exit } from "effect";
import { isJwksReady } from "@/auth/jwt.middleware";
import { eventBus } from "@/notifications/eventBus";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";

// jwks/sse are informational (ops visibility, plan.md §API contracts) — they do
// NOT gate the 200/503 status code, which remains driven by DB connectivity
// only (unchanged from T1's contract). A cold-start JWKS (not yet fetched — it
// fetches lazily on the first verification attempt, not at process start) is
// expected immediately after deploy and is not itself an outage.
const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("notify-api"),
  version: z.string(),
  timestamp: z.string().datetime(),
  db: z.object({
    status: z.enum(["ok", "error"]),
  }),
  jwks: z.object({
    status: z.enum(["ok", "not-ready"]),
  }),
  sse: z.object({
    activeConnections: z.number().int().nonnegative(),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description:
    "Returns service health including database connectivity, JWKS-verifier readiness " +
    "(ADR-0005 cold-start note), and the active SSE connection count (ops visibility, " +
    "plan.md §API contracts). Returns 503 when Prisma cannot reach PostgreSQL.",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponseSchema } },
      description: "Service is healthy",
    },
    503: {
      content: { "application/json": { schema: HealthResponseSchema } },
      description: "Service is degraded",
    },
  },
});

const pingDb = Effect.tryPromise({
  try: () => db.$queryRaw`SELECT 1`,
  catch: (cause) => new DatabaseError({ message: "DB ping failed", cause }),
});

export const healthRouter = new OpenAPIHono();

healthRouter.openapi(healthRoute, async (c) => {
  const exit = await Effect.runPromiseExit(pingDb);
  const dbOk = Exit.isSuccess(exit);

  const body = {
    status: dbOk ? ("ok" as const) : ("degraded" as const),
    service: "notify-api" as const,
    version: process.env["npm_package_version"] ?? "0.0.0",
    timestamp: new Date().toISOString(),
    db: { status: dbOk ? ("ok" as const) : ("error" as const) },
    jwks: { status: isJwksReady() ? ("ok" as const) : ("not-ready" as const) },
    sse: { activeConnections: eventBus.connectionCount() },
  };

  return c.json(body, dbOk ? 200 : 503);
});
