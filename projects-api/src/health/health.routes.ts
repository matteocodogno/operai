import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { db } from "../lib/db";

const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("projects-api"),
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
  description: "Returns service health including database connectivity. Returns 503 when Prisma cannot reach PostgreSQL.",
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

/** The dependency probes, a plain object so a test can replace one (the Prisma client is a Proxy and ignores spies). */
export const probes = {
  db: async (): Promise<void> => {
    await db.$queryRaw`SELECT 1`;
  },
};

async function dbReachable(): Promise<boolean> {
  try {
    await probes.db();
    return true;
  } catch {
    return false;
  }
}

export const healthRouter = new OpenAPIHono();

healthRouter.openapi(healthRoute, async (c) => {
  const dbOk = await dbReachable();
  const body = {
    status: dbOk ? ("ok" as const) : ("degraded" as const),
    service: "projects-api" as const,
    version: process.env["npm_package_version"] ?? "0.0.0",
    timestamp: new Date().toISOString(),
    db: { status: dbOk ? ("ok" as const) : ("error" as const) },
  };
  return c.json(body, dbOk ? 200 : 503);
});
