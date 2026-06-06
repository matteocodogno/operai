import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect, Exit } from "effect";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";

const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("auth"),
  version: z.string(),
  timestamp: z.string().datetime(),
  db: z.object({
    status: z.enum(["ok", "error"]),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description:
    "Returns service health including database connectivity. Returns 503 when Prisma cannot reach PostgreSQL.",
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
    service: "auth" as const,
    version: process.env["npm_package_version"] ?? "0.0.0",
    timestamp: new Date().toISOString(),
    db: { status: dbOk ? ("ok" as const) : ("error" as const) },
  };

  return c.json(body, dbOk ? 200 : 503);
});
