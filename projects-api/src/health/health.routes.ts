import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("projects-api"),
  version: z.string(),
  timestamp: z.string().datetime(),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description: "Liveness. The database probe joins this response with the data model (specs/021 T4).",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponseSchema } },
      description: "Service is healthy",
    },
  },
});

export const healthRouter = new OpenAPIHono();

healthRouter.openapi(healthRoute, (c) =>
  c.json(
    {
      status: "ok" as const,
      service: "projects-api" as const,
      version: process.env["npm_package_version"] ?? "0.0.0",
      timestamp: new Date().toISOString(),
    },
    200,
  ),
);
