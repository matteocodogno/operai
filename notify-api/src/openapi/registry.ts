import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Notify API",
      version: "0.1.0",
      description:
        "Notification center API for the Operai suite. " +
        "Persists and pushes per-user notifications raised by other Operai tools. " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8081", description: "Local development" },
      { url: "https://notify-api.operai.welld.io", description: "Production" },
    ],
    tags: [
      {
        name: "Notifications",
        description:
          "Notification raise/list/read/stream — persistence and real-time push for the notification center. " +
          "All endpoints except GET /notifications/stream are behind jwtMiddleware (RS256 Bearer JWT).",
      },
      {
        name: "System",
        description: "Health checks and service metadata",
      },
    ],
  });

  // Scalar UI at /docs
  app.get(
    "/docs",
    apiReference({
      spec: { url: "/openapi.json" },
      theme: "purple",
      layout: "modern",
    }),
  );
}
